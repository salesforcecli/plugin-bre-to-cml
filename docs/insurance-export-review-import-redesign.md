# BRE-to-CML: Export-Only → Review → Gated-Import Redesign (FINAL)

> Architecture design produced by a distinguished-architect workflow (parallel code exploration →
> architect blueprint → 3-lens adversarial review → revision). All claims verified against the
> current `fix/insurance-surcharge-merge-hardening` tree.

## Implementation status

Sections are marked **[implemented]** or **[pending]** inline. As of the `insurance import record-updates`
change:

- **Implemented:** file-only convert and the class-(b)/(c) update files (§3); the unified
  `sf insurance import record-updates` command with the gate, `--dry-run`, `--no-prompt`, per-record
  re-read, identity verification, skip-if-already-current, surcharge RuleKey verification, and
  partial-failure handling (§4, §5, §7 steps 1, 5-11, 13); the `--update-records` tripwire (§6).
- **Pending:** the `as-expression-set` read/apply split and its gate, guards, unresolved-FK block,
  and PATCH-last reordering (§5, §7 steps 2, 12, 14). `as-expression-set` still applies its writes
  immediately with no preview or confirmation.

## 1. Goals & Non-Goals

### Goals

- Make `sf cml convert ...` (underwriting, surcharge) **strictly file-only**. No org mutation, ever.
- Emit the org-record changes that `updateOrgRecords()` currently applies live as **reviewable/correctable files** in two new artifact classes.
- Add a **WARNING + CONFIRMATION gate** to every org-mutating import path, enumerating exact changes before applying, with safe `--json`/non-TTY behavior, a `--dry-run`, and a `--no-prompt` automation bypass.
- Preserve and extend idempotency (associations de-dupe today; add record-update + ESCDCD de-dupe).
- **Preserve byte-for-byte behavioral parity** between what convert used to write live and what it now serializes, then applies — especially the UW `DynamicRuleDefinition` rewrite and the surcharge rule-key semantics.

### Non-Goals

- No change to CML generation, the merge engine (`insurance-cml-merge.ts`), rule-key derivation, or `prod-cfg-rules.ts` (no `--update-records` path; out of scope, but its shared message bundle is touched — §7 step 11).
- No change to the associations CSV format or the core `as-expression-set` upload mechanics beyond the gate, the mandatory read/apply split, idempotency guards, and missing-precondition guards.
- No new SOQL-injection surface: reuse `validateAssociationNames` / `isSafeAssociationReferenceValue` (`insurance-rule-convert-command.ts:246-269`); only Id values (regex-validated) are ever interpolated into the new re-read SOQL.

### The three export artifact classes

| Class                | File(s)                                                                        | Produced by                                | Applied by                                               |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| (a) CML              | `<safeApi>.cml`, `<safeApi>_Associations.csv`, `<safeApi>_RuleKeyMapping.json` | convert [implemented]                      | `sf cml import as-expression-set` (gate still [pending]) |
| (b) UW update        | `<safeApi>_UnderwritingUpdate.json`                                            | `convert underwriting-rules` [implemented] | `sf insurance import record-updates` [implemented]       |
| (c) Surcharge update | `<safeApi>_SurchargeUpdate.json`                                               | `convert surcharge-rules` [implemented]    | `sf insurance import record-updates` [implemented]       |

### Where org mutation is removed

- `insurance-rule-convert-command.ts:116-118` (build path, underwriting) — remove the `if (ctx.updateRecords) await this.updateOrgRecords(...)` call; replace with `writeRecordUpdateFile(...)` (unconditional, see §3).
- `surcharge-rules.ts:132-134` (merge path) — same.
- The `abstract updateOrgRecords(records, ruleKeyMapping, conn)` (`insurance-rule-convert-command.ts:323`) is **replaced** by `abstract buildRecordUpdatePlan(records, ruleKeyMapping): RecordUpdatePlan` — pure, no `conn`, no writes. The live `conn.sobject(...).update(...)` calls move into the new `record-updates` import command.
- **`Connection` import in the base STAYS.** It is still used by `loadRecords` (`:174`), `resolveProductCodes` (`:203`), `discoverCmlApi` (`:271`), and `runMergeConvert` (`:128`). Only the `updateOrgRecords(conn)` abstract signature is removed.

---

## 2. Command Surface

### `sf cml convert underwriting-rules` (changed)

File-only. Produces `<safeApi>.cml`, `<safeApi>_Associations.csv`, `<safeApi>_RuleKeyMapping.json`, **and always `<safeApi>_UnderwritingUpdate.json`** (class b). No org writes.

### `sf cml convert surcharge-rules` (changed)

File-only. Produces `<safeApi>.cml`, `<safeApi>_Associations.csv` (header-only), `<safeApi>_RuleKeyMapping.json`, **and always `<safeApi>_SurchargeUpdate.json`** (class c). No org writes.

### `sf cml import as-expression-set` (changed) — [pending]

Same upload mechanics, but refactored into a **read-only plan phase** then a **mutating apply phase**, with the gate, `--no-prompt`, `--dry-run`, idempotency guards, and missing-precondition guards (§4, §5, §8). Not yet done: the command still writes without a preview or confirmation.

### `sf insurance import record-updates` — [implemented]

Consumes a class-(b) or class-(c) file and applies `UnderwritingRuleGroup` + `UnderwritingRule`, or `ProductSurcharge`, updates. Same gate / `--no-prompt` / `--dry-run`. It replaced the interim `scripts/apply-surcharge-update.sh` helper, which has been deleted.

