# Insurance field-driven rule conditions → CML

Investigation notes and strategy. Local only (`docs/` is gitignored). No production code changed.

Evidence org: `autosilver` (`ins-auto-org1-sdb626@industries.org`), ExpressionSet `Auto_Silver`,
ExpressionSetDefinition `9QAfiw0000007o8GAA`, ExpressionSetDefinitionVersion `9QBfiw0000006aPGAQ` (v1).

---

## 1. Verification of the established findings

All five prior findings reproduce. Nothing to correct.

| #   | Claim                                                                                   | Result                         |
| --- | --------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | 21 ProductSurcharge records, all parse; `type` ∈ {`Attribute` ×9, `Tag` ×1}; no `Field` | Confirmed                      |
| 2   | The `EndDate` Tag condition has null `attributeName`/`attributeId`                      | Confirmed, payload identical   |
| 3   | Curated model has both `extern`+`contextPath` and `@(tagName = …)`                      | Confirmed                      |
| 4   | Lines 60–61: bare form commented out, constant-false form live                          | Confirmed verbatim             |
| 5   | `Is_Electric_Vehicle` is declared, so `sanitizeName` matches by luck                    | Confirmed, with a caveat below |

The model blob re-fetched via `conn.request` on
`/services/data/v64.0/sobjects/ExpressionSetDefinitionVersion/9QBfiw0000006aPGAQ/ConstraintModel`
is byte-identical to the saved copy: 10,335 bytes, SHA-256
`24316f5244a327d6f1c9b6cab9f5c7c5a59201db14362b377391f5251ef97d61`.

Caveat on finding 5: `Is_Electric_Vehicle` is declared at line 81 **in `type Auto`**, and
`type Vehicle : Auto` (line 95) inherits it. `mergeUnderwritingConstraints` scans only the leaf
type block, so a rule placed on `Vehicle` that referenced it would produce a _spurious_ warning
even though the reference is sound. The luck is therefore two-sided: `sanitizeName` can
accidentally match, and the warning can accidentally fire. Neither is a check.

Also confirmed in the code, as background:

- `condition.type` is read only at `bre-rules-generator.ts:682,688` (Revenue Cloud). The insurance
  path never reads it.
- `insurance-cml-merge.ts:717-724` warns and explicitly does **not** insert. The doc comment at
  `:132-136` still claims `referencedAttributes` is "used to auto-insert missing attribute
  declarations" — stale, and worth deleting whichever option is chosen.

---

## 2. What the converter emits today (measured, not inferred)

`sf cml convert surcharge-rules -o autosilver` against the live org. Diff of the emitted model
against the org's curated model — the _entire_ diff, one line:

```
61c61
<     rule("EndDate" == "2026-12-31", "InsuranceSurchargeRule", "SC__autoSilver__FeeMigCode", "True");
---
>     rule(EndDate == 2026-12-31, "InsuranceSurchargeRule", "SC__autoSilver__FeeMigCode", "True");
```

The converter's output is **byte-identical to the human's commented-out line 60** — the form a
human already tried, found broken, and commented out. The converter then _replaces_ the human's
constant-false workaround with it. So today's behaviour on this condition is: overwrite a known-bad
workaround with a known-bad reference, and warn.

The warning it emits:

```
Warning:   ATTRIBUTE AutoSilver_FeeMig: declaration references 'EndDate' which is absent from the model
```

Tracing the quoting for this exact condition (`dataType: "Date"`, operator `Equals`):

`conditionDataType` → `"Date"` (no `attributeId`, so `fetchAttributeDataTypes` cannot contribute)
→ `dataTypeToCml` → `SOURCE_DATA_TYPE_TO_CML['DATE']` = `'date'` → `emitsUnquoted('Equals','date')`
is true → `isSafeDateLiteral('2026-12-31')` passes → emitted **unquoted**.

So the emitted text is exactly `EndDate == 2026-12-31`. Both halves are wrong in different ways:
the left side is undeclared, and the right side is a bare `2026-12-31` whose validity as a CML date
literal is unverified (see §5 — this is a real open risk, not a nit).

---

## 3. The `extern` contract

### contextPath — derivation is confirmed

`contextPath` is `<ContextNode.Title>.<ContextAttribute.Title>` within the ContextDefinition bound
to the ExpressionSet.

`Auto_Silver` binds to ContextDefinition `InsuranceDynamicTest` (`11Ofiw0000001k5EAA`, active
version `11pfiw0000008hdAAA`), via `ExpressionSetDefinitionContextDefinition`.

Both sides check out against that version:

| CML                                            | ContextNode.Title  | ContextAttribute.Title | ContextAttribute.DataType |
| ---------------------------------------------- | ------------------ | ---------------------- | ------------------------- |
| `extern string UserProfile` (existing, line 9) | `SalesTransaction` | `UserProfile`          | `string`                  |
| `extern date EndDate` (proposed)               | `SalesTransaction` | `EndDate`              | `date`                    |

So for `EndDate` the correct value is **`contextPath = "SalesTransaction.EndDate"`**, and the CML
type must be `date` to match `ContextAttribute.DataType = date`.

`EndDate` is genuinely a Salesforce field behind the scenes. From
`/connect/context-definitions/11Ofiw0000001k5EAA`:

```json
{
  "baseReference": "InsuranceContext__stdctx/version/QuoteEntitiesMapping/SalesTransaction/EndDate",
  "contextAttrHydrationDetailList": [
    {
      "mappedAttributeDataTypeInfo": { "dataType": "DateOnly", "supportedPicklistValues": [] },
      "queryAttribute": "EndDate",
      "sObjectDomain": "Quote"
    }
  ]
}
```

That is the whole "field" story: BRE calls it a Tag, the ContextDefinition hydrates it from
`Quote.EndDate`, and CML reaches it through `extern` + `contextPath`. There is no `Field` condition
type to support, and no `FieldDefinition`/describe lookup is needed — the ContextDefinition is the
lookup.

### attributeSource — NOT determined

I could not find an enumeration, and I am not going to guess one.

- Every occurrence in Salesforce-owned code and docs is the single literal `"ST"`, in the insurance
  Advanced Configurator help pages (`products/ind/help/*/insurance/topics/core_setup/
insurance_advanced_configurator_example_{autosilver,medical}.xml`) and in this org's own model.
  Every other codesearch hit is unrelated (Lucene's `AttributeSource` class, Tableau SCIM docs).
- It is absent from the ContextDefinition Connect payload and from `ContextNode` /
  `ContextAttribute` / `ContextTag`, so it is a CML-side annotation, not context metadata.

`"ST"` almost certainly abbreviates `SalesTransaction`, matching the node the path is rooted at,
which would imply sibling values for other roots. That is inference. **Treat `"ST"` as the only
known-good value and only for `SalesTransaction`-rooted paths.** Getting the enumeration needs the
CML compiler source or its owning team; it is not discoverable from an org.

### Placement and typing

- **Top level.** Both the org model and the help docs place `extern` at model top level, outside any
  `type` block. I did not find an in-type-block example and did not establish whether one is legal.
- **Type must match `ContextAttribute.DataType`** (`date` for `EndDate`). Note this is the _context_
  type, not the BRE `dataType` — they agree here (`Date` → `date`) but the context is authoritative.

### `extern` vs `@(tagName = …)`

They are different mechanisms and the model uses both:

|          | `extern` + `contextPath`      | `@(tagName = …)`                                       |
| -------- | ----------------------------- | ------------------------------------------------------ |
| Where    | model top level               | inside a `type` block, on a member                     |
| Binds to | a ContextDefinition attribute | a product/item tag                                     |
| Example  | `extern string UserProfile;`  | `@(tagName = "ItemTotalPrice") decimal(2) totalPrice;` |
| Scope    | transaction-wide              | per-instance of that type                              |

`EndDate` is a transaction-level value hydrated from `Quote.EndDate`, and it lives on the
`SalesTransaction` context node — not on a product. So **`extern` is the right mechanism for
`EndDate`**, and `@(tagName = …)` is right for product/item-level tags like `ItemTotalPrice`. A
converter branching on `condition.type === 'Tag'` cannot use one form for all Tags; it has to
resolve the tag against the ContextDefinition and pick.

One structural point worth carrying into whichever option wins: in
`@(tagName = "ItemTotalPrice") decimal(2) totalPrice;` **the CML identifier differs from the tag
name**. The annotation carries the real name; the identifier is ours to choose. The same is true of
`extern`. This is what makes the naming problem tractable (§5).

---

## 4. The finding that reframes the whole decision: the platform never validates

I ran three models through PATCH-then-activate on `Auto_Silver`, using
`ExpressionSetVersion.IsActive` (`9QMfiw0000007oDGAQ`), which is the real activation switch
(`ExpressionSetDefinitionVersion.Status` is not directly updateable and flips to `Active` as a
side effect):

| Model                                                                                                             | Result                           |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Converter output — bare `EndDate`, nothing declares it                                                            | **Activated.** `Status = Active` |
| Variant A — same, plus `@(contextPath = "SalesTransaction.EndDate", attributeSource = "ST") extern date EndDate;` | **Activated.** `Status = Active` |
| Deliberate syntax error — `type Auto { @@@BROKEN@@@`                                                              | **Activated.** `Status = Active` |

The third row is the important one. **A model with a hard syntax error activates cleanly.**
Activation is not a compile gate, so:

- "Imports cleanly" proves nothing — already known.
- "Activates cleanly" proves nothing — new, and it invalidates the obvious way to test this.
- `Status = Active` proves nothing.
- Variant A activating therefore does **not** demonstrate that the extern form is correct. I am
  explicitly retracting that reading; the experiment cannot distinguish the three models.

The `InvalidDraft` value on the `Status` picklist implies validation exists _somewhere_ (probably
the Advanced Configurator UI's save path), but nothing on the API path I used reaches it.

This is decisive for the strategy. **The platform will not tell an operator that a reference is
dangling — not at import, not at activation.** Whatever detection exists has to live in the
converter. That makes a detection mechanism mandatory independent of which emission option wins.

---

## 5. Options

Shared premise: for `AutoSilver_FeeMig` the _wiring_ is already correct. `ProductSurcharge`
`1Xrfiw000000DzlCAE` is already `RuleEngineType = ConstraintEngine` with
`RuleKey = SC__autoSilver__FeeMigCode`, exactly matching the rule key the converter generates and
the key in the CML. Nothing about rule keys or record flipping is broken here. The single defect is
that `EndDate` resolves to nothing.

### (A) Branch on `type === 'Tag'`, emit an `extern` declaration + bare reference

Resolve `contextTagName` against the ExpressionSet's ContextDefinition
(`ExpressionSetDefinitionContextDefinition` → `ContextNode`/`ContextAttribute`), emit

```
@(contextPath = "SalesTransaction.EndDate", attributeSource = "ST")
extern date EndDate;
```

at top level, then reference `EndDate` bare.

- **Fires?** Unproven. This is the only option that _can_ fire, because it is the only one that
  gives the reference a binding, and it matches the mechanism the curated model already uses for
  `UserProfile`. But I could not execute the rule, so "can fire" is not "does fire".
- **Breaks:** mutates the curated model (adds a top-level declaration), which is the stance
  reversal discussed below. Needs the `attributeSource` enumeration for any non-`SalesTransaction`
  root — unknown. Needs a tag→ContextDefinition resolver that does not exist yet.
- **Operator:** nothing, when the tag resolves. When it does not, must fall back to (B).

### (B) Emit the reference, withhold the rule with an actionable reason when nothing declares it

Reuse the existing `unconvertibleReason` / skip machinery: if a referenced name is not declared
anywhere in the model, do not place the rule.

- **Fires?** No — by design it is withheld. But it converts a rule that silently never fires into a
  loud, named skip.
- **Breaks:** nothing. Strictly consistent with "never mutate a curated model".
- **Operator:** must hand-add the declaration, then re-run.
- **This option alone would have caught the real `EndDate` bug.** Today's code _almost_ does this —
  it computes the warning and then places the rule anyway. Given §4, the warning is the only signal
  anywhere in the pipeline, and it is currently non-blocking.

Two defects in the existing check must be fixed for (B) to be trustworthy:

1. It scans the **leaf type block only**, so an inherited declaration (`Is_Electric_Vehicle` in
   `type Auto`, referenced from `type Vehicle : Auto`) reads as absent → false positive.
2. It does not look at **top-level `extern`** declarations at all, so a correctly-externed name
   would read as absent → false positive. (The surcharge path's message says "absent from the
   model" but the underwriting path's says "absent from type" — the two are inconsistent.)

### (C) Auto-declare into the curated model, Revenue-Cloud style

- **Fires?** Only if the injected declaration is _correct_. For a context-backed tag, a plain
  `date EndDate;` inside a type block would compile-shaped but bind to nothing — it would fire
  never, or wrongly, with no warning. Injecting the _right_ thing is exactly option (A).
- **Breaks:** the curated-model stance, without (A)'s justification.
- **Not recommended** as a general rule. (C) is (A) done blindly.

### The Revenue Cloud tension, head-on

Revenue Cloud's `getTargetAttribute` auto-declares safely because it _owns the model it is
declaring into_ — `PcmGenerator` generated it from the product catalogue in the same run, so adding
an attribute is completing a model, not editing someone's work. Insurance merges into a file whose
first line is `DO NOT MODIFY`, authored by a human, containing hand-tuned constraints and
deliberate commented-out experiments. The refusal to mutate is correct _for attributes_, where an
injected declaration is a guess about business intent.

But `extern` is not that kind of guess. Its content is fully determined by org metadata the
converter can read: the node, the attribute name, and the type all come from the ContextDefinition
bound to that ExpressionSet. There is no judgement call to get wrong — it either resolves or it
does not. So the honest framing is not "Revenue Cloud mutates, insurance doesn't" but **"mutate
only what org metadata fully determines."** An `extern` derived from a resolved ContextAttribute
clears that bar. A bare `date EndDate;` guessed into a type block does not.

Note also that the "don't mutate" stance is already only nominally held: the converter rewrites
`rule(...)` statement lines inside the curated model on every run — including, here, overwriting a
human's deliberate workaround on line 61. It is not a read-only merge today.

### Recommendation

**(B) as a blocking gate, plus (A) where the tag resolves.** Concretely:

1. **Make the dangling-reference check blocking and correct it.** Withhold the rule with a named
   reason rather than warning and placing. Fix the check to scan the full model (top-level `extern`
   included) and to walk `type X : Y` inheritance. Given §4, this is the _only_ place a dangling
   reference can be caught. This is the part I would ship first; it is small, purely defensive, and
   would have caught the real bug.
2. **Then add (A)**: branch on `condition.type`, resolve `contextTagName` against the
   ExpressionSet's ContextDefinition, and emit `extern` when it resolves — which then satisfies the
   gate from step 1 naturally. Keep it behind a flag until the `attributeSource` enumeration is
   confirmed and someone has observed a rule actually firing.
3. Do **not** auto-declare anything that org metadata does not fully determine.

Sequencing matters: step 1 is safe without step 2, step 2 is not safe without step 1.

Rough surface area: `insurance-rule-generator.ts` (`buildConditionExpression` branching on
`type`, a `date`-literal decision), `insurance-cml-merge.ts` (make the check blocking; fix scope
and inheritance; delete the stale `referencedAttributes` doc comment), a new ContextDefinition
resolver alongside `fetchAttributeDataTypes`, plus fixtures — the local fixture set has no `Tag`
condition with a null `attributeName`, which is why this gap survived.

### `sanitizeName`

`sanitizeName` should keep minting identifiers, and should **never** be relied on to _match_ an
existing declaration. Today the binding is "sanitize the BRE name and hope the curated model
happens to use the same spelling" — which is precisely why `Is_Electric_Vehicle` works and
`EndDate` does not, with nothing distinguishing the two cases.

The annotation forms remove the need for the gamble: `@(tagName = "ItemTotalPrice") decimal(2)
totalPrice;` shows the real name living in the annotation while the identifier is free. So for a
dotted or spaced tag name, sanitize for the identifier (`Policy End Date` → `Policy_End_Date`) and
put the **unsanitized original** in `contextPath` / `tagName`, where it must survive verbatim. A
dotted name additionally needs care: `SalesTransaction.EndDate` is already a _path_, so a dotted
`contextTagName` may be a path rather than a name with a dot in it — worth resolving against the
ContextDefinition rather than assuming.

And with (B) in place, a mismatch stops being silent, which matters more than the naming rule
itself.

### Open risk: the unquoted date literal

Separate from the declaration problem: the converter emits `2026-12-31` bare. I have not verified
that CML parses that as a date. There is no date literal anywhere in this curated model to compare
against, and §4 means activation will not complain either way. An unquoted `2026-12-31` is also
plausibly parseable as arithmetic (`2026 - 12 - 31` = `1983`), which would be a silently wrong
comparison rather than an error. This needs a compiler answer before any date-typed condition is
trusted, and it applies to `DATE`/`DATETIME` in `SOURCE_DATA_TYPE_TO_CML` generally.

---

## 6. Parentheses: refuted

A bare reference is never parenthesized. Every parenthesis in the curated model is one of:

- **grouping** — `(auto.maxAutoValue >= 50000 && auto.minAutoYear < 2020)`
- **function call** — `max(Auto_Value)`, `count(Has_Anti_Theft > 0)`, `parent(condition5)`,
  `strformat(...)`, `table(...)`
- **statement form** — `rule(...)`, `require(...)`, `constraint(...)`, `message(...)`,
  `exclude(...)`
- **type/precision** — `decimal(2)`
- **annotation** — `@(tagName = "ItemTotalPrice")`

The decisive case is the `extern` mechanism's own reference site, line 57:

```
require(medicalpayments[MedicalPayments] == 1 && medicalpayments.medicalDeductible == 500 && UserProfile == "Custom Standard User", bodilyinjurypropertydamage[BodilyInjuryPropertyDamage] { Bodily_Injury_Per_Person_Limit = 1000 }, "BIPD is required when MedicalPayments is selected at 1k limit");
```

`UserProfile` — a top-level `extern`, referenced bare, unparenthesized, mid-expression. If any
reference form required parentheses it would be this one. Same pattern for ordinary members:
`totalPrice > 10` (line 36), `Colour == License_State` (line 122), `Year > 2015` (line 148).

On the `constraint((name) == name_value);` form recalled earlier: **no such pattern exists in this
model.** The closest is line 122, `constraint(Colour == License_State);`, which is the statement's
own parentheses around an unparenthesized comparison of two bare identifiers. So that recollection
does not hold up here — though it came from elsewhere, and this is one model, so it is refuted for
this evidence rather than universally.

The converter's current output agrees: it emits `rule(EndDate == 2026-12-31, ...)`, with the bare
reference unparenthesized. Whatever is wrong with that line, the parentheses are not it.

---

## 7. End-to-end validation: partial, and it did not prove firing

What was established:

- Step 3 (RuleKey) and step 4 (record flip) are **already satisfied** in the org and needed no
  writes: `AutoSilver_FeeMig` is already `ConstraintEngine` with a platform-generated
  `RuleKey = SC__autoSilver__FeeMigCode` matching the converter's key exactly.
- Import/activation acceptance is **worthless as a signal** (§4).

What was **not** established: **whether the rule fires.** I could not execute it. Exercising an
insurance surcharge means driving a real `SalesTransaction`/Quote carrying `EndDate = 2026-12-31`
through pricing and inspecting the applied surcharge. No simulation endpoint responded on this API
version, and the available route (`runSalesforcePricing`, which needs a `contextInstanceId`, or
`createInsuranceQuote`) means building a quote in a shared team org — beyond what I was willing to
do unattended there.

So the central question — _does `extern` make the rule fire_ — remains open. I can say the extern
form is the mechanism the curated model itself uses for exactly this class of value, that the
contextPath for `EndDate` is confirmed correct against the ContextDefinition, and that the current
output cannot possibly fire because nothing declares its left-hand side. I cannot say I saw it
fire, and given §4 nothing short of seeing it fire should be taken as proof.

**Recommended next step:** a disposable org with a scripted quote, so activation-and-execute can be
run repeatably. Three models to compare — bare reference, extern, and the constant-false workaround
— against a quote with `EndDate = 2026-12-31`, checking whether the surcharge lands. That also
settles the unquoted-date-literal question in the same run.

### Org state

Everything was scoped to `Auto_Silver`; no other ExpressionSetDefinition was touched.

- Backed up before writing: 10,335 bytes, SHA-256 `24316f52…f97d61`, at
  `/tmp/breinv/BACKUP-autosilver-9QBfiw0000006aPGAQ.cml` (chmod 444).
- Precondition verified immediately before the first PATCH: `Status = Inactive`.
- **Restored.** Final state matches the original: `ExpressionSetDefinitionVersion 9QBfiw0000006aPGAQ`
  `Status = Inactive`, `ExpressionSetVersion 9QMfiw0000007oDGAQ` `IsActive = false`, ConstraintModel
  byte-identical to the backup apart from a single trailing newline the platform appends on every
  PATCH round-trip.
- No `ProductSurcharge` record was written. `sf insurance import record-updates` was not run — it
  had nothing to do for this rule, which was already in the target state.

---

# Part II — Live execution proof in `sdb38-ins`

Second investigation, disposable org `sdb38-ins` (`ins-di-sdb38-pcorg@sf.com`,
`https://sfcom82.test1.my.pc-rnd.salesforce.com`, org `00DAAC00006mX6H2BU`).

**Headline: the central question is now answered, and the answer is worse than "it doesn't fire".**
A bare undeclared reference does not silently fail — it makes the constraint solver **reject the
entire model at deploy**, disabling every rule in it. `extern` fixes that. Separately, the
unquoted date literal turns out to be **correct**, refuting §5's open risk.

---

## 8. Method correction: API version matters, and v64 was hiding things

Everything in Part I was done on `v64.0`. Several things are simply **invisible** below `v69.0`:

| Thing                                                                        | v64.0                | v69.0                           |
| ---------------------------------------------------------------------------- | -------------------- | ------------------------------- |
| `ProductSurcharge.RuleEngineType`                                            | absent from describe | present                         |
| `ProductSurcharge.RuleKey`                                                   | absent               | present                         |
| `ProductSurcharge.SequenceNumber` / `ProductId` / `PricingProcedureVariable` | absent               | present                         |
| `POST /connect/constraints/cml/validate`                                     | `404 NOT_FOUND`      | `403 FUNCTIONALITY_NOT_ENABLED` |

The last row is the trap: on an older API version a gated resource is indistinguishable from a
nonexistent one. **"I searched and found no simulation endpoint" was a version artifact.** Several
evaluation endpoints exist (§10). Any future probing of this area must be done on the org's highest
API version.

---

## 9. Org survey — `sdb38-ins`

### Constraint ExpressionSets

8 of 36 ExpressionSets are `UsageType = Constraint`. **All 8 bind the same ContextDefinition,
`InsuranceDynamicTest`** (`11OAAC000000GG52BM`, active version `11pAAC00000Q11PYBS`) — the same
ContextDefinition name as `autosilver`, though a different org and different ids.

| ExpressionSet         | ContextDefinition    | ESDV                 | version | as-found   |
| --------------------- | -------------------- | -------------------- | ------- | ---------- |
| `Medical`             | InsuranceDynamicTest | `9QBAAC000000yUQ4BY` | v1      | **Active** |
| `AutoSilverNew`       | InsuranceDynamicTest | `9QBAAC0000019654BA` | v1      | Inactive   |
| `Auto_Silver`         | InsuranceDynamicTest | `9QBAAC000000yUi4BI` | v1      | Inactive   |
| `Commercial`          | InsuranceDynamicTest | `9QBAAC000000yUR4BY` | v1      | Inactive   |
| `Commercial_VERIFY01` | InsuranceDynamicTest | `9QBAAC0000012cT4BQ` | v1      | Inactive   |
| `surcharge_rules`     | InsuranceDynamicTest | `9QBAAC0000012Sn4BI` | v1      | Inactive   |
| `uw_rules`            | InsuranceDynamicTest | `9QBAAC0000012Xd4BI` | v1      | Inactive   |
| `UWRules`             | InsuranceDynamicTest | `9QBAAC0000012UP4BY` | v1      | Inactive   |

The other 28: `DefaultPricing` ×25, `ProductQualification`, `PricingDiscovery`,
`InsuranceClaimProcessing`.

### `condition.type` tally — 17 ProductSurcharge records

All 17 parse, none empty. **`Attribute` ×4, `Tag` ×3, `Field` ×0.** Consistent with every other org
measured. `Field` does not exist; "field-driven" _is_ `type: "Tag"`.

All three Tag conditions are the same shape — and note they are **Currency, not Date**:

```json
{
  "contextTagName": "TotalAmount",
  "operator": "GreaterThan",
  "conditionIndex": 1,
  "attributeName": null,
  "type": "Tag",
  "attributePicklistValueId": null,
  "attributeId": null,
  "dataType": "Currency",
  "values": ["1000"]
}
```

on `Auto_HighRiskTax`, `BodilyInjuryPropertyDamage_HighRiskFee`, `Collision_HighRiskFee`.

### Engine-type split (only visible at v69.0)

6 of 17 are already `RuleEngineType = ConstraintEngine` with a populated `RuleKey`:

| ProductSurcharge                         | RuleKey                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `AutoSilver_HighRiskFee`                 | `SC__autoSilver__HighRiskFee`                      |
| `AutoSilver_MAN_SUR2_PCT1`               | `SC__autoSilver__MAN_SUR2_PCT1`                    |
| `Auto_MAN_SUR1_AMT1`                     | `SC__autoSilver__auto__MAN_SUR1_AMT1`              |
| `BodilyInjuryPropertyDamage_HighRiskFee` | `SC__autoSilver__bipd__HighRiskFee`                |
| `Collision_HighRiskFee`                  | `SC__autoSilver__autoTest__collision__HighRiskFee` |
| `Collision_MAN_SUR2_PCT1`                | `SC__autoSilver__auto__collision__MAN_SUR2_PCT1`   |

All six keys live in **one** model: `AutoSilverNew` (`9QBAAC0000019654BA`, 8,805 bytes, SHA-256
`f67195ec44d142f0099b4f00f3aee25646174352cd367b10f4e6b8b8e20a2e73`).

### `TotalAmount` resolves — option (A) is derivable here

`TotalAmount` **is** a ContextAttribute in this org's own ContextDefinition:
`SalesTransaction.TotalAmount`, `DataType = currency`. So `contextPath = "SalesTransaction.TotalAmount"`.
`SalesTransaction.EndDate` (`date`) and `SalesTransaction.UserProfile` (`string`) are there too.
Derivation confirmed independently of `autosilver`.

Observed live context values on the test quote: `TotalAmount = 11497.044`,
`UserProfile = "System Administrator"`, `EndDate = "2027-07-28"`.

### The CML and the BRE rule definition disagree

`BodilyInjuryPropertyDamage_HighRiskFee` carries the BRE condition `TotalAmount > 1000` (Tag), but
the CML rule for its key is

```
rule(Bodily_Injury_Per_Accident_Limit > 1000, "InsuranceSurchargeRule", "SC__autoSilver__bipd__HighRiskFee", "True");
```

— a **declared, in-type member**, not the tag. A human hand-substituted a different attribute. This
is the same class of divergence as `autosilver`'s commented-out line: where the tag could not be
expressed, a human quietly wrote something else.

---

## 10. The evaluation path (this is what Part I could not find)

Found by reading Core source rather than guessing URLs. Relevant endpoints, all present:

| Purpose                                                            | Endpoint                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Insurance surcharge run**                                        | `POST /connect/insurance/product-surcharges/tax-calculation` `{"quoteId": …}`           |
| Configurator run                                                   | `POST /connect/cpq/configurator/actions/configure` `{transactionId, transactionLineId}` |
| ES simulate (writes `ExpressionSetVersion.LatestSimulationResult`) | `PATCH /connect/omnistudio/evaluation-services/version-definitions/{id}/simulation`     |
| ES evaluate by name                                                | `POST /connect/business-rules/expressionSet/{name}`                                     |
| **CML compile check**                                              | `POST /connect/constraints/cml/validate` — **gated, unusable here**                     |
| Clear model cache                                                  | `DELETE /industries/constraints/clear-constraint-cache`                                 |

`cml/validate` is a real compiler (calls the nearcore Constraints Solver, returns
`{valid, message, validationErrors}`) and would be the ideal instrument, but it returns
`403 FUNCTIONALITY_NOT_ENABLED: [IndustriesConstraintApiFamily]`. Its gate is
`OrgPermissions.SalesforceConfiguratorEngine && (OrgPreferences.AdvancedConfigurator ||
OrgPreferences.RMConstraintStudio) && OrgPermissions.nAccess`, where `nAccess` is the
"Constraint Modelling : Pilot access" org perm. Not settable from the API. **Worth chasing with the
owning team — it would make all of the below a one-line check instead of an afternoon.**

### Writing a ConstraintModel

The blob URL `…/ExpressionSetDefinitionVersion/{id}/ConstraintModel` is **GET-only**
(`405, Allowed are HEAD,GET`). The field is writable **inline, base64-encoded**, on the sObject:

```
PATCH /services/data/v69.0/sobjects/ExpressionSetDefinitionVersion/{id}
{"ConstraintModel": "<base64 of the CML text>"}
```

Passing the raw text inline also returns `204` but **silently corrupts the model** — the platform
base64-decodes it into binary garbage. This happened once here and was restored immediately from
backup. Writes are rejected while the version is active, so the cycle is
deactivate → patch → activate → clear cache.

---

## 11. The instrument

The model is only loaded when its ExpressionSet version is **active**; with `AutoSilverNew`
inactive the surcharge run never touched it. After activating, `tax-calculation` demonstrably
reaches the solver at
`https://test.api.salesforce.com/industries/revenue-constraints-solver/v3/69.0/{deploy,solve}`.

**Fees are useless as an observable.** Setting all 7 `InsuranceSurchargeRule` conditions in the
model to `false` produced a **byte-for-byte identical** pricing tree (root fee `402.194`, collision
`13.44`/`12.24`, BIPD `0`) — CML surcharge results never reach the fee output, because
`bulkUpdateQLIPAAmount` only writes into a pre-existing price-adjustment node and silently drops the
update otherwise. The BIPD `$100` fee is `0` on all 15 quotes in the org regardless of anything.

What does work: **constraint satisfiability, surfaced as an API error.** Insert
`constraint(<EXPR>);` at the root of `type AutoSilver` and run `tax-calculation`:

- `EXPR` ground-true → `201`, `errors: []`
- `EXPR` ground-false → `Model 'AutoSilverNew' is invalid: … We couldn't find a solution with the last user selection for the rule FalseConstraint.`
- `EXPR` unresolvable → a **different**, and much more interesting, error (§12)

Calibration, 4/4 as predicted: `constraint(true)` SAT, `constraint(false)` UNSAT, `constraint(1 > 0)`
SAT, `constraint(1 > 2)` UNSAT.

**Limit of the instrument, stated up front.** It only decides _ground_ truth. Data-dependent
expressions are satisfiable in both directions, because `constraint()` is a restriction the solver
may satisfy by _choosing_ a value, not an assertion about hydrated data. Verified three ways:
`UserProfile == "Nobody At All"` → SAT; `UserProfile != "System Administrator"` → SAT;
`auto.maxAutoValue != 120000` → SAT even though the live value is 120000 and the member is
`@(configurable = false)`. So this instrument can prove **resolution**, and cannot prove **binding**.
No accessible endpoint returns per-rule results: `ConfigurationOutput.customRules` is parsed only
server-side in `InsuranceCMLRuleExecutionServiceImpl.parseRuleResults` and is not serialized onto
any Connect output representation. The clause route
(`POST /connect/insurance/product-clauses/eligible-product-clauses`), which would expose `EX__` rule
outcomes as eligible clauses, returns `SF-0019-0001 Found no constraint models` in this org.

---

## 12. Results

All on quote `0Q0AAC0000028r70BA` (`TotalAmount = 11497.044`), model `AutoSilverNew` active,
cache cleared between every variant, model round-trip verified by SHA-256 each time.

| #          | Expression                                                             | Outcome                      | Evidence                                                                                   |
| ---------- | ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| CAL-1      | `constraint(true)`                                                     | SAT                          | `201`, `errors: []`                                                                        |
| CAL-2      | `constraint(false)`                                                    | UNSAT                        | "couldn't find a solution … FalseConstraint"                                               |
| CAL-3      | `constraint(1 > 0)`                                                    | SAT                          | `201`                                                                                      |
| CAL-4      | `constraint(1 > 2)`                                                    | UNSAT                        | "couldn't find a solution"                                                                 |
| **REF-1**  | **`constraint(TotalAmount > 1000)` — bare, undeclared (variant i)**    | **DEPLOY FAILS**             | `line 56:15 Couldn't find attribute 'TotalAmount' in AutoSilver`                           |
| REF-4      | `constraint(TotallyMadeUpName123 > 1000)`                              | DEPLOY FAILS                 | same class of error                                                                        |
| **REF-2**  | **`extern` + `constraint(TotalAmount > 1000)` (variant ii)**           | **SAT — deploys, evaluates** | `201`, `errors: []`                                                                        |
| REF-2b     | `extern` + `constraint(TotalAmount > 100000)`                          | SAT                          | value not bound — see caveat                                                               |
| **REF-3b** | **`constraint("TotalAmount" > 1000)`**                                 | **DEPLOY FAILS**             | `Operator greatThan is not supported between GenericConst(TotalAmount) and IntConst(1000)` |
| **REF-3c** | **`constraint("TotalAmount" == "1000")` (variant iii, faithful form)** | **UNSAT — constant false**   | "couldn't find a solution"                                                                 |

### (i) bare undeclared reference — worse than "does not fire"

`Couldn't find attribute 'TotalAmount' in AutoSilver`. The solver **refuses to deploy the model**.
This is not one rule quietly evaluating false: the whole model is rejected, so _every_ rule in it —
all 7 surcharge rules, all 10 exclusion rules, every constraint — stops working, and the calling
API returns a 500-class error to the caller. `REF-4` with a nonsense identifier fails identically,
confirming undeclared names are a hard resolution error rather than implicitly-free variables.

**This is the finding that most changes the picture.** Part I §4 concluded "the platform never
validates". That is true of _import_ and _activation_, but **not** of execution: the solver's
`deploy` step is a real compile gate. It just fires at first use, in production, and takes the whole
model with it.

### (ii) `extern` + `@(contextPath = …, attributeSource = "ST")` — resolves, and that is the whole difference

Same expression, same quote, same everything, plus

```
@(contextPath = "SalesTransaction.TotalAmount", attributeSource = "ST")
extern decimal(2) TotalAmount;
```

→ the model deploys and evaluates, `201`, `errors: []`. `extern` is what makes the reference legal.

**Caveat, and it matters.** `REF-2b` shows `constraint(TotalAmount > 100000)` is _also_ SAT even
though the live value is `11497.044`. That is the instrument's known limit (§11) — `constraint()`
lets the solver pick a value — so this run does **not** prove the extern binds to
`Quote.TotalAmount`. It proves resolution, not hydration.

### (iii) quoted-identifier workaround — constant-false, confirmed

`"TotalAmount" == "1000"` deploys and is **unconditionally false** (UNSAT). The `>` form doesn't
even deploy, and the error names the left operand `GenericConst(TotalAmount)` — the compiler's own
word for "this is a string constant, not your attribute". The human workaround does exactly what was
assumed: it silences the error by making the rule never fire.

---

## 13. The date literal: the converter is RIGHT (§5 risk refuted)

Tested on the same instrument:

| Expression                 | Result    | Under _date_ semantics | Under _arithmetic_ (`2026-12-31` = 1983) |
| -------------------------- | --------- | ---------------------- | ---------------------------------------- |
| `2026-12-31 == 2026-12-31` | SAT       | true ✓                 | true ✓                                   |
| `2026-12-31 == 2026-12-30` | UNSAT     | false ✓                | `1983 == 1984` false ✓                   |
| `2026-12-31 == 1983`       | **UNSAT** | false ✓                | **true ✗**                               |
| `2026-12-31 == 1984`       | UNSAT     | false ✓                | false ✓                                  |
| `2026-12-31 > 2020-01-01`  | **SAT**   | true ✓                 | **`1983 > 2018` false ✗**                |
| `2020-01-01 > 2026-12-31`  | UNSAT     | false ✓                | `2018 > 1983` true ✗                     |

Two rows independently kill the arithmetic reading, and all six are consistent with a genuine date
literal that orders correctly. **An unquoted `2026-12-31` is parsed as a date.** The converter's
`emitsUnquoted` path for `DATE` is correct and needs no change. §5's "silently wrong comparison"
risk is refuted for `DATE`. (`DATETIME` was not tested.)

---

## 14. `attributeSource` — it is not validated at all

With the reference otherwise identical, every one of these deploys and evaluates cleanly:

| Variant                                                                             | Result |
| ----------------------------------------------------------------------------------- | ------ |
| `@(contextPath = "SalesTransaction.TotalAmount", attributeSource = "ST")`           | SAT    |
| `@(contextPath = "SalesTransaction.TotalAmount")` — **omitted**                     | SAT    |
| `attributeSource = "XX"` — nonsense                                                 | SAT    |
| `attributeSource = "STI"`                                                           | SAT    |
| `@(contextPath = "NoSuchNode.NoSuchAttr", attributeSource = "ST")` — **bogus path** | SAT    |
| `extern decimal(2) TotalAmount;` — **no annotation whatsoever**                     | SAT    |

So: the **declaration** is what satisfies the resolver; the **annotation is not checked** by the
solver's deploy or solve. Two consequences.

1. The `attributeSource` enumeration still cannot be pinned down — but the question is less urgent
   than it looked, because a wrong value is not rejected. Keep `"ST"`; it is the only value with
   provenance.
2. **A wrong `contextPath` compiles.** An `extern` pointing at a nonexistent node deploys happily,
   which means option (A) can produce a rule that is legal, active, and bound to nothing — exactly
   the silent-wrongness we were trying to eliminate, just moved one level down. The converter must
   therefore _resolve_ `contextTagName` against the ContextDefinition and refuse to emit when it
   does not resolve. It cannot lean on the platform to catch a bad path.

---

## 15. What this means for the options in §5

- **Option (B) — the blocking dangling-reference gate — is now clearly the top priority, and its
  justification is much stronger than "the rule won't fire".** Today's converter output takes the
  _entire model_ down at solver deploy. One unresolvable tag in one surcharge rule disables every
  rule in that ExpressionSet and returns a 500 from the surcharge API. The existing check already
  computes the right warning and then places the rule anyway.
- **Option (A) is confirmed as the mechanism that makes the reference legal** — `extern` is exactly
  the difference between "model rejected" and "model runs". But §14 means (A) is only safe with a
  real ContextDefinition resolver behind it; an unresolved-but-emitted `extern` is legal CML bound to
  nothing.
- The `sanitizeName`-must-not-be-relied-on-to-match conclusion stands and is sharpened: a mismatch is
  not a rule that quietly does nothing, it is a broken model.
- The date-literal work item is closed (§13). No change needed.

**Still unproven:** that an `extern`-declared value is _hydrated from the Salesforce field at
evaluation time_. Everything here is about resolution. Proving hydration needs an observable of
actual rule output — realistically either the `cml/validate` pilot perm plus a per-rule result API,
or the underwriting invoke endpoint
(`POST /connect/insurance/underwriting-rules/invoke`, whose response _does_ carry
`ruleSetResult[].ruleResult[].{ruleApiName, isSuccess}`) driven from a `UW__` rule. That is the
cleanest next experiment and it is a much smaller job than this one was.

---

## 16. Org state — `sdb38-ins`

Everything was scoped to the single ExpressionSetDefinitionVersion `9QBAAC0000019654BA`
(`AutoSilverNew_V1`). No other model was touched.

- **Backed up before any write:** 8,805 bytes, SHA-256
  `f67195ec44d142f0099b4f00f3aee25646174352cd367b10f4e6b8b8e20a2e73`, at
  `/tmp/sdb38/backup/BACKUP-AutoSilverNew-9QBAAC0000019654BA.cml` (chmod 444), alongside
  `/tmp/sdb38/backup/ORIGINAL-STATE.json` recording activation state of all 8 constraint versions.
- **Written during the test:** the `ConstraintModel` blob (~20 successive variants) and
  `ExpressionSetVersion.IsActive` toggling on `9QMAAC000001bS94BI`.
- One accident: a raw-text inline write corrupted the model to 3,431 bytes of binary. Detected on
  the very next read and restored from backup in the same step.
- **RESTORED and verified.** Final state: ConstraintModel 8,805 bytes, SHA-256
  `f67195ec44d1…a2e73` — **byte-identical** to the backup (no trailing-newline drift this time);
  `ExpressionSetDefinitionVersion.Status = Inactive`; `ExpressionSetVersion.IsActive = false`. All
  three match the recorded original exactly. Post-restore `tax-calculation` on the test quote
  reproduces the as-found behaviour (BIPD fee `0`, `errors: []`).
- **No `ProductSurcharge` record was written** — most recent `LastModifiedDate` across all 17 is
  `2026-07-24`, predating this work. No `Surcharge`, `Quote`, `QuoteLineItem`, `ContextDefinition`
  or org-setting record was modified. No records created or deleted.