```
sf insurance import record-updates --file <plan.json> --target-org <org> [--dry-run] [--no-prompt] [--api-version <value>]
```

**Decision: ONE unified `record-updates` importer, not per-class.** Both update files share one envelope; the apply loop is "for each sObject group: re-read current state, skip already-current, `conn.sobject(type).update(...)`". Per-class differences (field sets, the UW blob rewrite, the surcharge RuleKey verification) are data-driven from the file plus a small per-`kind` strategy. CML import stays separate because its mechanics (base64 PATCH, FK resolution, ContextDefinition) are unrelated to plain record updates.

New command file: `src/commands/insurance/import/record-updates.ts`, id `insurance import record-updates`. oclif discovers the command by file path, but the topic still needs a description, so `package.json` declares an `insurance` topic with an `import` subtopic alongside the existing `cml`/`cml.convert`/`cml.import` entries. README/manifest regeneration is handled in §7 step 16.

---

## 3. On-Disk File Formats (classes b & c)

Both files are pretty (2-space) JSON sharing one envelope. JSON over CSV because the UW `DynamicRuleDefinition` payload is itself a nested JSON blob that must be hand-correctable. Naming follows the existing `<safeApi>_*` convention; no collision with `.cml` / `_Associations.csv` / `_RuleKeyMapping.json` / prod-cfg `_<index>_*`.

### Shared envelope (add to `src/shared/insurance/models.ts`)

```ts
export type RecordUpdateField = {
  field: string; // sObject field API name to set, e.g. 'RuleEngineType' or 'DynamicRuleDefinition'
  value: string; // value to write (JSON blobs are stringified verbatim)
};

export type RecordUpdate = {
  sobject: 'UnderwritingRuleGroup' | 'UnderwritingRule' | 'ProductSurcharge';
  id: string; // 15/18-char Salesforce Id (validated on apply)
  name: string; // record Name — REQUIRED. Used as a verification key on apply (§5), not cosmetic.
  fields: RecordUpdateField[];
  // Surcharge only: the convert-computed pathed rule key the CML rule was emitted under.
  // Advisory + a verification key on apply (§5). NOT written to the org (the platform
  // auto-generates ProductSurcharge.RuleKey when RuleEngineType flips).
  expectedRuleKey?: string;
};

export type RecordUpdatePlan = {
  schemaVersion: 1;
  kind: 'underwriting-update' | 'surcharge-update';
  cmlApi: string; // raw api (matches the .cml / RuleKeyMapping for traceability)
  generatedAt: string; // ISO timestamp, advisory (drift detection aid)
  // Surcharge only: source ProductCodes per surcharge id at convert time, so a reviewer/apply
  // can detect ProductCode/ProductPath drift that would desync the platform RuleKey (§5, §8).
  updates: RecordUpdate[];
};
```

**`currentValue` is intentionally NOT in the file.** (Resolves compat-scope blocker.) Convert cannot populate it: the surcharge SOQL (`surcharge-rules.ts:64`) selects only `Id, Name, RuleDefinition, ProductPath` — never `RuleEngineType`; surcharge `updateOrgRecords` ignores `_records` entirely and builds from `ruleKeyMapping`; and the UW group `RuleEngineType` is never queried (`underwriting-rules.ts:59`). The displayed "old" value in the warning table comes exclusively from a **fresh org re-read at apply time** (§4, §5), which is also the authoritative source for the skip-if-already-current check. Adding new SOQL field reads just to populate a convert-time `currentValue` would be dead weight and would still be stale by apply time.

### (b) `<safeApi>_UnderwritingUpdate.json` — example

The `DynamicRuleDefinition` value is the **already-rewritten** JSON string, produced by reusing the EXACT live rewrite (`underwriting-rules.ts:146-152`): parse the **raw** `record.DynamicRuleDefinition` (NO `decodeHtmlEntities` — matching the live path, which does not decode before writing), set `ruleKey`, and set `underwritingRuleGroup.ruleEngineType='ConstraintEngine'` **only if `underwritingRuleGroup` already exists as an object** (never create it).

The example below shows the no-`underwritingRuleGroup` case correctly — `underwritingRuleGroup` is NOT synthesized:

```json
{
  "schemaVersion": 1,
  "kind": "underwriting-update",
  "cmlApi": "UW_AUTO_HOME",
  "generatedAt": "2026-06-28T12:00:00.000Z",
  "updates": [
    {
      "sobject": "UnderwritingRuleGroup",
      "id": "0RG000000000001AAA",
      "name": "Auto Eligibility Group",
      "fields": [{ "field": "RuleEngineType", "value": "ConstraintEngine" }]
    },
    {
      "sobject": "UnderwritingRule",
      "id": "0UR000000000001AAA",
      "name": "Min Driver Age",
      "fields": [
        { "field": "DynamicRuleDefinition", "value": "{\"name\":\"Min Driver Age\",\"ruleKey\":\"UW_AUTO_001\"}" }
      ]
    }
  ]
}
```

A record whose blob _does_ contain `underwritingRuleGroup` would instead serialize `...,"underwritingRuleGroup":{...,"ruleEngineType":"ConstraintEngine"}}`.

**UW data-source rules (must match live behavior exactly):**

- `UnderwritingRuleGroup` updates: emitted for the **union of `UnderwritingRuleGroupId` across ALL input `records`** (`underwriting-rules.ts:104-110`), NOT just the converted/`ruleKeyMapping` subset — so a group whose rules were all already-keyed/skipped is still flipped.
- `UnderwritingRule` updates: emitted **only for `records.filter(r => !r.RuleKey && r.DynamicRuleDefinition)`** (`:128`), joined to `ruleKeyMapping` by `record.Id` for the `ruleKey`. A record with a non-null `RuleKey` gets NO `DynamicRuleDefinition` update.

### (c) `<safeApi>_SurchargeUpdate.json` — example

Surcharge writes ONLY `RuleEngineType` (matching `surcharge-rules.ts:166-171`). It additionally records `expectedRuleKey` (the convert-computed pathed key) and source `ProductCodes` so the silent-non-fire hazard is visible and verifiable.

```json
{
  "schemaVersion": 1,
  "kind": "surcharge-update",
  "cmlApi": "SC_AUTO_HOME",
  "generatedAt": "2026-06-28T12:00:00.000Z",
  "updates": [
    {
      "sobject": "ProductSurcharge",
      "id": "0PS000000000001AAA",
      "name": "Young Driver Surcharge",
      "expectedRuleKey": "SC_AUTO_HOME_YOUNGDRIVER",
      "fields": [{ "field": "RuleEngineType", "value": "ConstraintEngine" }]
    }
  ]
}
```

**Surcharge data-source rule (must match live behavior exactly):** `ProductSurcharge` updates derive **only from `ruleKeyMapping`** (placements, `surcharge-rules.ts:126-130`), NEVER from the full `records[]`. A surcharge skipped by the merge (collision / no type block) has no `ruleKeyMapping` entry and MUST NOT appear in the file — flipping a skipped surcharge to `ConstraintEngine` would activate a rule that was never placed in the CML and silently never fire. `expectedRuleKey` = `p.rule.ruleKey`.

### Human-reviewability / correctability

- Reviewers are expected to edit `fields[].value` (e.g. fix a hand-corrected `DynamicRuleDefinition`), or delete whole `updates[]` entries to skip a record.
- `id`, `sobject`, `field`, `name` are structural; editing is allowed but apply re-validates AND cross-checks `name` against the org (§5). `expectedRuleKey`, `generatedAt`, `ProductCodes` are advisory verification aids.
- Empty `updates: []` is valid → no-op apply (logged, no prompt, exit 0).

### Always written (total invariant — resolves correctness blocker)

The "zero source records" early return (`insurance-rule-convert-command.ts:91-94`) currently writes **nothing**. To make the file's presence a reliable downstream contract, the update file is written on EVERY non-error convert run, **including the zero-source-records case** (then `updates: []`). The `.cml`/CSV/mapping are still skipped on zero source records (no model to write), but the update file is always emitted so `import record-updates --file <safeApi>_…Update.json` always resolves rather than tripping `--file exists:true`. Downstream can therefore rely on presence; "nothing to do" is uniformly represented as `updates: []`, never as a missing file.

---

## 4. WARNING + CONFIRMATION Gate (shared by both import commands)

Implemented once in `src/shared/insurance/confirm-org-changes.ts` (rendering lives alongside it in `src/shared/insurance/planned-change.ts` — both live in the insurance layer rather than a generic `shared/import` area, since insurance is the only consumer today). Wired into `record-updates` [implemented]; wiring it into `as-expression-set` is still [pending].

### New flags (both import commands)

```ts
'no-prompt': Flags.boolean({ summary: messages.getMessage('flags.no-prompt.summary'), char: 'p', default: false }),
'dry-run':   Flags.boolean({ summary: messages.getMessage('flags.dry-run.summary'), default: false }),
```

### Mandatory read-then-apply structure

Both commands MUST compute the **entire** `PlannedChange[]` from **read-only** operations BEFORE any mutation, prompt, then apply. **No `conn.create` / `conn.requestPatch` / `conn.sobject().update()` may execute before `confirmOrThrow` returns `true`** (or before a `--dry-run` early return). For `record-updates` this is the per-record re-read (§5). For `as-expression-set` this is the full `planAsExpressionSet` read phase (§5).

### What is enumerated (built entirely from a fresh org re-read in THIS invocation)

Build `PlannedChange[]`, then render:

1. `this.styledHeader(messages.getMessage('warn.header'))` — `These changes will be applied to <username>` (auto-suppressed under `--json`).
2. `this.table({ data, columns })` (`@oclif/table`) with columns: `Operation` (`Create` / `Update` / `Reuse` / `Create (UNRESOLVED FK)` / `Skip (already current)`), `Object`, `Id` (`—` for creates), `Name`, `Field`, `Change` (`old → new`, truncated). The **`old` value is always the fresh re-read value**, never a convert-time snapshot. One row per field-level change.
   - For `as-expression-set`: ExpressionSet (Create/Reuse via `findOne({ApiName})`), ExpressionSetDefinitionContextDefinition (Create/Reuse via the new existence check), ExpressionSetDefinitionVersion `ConstraintModel` (Update — see content signal below), and N association rows (Create/Reuse via the `:198-206` filter, plus `Create (UNRESOLVED FK)` for rows whose resolved `ReferenceObjectId` is falsy or `'unexpected'`, §8).
   - **ConstraintModel PATCH content signal (resolves safety-ux blocker):** because the value is opaque base64, the `Change` cell for the ESDV row shows `bytes A→B`, `sha256 A→B` (over the base64-decoded existing org `ConstraintModel` and the new CML), and a `rule-count Δ` — so the most destructive write is reviewable rather than an opaque blob swap.
3. `this.warn(messages.getMessage('warn.summary', [creates, updates, reuses, skips, username]))` plus the explicit non-transactional notice: `Changes are applied in order and are NOT rolled back; a mid-apply failure can leave the org partially migrated.` Both go to stderr and into the `--json` `warnings` array.
4. The structured `PlannedChange[]` is returned in the command's JSON result under `plannedChanges`, so `--json` consumers get full fidelity even with the table suppressed.

### `--dry-run`

After building and rendering `PlannedChange[]`, if `flags['dry-run']` is set: return `{ plannedChanges, dryRun: true }` (and the human table/summary) and exit 0 **without any write and without prompting**. This lets CI review the plan in one stage and apply in a gated next stage. Recommended pairing: `--dry-run` in a review stage, `--no-prompt` in the apply stage.

### Confirmation matrix (decisive)

```ts
const interactive = process.stdout.isTTY && process.stdin.isTTY && !this.jsonEnabled();
if (flags['dry-run']) {
  /* already returned above */
} else if (flags['no-prompt']) {
  this.warn(messages.getMessage('warn.skippingPrompt')); // proceeding without confirmation
} else if (!interactive) {
  this.error(messages.createError('error.confirmationRequired')); // hard fail-fast (has .actions)
} else {
  const proceed = await this.confirm({
    message: messages.getMessage('confirm.apply'),
    defaultAnswer: false,
    ms: 30_000,
  });
  if (!proceed) this.error(messages.createError('error.aborted'));
}
```

- **On "no":** `error.aborted` — non-zero exit, no writes.
- **No-TTY / `--json` / CI without `--no-prompt`:** hard error `error.confirmationRequired` with `.actions` text `Run again with --no-prompt to apply without confirmation (consider --dry-run first), or run interactively.` We detect non-interactive **up front** and fail fast. Rationale (precise): `this.confirm` does not throw on timeout — it returns `defaultAnswer` (`false`) after `ms`; in CI that means a 30s stall then a silent abort that's easily mistaken for a hang, so we never enter the prompt non-interactively.
- **`--no-prompt`:** skip prompt, apply directly (automation; pairs with `--json` and a prior `--dry-run`).

---

## 5. Idempotency, Verification, Partial-Failure, Re-Run Semantics (apply)

### `as-expression-set` — read phase `planAsExpressionSet(conn, cmlApi, contextName, workspaceDir)`

Performs ALL read-only work and returns the resolved `PlannedChange[]` plus the data the apply phase needs (resolved ids/maps). In order, before any mutation or prompt:

1. Resolve + read the CML file (`fs.readFile`); on ENOENT → `error.cmlNotFound` (resolved path).
2. `ContextDefinition.findOne({DeveloperName})`; if missing → existing context error.
3. `ExpressionSet.findOne({ApiName})` → Create-vs-Reuse.
4. `ExpressionSetDefinition.findOne({DeveloperName})`; **if `Id` undefined → `error.missingEsd`** (`ExpressionSetDefinition <cml-api> not found`) before anything uses it.
5. `ExpressionSetDefinitionVersion.findOne({ExpressionSetDefinitionId})`; **if `Id` undefined → `error.missingEsdVersion`** (never PATCH `/ExpressionSetDefinitionVersion/undefined`).
6. Read the existing org `ConstraintModel` (base64) for the version → compute the content signal (§4.2).
7. Resolve association FKs (Product2 / ProductClassification / ProductRelatedComponent) and run the `escos` query; classify each association as Create / Reuse (`:198-206`) / `Create (UNRESOLVED FK)` (falsy or `'unexpected'` `ReferenceObjectId`).
8. `ExpressionSetDefinitionContextDefinition.findOne({ExpressionSetDefinitionId, ContextDefinitionId})` → Create-vs-Reuse (fixes the unconditional create at `:103-105`). Only reached after step 4's guard.

If any unresolved-FK rows exist, render them as `Create (UNRESOLVED FK)` and **block with `error.unresolvedAssociation`** (listing offending `ConstraintModelTag`s) before the prompt, unless the operator passes an explicit `--allow-unresolved-associations` escape hatch (then they become loud warnings, preserving today's "insert anyway" behavior for the rare intentional case).

### `as-expression-set` — apply phase (only after confirm / non-`--dry-run`)

**Write order is reordered so the activating write is LAST** (resolves correctness + safety-ux blockers):

1. `ExpressionSet.create` if absent.
2. `ExpressionSetDefinitionContextDefinition.create` if absent (idempotent via step 8 above).
3. `ExpressionSetConstraintObj.create` for the de-duped association set.
4. **LAST:** `requestPatch` the `ConstraintModel` (the activating write).

Rationale: if a write fails partway, the model is NOT yet patched/active, so the org is left **inactive rather than active-but-unassociated** (no silently-wrong runtime state). Collect per-step results; on any failure, `this.error` with an actionable message naming what succeeded, what failed, and the exact idempotent re-run command. Re-running is safe: ExpressionSet/ESCDCD/ESCO are create-if-absent, and the final PATCH is naturally idempotent.

### `record-updates` — per `RecordUpdate`

1. Re-query current org values for the target ids/fields plus `Name` (and, for UW rules, the `apiName` inside the current blob): `SELECT Id, Name, <fields> FROM <sobject> WHERE Id IN ('<id>', ...)`. Ids are regex-validated (§8) before interpolation; no free-text (`name`, `value`) is ever interpolated.
2. **Identity verification (resolves correctness major):** assert the re-read `Name` equals the file's `name`. For UW `DynamicRuleDefinition` updates, also assert the org blob's `apiName` matches the file blob's `apiName`. On mismatch → **hard per-record error** `error.recordIdentityMismatch` (`record <id> is named <orgName> in the org but the file expected <fileName> — refusing to write to a possibly-wrong record`). This catches a reviewer editing an `id` to a valid-but-wrong record of the same type.
3. **Skip-if-already-current (field-type-aware — resolves correctness + safety-ux blockers):**
   - Scalar fields (`RuleEngineType`): raw string compare.
   - `DynamicRuleDefinition`: **structural compare** — `JSON.parse` both sides and deep-equal compare only the fields convert mutates (`ruleKey` and, when present, `underwritingRuleGroup.ruleEngineType`); ignore key order / whitespace / re-serialization so a re-run after the org normalizes the blob does not spuriously rewrite, and a reviewer's cosmetic reformat is not treated as a change.
   - Each skip is **itemized** (id, field, reason) in the summary and under `--json` `skipped[]`, distinguishing "org already matches" from "your edit matched current and changed nothing".
4. **Surcharge RuleKey verification (resolves the headline correctness blocker):** `expectedRuleKey` is NOT written. After flipping `RuleEngineType` (when not skipped), re-query `ProductSurcharge.RuleKey`; if it differs from `expectedRuleKey`, OR `expectedRuleKey` is not present as a rule in the imported CML's active `ConstraintModel`, emit a **loud non-fatal warning** `surcharge <name> RuleKey <actual> does not match the converted CML rule key <expected>; the surcharge will not fire`. The plan's `generatedAt` + source `ProductCodes` let a reviewer detect the T0/T1 drift (convert computes the pathed key from ProductCode at T0; the platform regenerates `RuleKey` from the _current_ ProductCode/ProductPath when `RuleEngineType` flips at T1 — if either changed in between, the keys silently diverge).
5. Group remaining updates by sObject and call `conn.sobject(type).update(payloads)`. **UW ordering:** `UnderwritingRuleGroup` before `UnderwritingRule` (preserves `underwriting-rules.ts:111-125` then `:159-169`).
6. **Partial failure (no rollback, matches today):** collect `{id, success, errors}`; `this.warn` each failure; final summary `Updated X, skipped Y (already current), failed Z`. If `Z > 0`, after the loop `this.error` with an actionable message naming the partial state and the idempotent re-run command (`the org is partially migrated; re-run: sf insurance import record-updates --file <same file> --target-org <org>`). Successful writes are not rolled back; re-run is safe because step 3 skips already-applied records. JSON result: `{ applied, skipped: [{id, field, reason}], failed: [{id, errors}] }`.

### Required import ordering (document prominently)

Run `sf cml import as-expression-set` (activate the CML) **before** `sf insurance import record-updates` for surcharge, so the RuleKey verification in step 4 can check the expected key against the live `ConstraintModel`. Surface this in both commands' examples and in the convert "Next steps".

---

## 6. Backward Compatibility & Migration

### `--update-records`: **hard error, repointed (resolves safety-ux minor).**

A warn-and-succeed no-op would let existing CI go green while silently NOT mutating the org — the exact silent-wrong-outcome class commit `ec7e10e` set out to kill, just relocated, and missed precisely by automated callers. Instead:

- Keep the flag DEFINED on the base (`:70-73`) so it parses (no "unknown flag" crash).
- When passed, **`this.error(messages.createError('error.updateRecordsRemoved'))`** with `.actions`: `convert no longer writes to the org. It now always emits <safeApi>_{Underwriting,Surcharge}Update.json. Apply it with: sf insurance import record-updates --file <path> --target-org <org>.` A non-zero exit is the only signal an automated caller reliably notices.
- Emit this from a **single shared spot guaranteed to run on both paths** — at the top of `runConvert` right after deriving `ctx`, **before** the `mergeWithOrg` branch at `:102` (surcharge short-circuits into `runMergeConvert` and never reaches `:116`, so a `:116`-only check would miss surcharge users).
- Convert still always emits the update file regardless (the file is the replacement workflow); the flag is purely a tripwire now.
- Under `--json`, also include a machine-readable `deprecations`/error payload.

### Breaking changes (call out in release notes + examples)

1. **Convert never writes to the org.** `convert --update-records` now hard-errors with migration guidance; consumers must run `sf insurance import record-updates`.
2. **`import as-expression-set` now requires confirmation.** Non-interactive/CI callers will **error** unless they add `--no-prompt` (ideally after a `--dry-run` review stage). Breaking for automation — document prominently.
3. `updateOrgRecords` → `buildRecordUpdatePlan` (internal; out-of-tree subclasses would break).

`prod-cfg-rules.ts` has no `--update-records` / record mutation and is unaffected, but its shared message bundle is touched (§7 step 11) — verify no wording regresses.

---

## 7. File-by-File Change Plan

**Build/commit order note:** message bundles (steps 1-4 below) are committed **together with or before** the helpers that read their keys (steps 6-7); the gate helpers call `messages.getMessage`/`createError` at runtime, so a helper exercised before its keys exist throws "missing message key". Treat helper + keys as one unit.

1. **`messages/insurance.import.record-updates.md`** (new) — [implemented] — `summary`, `description`, `examples`, `flags.file.summary`, `flags.no-prompt.summary`, `flags.dry-run.summary`, the shared gate keys (`warn.header`, `warn.summary`, `warn.skippingPrompt`, `confirm.apply`), and error keys WITH companion `.actions` sections: `error.confirmationRequired` (+`.actions`), `error.aborted`, `error.invalidFile`, `error.recordIdentityMismatch`, `error.applyFailures` (+`.actions`).
2. **`messages/cml.import.as-expression-set.md`** — [pending] — add `flags.no-prompt.summary`, `flags.dry-run.summary`, `flags.allow-unresolved-associations.summary`, the gate keys, and error keys + `.actions`: `error.cmlNotFound`, `error.missingEsd`, `error.missingEsdVersion`, `error.unresolvedAssociation`, plus `--no-prompt`/`--dry-run` examples.
3. **`messages/cml.convert.insurance-shared.md`** — reword `flags.update-records.summary` to state it is removed/errors; add `error.updateRecordsRemoved` + `.actions`.
4. **`messages/cml.convert.underwriting-rules.md` and `messages/cml.convert.surcharge-rules.md`** — update any `description`/text referencing "for updating records" so it points at the export+`import record-updates` flow (underwriting description currently says "for updating records").
5. **`src/shared/insurance/models.ts`** — add `RecordUpdateField`, `RecordUpdate`, `RecordUpdatePlan` (§3).
6. **`src/shared/insurance/planned-change.ts`** (new; the design originally proposed `src/shared/import/`) — [implemented] — `PlannedChange` type + `renderPlannedChanges(renderer, changes, text)` (styledHeader + `@oclif/table` + warn summary incl. the non-transactional notice); returns the structured array for JSON. Takes a minimal renderer interface rather than the `SfCommand` itself, so it is unit-testable without oclif.
7. **`src/shared/insurance/confirm-org-changes.ts`** (new; the design originally proposed `src/shared/import/`) — [implemented] — `confirmOrThrow(host, { noPrompt, interactive }, text)` implementing the matrix (§4). The `--dry-run` early return lives in the caller (it must happen before the gate is consulted at all), so the gate itself only decides prompt / bypass / fail-fast.
8. **`src/shared/insurance/insurance-rule-convert-command.ts`** — (a) remove the `updateOrgRecords` call at `:116-118`; (b) replace `abstract updateOrgRecords(...)` with `protected abstract buildRecordUpdatePlan(records, ruleKeyMapping): RecordUpdatePlan`; (c) add `protected async writeRecordUpdateFile(plan, safeApi, workspaceDir)` writing `<safeApi>_<Kind>Update.json` (pretty JSON), and call it from BOTH `runConvert` (build path, unconditionally — incl. zero-record case, see §3) and `runMergeConvert`; (d) update both hardcoded "Next steps" blocks (`:165-169`, `:312-317`) to mention the update file and `sf insurance import record-updates`, and the required ordering (§5); (e) emit the `error.updateRecordsRemoved` tripwire at the top of `runConvert` before the `mergeWithOrg` branch (§6). **Keep the `Connection` import.** Note the zero-record early return (`:91-94`) must still write the update file before returning.
9. **`src/commands/cml/convert/underwriting-rules.ts`** — replace `updateOrgRecords` (`:99-172`) with pure `buildRecordUpdatePlan`: group updates from the union of `UnderwritingRuleGroupId` across all `records`; rule updates only for `records.filter(r => !r.RuleKey && r.DynamicRuleDefinition)`, reusing the EXACT live rewrite (raw `JSON.parse`, no `decodeHtmlEntities`, conditional `underwritingRuleGroup` mutation, `ruleKey` from `ruleKeyMapping` by `record.Id`). No `conn`.
10. **`src/commands/cml/convert/surcharge-rules.ts`** — replace `updateOrgRecords` (`:161-179`) with pure `buildRecordUpdatePlan` building `ProductSurcharge` `RuleEngineType` updates **only from `ruleKeyMapping`**, each carrying `expectedRuleKey = p.rule.ruleKey` and source `ProductCodes`. Wire `writeRecordUpdateFile` into `runMergeConvert` (replacing `:132-136`). No `conn`.
11. **`src/commands/insurance/import/record-updates.ts`** (new) — [implemented] — id `insurance import record-updates`; plan parsing/validation in `src/shared/insurance/record-update-plan.ts` and the org read/apply phases in `src/shared/insurance/record-update-apply.ts`; flags `--target-org`, `--api-version`, `--file` (required, `exists:true`), `--no-prompt`, `--dry-run`; load + validate plan (§8); per-`kind` strategy for identity verification, skip-compare, and surcharge RuleKey verification (§5); build `PlannedChange[]` from fresh re-read; `confirmOrThrow`; apply with partial-failure handling (§5).
12. **`src/commands/cml/import/as-expression-set.ts`** — [pending] — add `--no-prompt`, `--dry-run`, `--allow-unresolved-associations`; extract `planAsExpressionSet` read phase (§5) returning `PlannedChange[]` + resolved data; add `cmlNotFound`/`missingEsd`/`missingEsdVersion`/`unresolvedAssociation` guards and the ESCDCD existence check in the read phase; call `renderPlannedChanges` + `confirmOrThrow`; reorder apply so the `ConstraintModel` PATCH is LAST; add `plannedChanges` to the result type; no mutation before confirm/non-dry-run.
13. **`test/commands/cml/import/record-updates.test.ts`** (new) — [implemented], alongside unit tests for the shared modules in `test/shared/insurance/record-update-{plan,apply}.test.ts` and `test/shared/insurance/confirm-org-changes.test.ts`. Still [pending] from the list below: the UW byte-equality comparison against the legacy `updateOrgRecords` output (that code path no longer exists in the tree) and the merge-skipped-surcharge assertion (a convert-side concern, step 15). Covered: happy path (UW + surcharge), idempotent re-run incl. org-normalized-blob structural-compare (apply → re-serialize → re-apply asserts zero writes), partial-failure exit code, `--no-prompt` bypass, `--dry-run` (no writes, plan returned), `--json`/no-TTY refusal, corrupted/edited-file rejection, bad-Id rejection, **identity-mismatch rejection** (edited id → wrong-name), **merge-skipped surcharge absent from file**, **surcharge RuleKey-mismatch warning**, and **UW byte-equality** of the serialized `DynamicRuleDefinition` vs the legacy `updateOrgRecords` output for: (a) record with existing `underwritingRuleGroup`, (b) record without it, (c) record with HTML entities.
14. **`test/commands/cml/import/as-expression-set.test.ts`** — [pending] — **the file is currently 100% commented out with zero active tests** (the `/* … */` block lines 17-85; "runs hello" placeholders are inside it and do not run). Step is NEW test authoring: (a) delete the dead block; (b) build a real org-connection stub harness (mirror `test/commands/cml/convert/surcharge-rules.test.ts`'s `stubOrgConnection`) and assert the CURRENT happy path as a regression baseline; (c) add gate tests (confirm yes/no, `--no-prompt`, `--dry-run`, `--json` refusal), ESCDCD no-duplicate on re-run, PATCH-last ordering, `cmlNotFound`/`missingEsd`/`missingEsdVersion` pre-prompt errors, and unresolved-FK `Create (UNRESOLVED FK)` block.
15. **`test/commands/cml/convert/surcharge-rules.test.ts` & `test/commands/cml/convert/underwriting-rules.test.ts`** — assert NO org writes under any flag; assert `--update-records` hard-errors with migration guidance; assert `<safeApi>_SurchargeUpdate.json` / `_UnderwritingUpdate.json` content (incl. zero-record `updates: []`); remove any `updateOrgRecords` expectations. Add the underwriting file if missing.
16. **Manifest/README** — run the repo's `oclif readme` / manifest generation (check `package.json` `postpack`/`prepare`/`prepack` scripts and any `oclif.manifest.json`) so the new `insurance import record-updates` command and the new flags land in generated docs; check for and update any command-snapshot test that enumerates command ids/flags.

---

## 8. Validation, Risks & Edge Cases

- **Corrupted / hand-edited update file:** `JSON.parse` in try/catch → `error.invalidFile`; assert `schemaVersion === 1`, `kind` in the allowed set, `updates` is an array; each `update.sobject` in the allow-list, `id` matches `/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/`, `name` present, `fields` non-empty with allow-listed `field` per sObject (`UnderwritingRuleGroup`/`ProductSurcharge` → `RuleEngineType`; `UnderwritingRule` → `DynamicRuleDefinition`). Reject the whole file on any structural violation, before any write. Id regex passing is NOT sufficient identity proof — the apply-time `name`/`apiName` cross-check (§5.2) is the real guard against writing to a valid-but-wrong record.
- **SOQL-injection-safe lookups:** the §5 re-read single-quotes only regex-validated ids; never interpolate `name`/`value`. Associations CSV path keeps existing `validateAssociationNames` guarding (`:246-269`).
- **`DynamicRuleDefinition` is itself JSON:** stored as a string `value`, written verbatim on apply (reviewer corrections honored byte-for-byte). The skip-compare parses both sides structurally (§5.3), so verbatim-write and structural-skip coexist without spurious rewrites. On load, attempt `JSON.parse` of the value and warn (non-fatal) if it fails — the org may still accept it.
- **Surcharge silent-non-fire (headline hazard):** `expectedRuleKey` makes the convert-assumed key visible/reviewable; apply re-reads `ProductSurcharge.RuleKey` post-flip and warns loudly on mismatch or absence from the active `ConstraintModel` (§5.4). Required ordering (as-expression-set before record-updates) and the T0/T1 drift are documented in §5 and the Next-steps.
- **UW group/rule selection parity:** group set = union of all `records[].UnderwritingRuleGroupId`; rule set = `!RuleKey && DynamicRuleDefinition` only (§3). Tested by step 13 (a group whose rules are all already-keyed still appears; a non-null-`RuleKey` record gets no rule update).
- **Empty `updates: []`:** logged no-op, no prompt, exit 0.
- **`as-expression-set` missing preconditions:** `cmlNotFound`, `missingEsd` (undefined `ExpressionSetDefinitionId`, which would otherwise poison the ESCDCD create and Version lookup), `missingEsdVersion` (never PATCH `/…/undefined`) — all resolved in the read phase BEFORE the prompt (§5).
- **Unresolved-FK associations:** `'unexpected'`/falsy `ReferenceObjectId` rows shown as `Create (UNRESOLVED FK)` and blocked by `error.unresolvedAssociation` unless `--allow-unresolved-associations` (§5).
- **Ambiguous duplicate Names:** convert already warns (`:261-267`); re-surface in the import preview as a best-effort warn, non-blocking.
- **Partial apply leaves a documented state:** the warning explicitly says changes are ordered and not rolled back; `as-expression-set` orders the activating PATCH last (failure → inactive, not active-but-unbound); `record-updates` re-run is safe via skip-if-current. Failure summaries name the partial state and the exact idempotent re-run command.
- **`--json` machine output:** all commands return full structured results (`plannedChanges`, `dryRun`, apply counts, itemized `skipped[]`, `failed[]`) since `styledHeader`/`table` are suppressed; the human summary rides the `warnings` array.
- **`--no-prompt` rubber-stamp risk:** mitigated by `--dry-run` (review the plan in a prior CI stage) plus the content signal on the ConstraintModel PATCH; document pairing `--dry-run` then `--no-prompt`.
- **No-TTY timeout stall:** avoided by up-front `!isTTY || jsonEnabled()` detection; `confirm` returns `defaultAnswer=false` after `ms` (it does not throw), which in CI is a 30s stall + silent abort — so we never enter the prompt non-interactively.

---

## Review resolutions

**Correctness**

- _Surcharge update file omits the rule key (blocker):_ Added `expectedRuleKey` + source `ProductCodes` + `generatedAt` to each surcharge `RecordUpdate` (§3c); apply re-reads `ProductSurcharge.RuleKey` post-flip and warns loudly on mismatch/absence (§5.4); documented required as-expression-set→record-updates ordering and the T0/T1 drift.
- _UW `DynamicRuleDefinition` rewrite diverges for no-group records (blocker):_ `buildRecordUpdatePlan` reuses the EXACT live rewrite (raw parse, no `decodeHtmlEntities`, conditional — never creating — `underwritingRuleGroup`); fixed the §3b example to NOT synthesize the group; added byte-equality tests for existing-group / no-group / HTML-entity cases (step 13).
- _String-equality skip unsafe for the blob (blocker):_ §5.3 uses structural deep-equal on the parsed blob (only `ruleKey` + `underwritingRuleGroup.ruleEngineType`) for `DynamicRuleDefinition`, raw compare for scalar `RuleEngineType`; idempotent-re-run test added.
- _as-expression-set partial failure (major):_ apply reordered so `ConstraintModel` PATCH is LAST; partial-failure exit + actionable summary mirrored from record-updates; test added.
- _Id-only validation can't catch wrong-but-valid id (major):_ added hard `name` (and UW `apiName`) identity cross-check at apply (§5.2), `error.recordIdentityMismatch`; `name` is now a required verification key.
- _Empty file vs no file ambiguity (major):_ made the invariant total — the update file is ALWAYS written, including the zero-source-records case (§3); `--file` always resolves.
- _Build vs merge data-source differences (minor):_ §3 states surcharge derives only from `ruleKeyMapping`, UW groups from the full `records[]` union, UW rules from the `!RuleKey && DynamicRuleDefinition` subset; merge-skipped-surcharge-absent test added.

**Safety-UX**

- _as-expression-set can't preview before writing (blocker):_ mandated the read-only `planAsExpressionSet` phase with no mutation before confirm/dry-run (§4, §5).
- _currentValue advisory ≠ applied diff (blocker):_ dropped convert-time `currentValue`; the displayed "old" is always a fresh in-invocation re-read; added a content signal (bytes/sha256/rule-count Δ) for the opaque ConstraintModel PATCH; drift surfaces via the surcharge `generatedAt`/`ProductCodes` and the RuleKey check.
- _UW selection rules (major):_ specified group=union, rule=`!RuleKey && DynamicRuleDefinition` (§3); tested.
- _Partial apply not described to the human (major):_ §4 warning now states changes are ordered and not rolled back; failure messages name the partial state + re-run command; PATCH ordered last.
- _Skip hides reviewer intent (major):_ skips are itemized (id/field/reason) in summary and `--json`; structural compare avoids cosmetic-rewrite false positives.
- _`--no-prompt` too blunt (major):_ added `--dry-run` to both importers (+ optional content signal); documented dry-run→no-prompt pairing. (Did not add `--expected-changes` count assertion — `--dry-run` plus the JSON `plannedChanges` already gives CI a tripwire; deferred as optional.)
- _Unresolved-FK rows (minor):_ `Create (UNRESOLVED FK)` state + `error.unresolvedAssociation` block, with `--allow-unresolved-associations` escape hatch.
- _Missing-CML/ESDVersion guards must run pre-prompt (minor):_ folded into the read phase ordering (§5).
- _Deprecated `--update-records` + `--json` dead-end (minor):_ changed from warn-and-no-op to a HARD ERROR with migration guidance, emitted on both convert paths (§6).

**Compat-Scope**

- _as-expression-set tests are all commented out (blocker):_ step 14 rewritten as new test authoring — delete the dead block, build a stub harness + regression baseline, then add gate/idempotency/guard tests.
- _No source for surcharge/UW currentValue (blocker):_ chose option (a) — dropped `currentValue` from the file entirely; "old" comes from the apply-time re-read (§3).
- _insurance-shared.md shared by three commands + hardcoded Next-steps (major):_ added steps to update the inline `this.log` Next-steps (`:165-169`, `:312-317`) AND the underwriting/surcharge description bundles; clarified Next-steps are inline, not in bundles.
- _Deprecation warn must fire on both paths (major):_ emit the `--update-records` tripwire at the top of `runConvert` before the `mergeWithOrg` branch (§6, step 8e).
- _Don't remove the Connection import (major):_ explicitly kept; only the `updateOrgRecords(conn)` signature is removed (§1, step 8).
- _ExpressionSetDefinition id can also be undefined (major):_ added `error.missingEsd` guard before the ESCDCD query/prompt (§5, §8).
- _confirm() timeout semantics (minor):_ reworded rationale precisely — returns `defaultAnswer` after `ms`, does not throw; fail-fast retained (§4, §8).
- _createError action-message signature (minor):_ specified companion `<key>.actions` sections and `actionTokens` usage for all remediable errors (steps 1-3).
- _Build order puts helpers before their message keys (minor):_ reordered §7 so message bundles precede/accompany the helpers, with an explicit note.
- _Manifest/README/snapshot regeneration (minor):_ added step 16 to regenerate oclif README/manifest and update any command-snapshot test.
