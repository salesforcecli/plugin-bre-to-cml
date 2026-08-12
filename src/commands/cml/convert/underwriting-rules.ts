/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Flags } from '@salesforce/sf-plugins-core';
import { Connection, Messages } from '@salesforce/core';
import { ParsedRuleDefinition, RecordUpdate, RuleKeyEntry, RuleRecord } from '../../../shared/insurance/models.js';
import {
  InsuranceRuleConvertCommand,
  InsuranceRuleConvertContext,
  InsuranceRuleConvertResult,
  ParsedRuleEntry,
} from '../../../shared/insurance/insurance-rule-convert-command.js';
import { decodeHtmlEntities } from '../../../shared/insurance/insurance-rule-generator.js';
import {
  buildUnderwritingConstraintRules,
  fetchExistingConstraintModel,
  fetchProductTypeTags,
  mergeUnderwritingConstraints,
  splitProductPath,
} from '../../../shared/insurance/insurance-cml-merge.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.convert.underwriting-rules');

type UnderwritingRuleRecord = RuleRecord & {
  ApiName: string | null;
  DynamicRuleDefinition: string | null;
  RuleKey: string | null;
  UnderwritingRuleGroupId: string | null;
  // Nested via the UnderwritingRuleGroup relationship so we can stamp the group's Name into the
  // record-update file as an apply-time identity guard (we never write to a group blind by Id).
  UnderwritingRuleGroup: { Name: string | null } | null;
};

export type CmlConvertUnderwritingRulesResult = InsuranceRuleConvertResult;

// eslint-disable-next-line sf-plugin/only-extend-SfCommand
export default class CmlConvertUnderwritingRules extends InsuranceRuleConvertCommand<UnderwritingRuleRecord> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    ...InsuranceRuleConvertCommand.flags,
    'uw-file': Flags.file({
      summary: messages.getMessage('flags.uw-file.summary'),
      char: 'f',
      exists: true,
    }),
  };

  protected readonly recordLabel = 'UnderwritingRule';
  protected readonly keyPrefix = 'UW';
  protected readonly constraintLabel = 'Underwriting eligibility';
  protected readonly apiNamePrefix = 'UW_';
  // DynamicRuleDefinition is a non-filterable (long text) field, so it can't appear in the
  // WHERE clause; records with a null DynamicRuleDefinition are skipped during parsing instead.
  protected readonly soql =
    'SELECT Id, Name, ApiName, DynamicRuleDefinition, ProductPath, RuleKey, UnderwritingRuleGroupId, UnderwritingRuleGroup.Name FROM UnderwritingRule WHERE RuleKey = null';
  protected readonly recordUpdateKind = 'underwriting-update' as const;

  public async run(): Promise<CmlConvertUnderwritingRulesResult> {
    const { flags } = await this.parse(CmlConvertUnderwritingRules);
    return this.runConvert({
      targetOrg: flags['target-org'],
      apiVersion: flags['api-version'],
      cmlApi: flags['cml-api'],
      workspaceDir: flags['workspace-dir'],
      inputFile: flags['uw-file'],
      updateRecords: flags['update-records'],
      // Underwriting conversion ALWAYS merges into the org's existing curated ConstraintModel —
      // mirrors surcharge-rules.ts: the flat-overwrite build path is intentionally unreachable
      // here (it silently drops nested underwriting constraints). There is no flag to opt out.
      mergeWithOrg: true,
    });
  }

  /**
   * Merge mode: read the org's existing ConstraintModel, compute each underwriting rule's pathed
   * rule key (matching the platform's auto-generated RuleKey) and sanitized constraint name, and
   * nest the `constraint <name> = (...)` statement into the correct existing leaf `type` block —
   * instead of overwriting the curated model with a flat one. Mirrors CmlConvertSurchargeRules'
   * runMergeConvert override.
   */
  protected async runMergeConvert(
    _ctx: InsuranceRuleConvertContext,
    conn: Connection,
    records: UnderwritingRuleRecord[],
    ruleDefs: ParsedRuleEntry[],
    productIdToCode: Map<string, string>,
    api: string,
    safeApi: string,
    workspaceDir: string
  ): Promise<InsuranceRuleConvertResult> {
    const existing = await fetchExistingConstraintModel(conn, api);
    if (!existing?.cmlText.trim()) {
      this.error(
        `underwriting-rules merges into an existing ConstraintModel for CML API '${api}', but none was found. Create the curated model first (e.g. via the prod-cfg converter or by importing a baseline), then re-run this command.`
      );
    }

    const productIds = new Set<string>();
    for (const { record } of ruleDefs) {
      for (const id of splitProductPath(record.ProductPath)) productIds.add(id);
    }
    const productIdToType = await fetchProductTypeTags(conn, productIds);

    const rules = buildUnderwritingConstraintRules(
      this.keyPrefix,
      this.constraintLabel,
      ruleDefs,
      productIdToCode,
      productIdToType,
      this.attributeDataTypes
    );
    rules.forEach((r) => this.log(`  -> ${r.recordName} => ${r.constraintName} (type: ${r.typeName ?? 'UNRESOLVED'})`));

    const { mergedCml, placements, skips, attributeWarnings } = mergeUnderwritingConstraints(existing.cmlText, rules);

    this.log(
      `\nMerge summary: ${placements.filter((p) => p.status === 'inserted').length} inserted, ${
        placements.filter((p) => p.status === 'replaced').length
      } updated in place, ${skips.length} skipped.`
    );
    for (const s of skips) this.warn(`  SKIPPED ${s.rule.recordName}: ${s.reason}`);
    for (const w of attributeWarnings) this.warn(`  ATTRIBUTE ${w}`);

    // Mirrors surcharge-rules.ts' bucketed skip summary — same reason-vocabulary buckets, adapted
    // to underwriting's skip-reason vocabulary (no separate "duplicate pathed rule key" reason;
    // instead a duplicate constraint-name-in-type collision).
    if (skips.length > 0) {
      const counts = {
        duplicateConstraint: 0,
        emptyPath: 0,
        noTypeTag: 0,
        typeBlockMissing: 0,
        typeBlockAmbiguous: 0,
        other: 0,
      };
      for (const s of skips) {
        if (s.reason.startsWith('duplicate constraint name')) counts.duplicateConstraint += 1;
        else if (s.reason.startsWith('empty ProductPath')) counts.emptyPath += 1;
        else if (s.reason.startsWith('no CML type tag')) counts.noTypeTag += 1;
        else if (s.reason.includes('not found in existing model')) counts.typeBlockMissing += 1;
        else if (s.reason.includes('is ambiguous')) counts.typeBlockAmbiguous += 1;
        else counts.other += 1;
      }
      this.log(
        `Skip breakdown: ${counts.duplicateConstraint} duplicate-constraint-name, ${counts.emptyPath} empty-ProductPath, ` +
          `${counts.noTypeTag} no-type-tag, ${counts.typeBlockMissing} type-block-missing, ` +
          `${counts.typeBlockAmbiguous} type-block-ambiguous, ${counts.other} other`
      );
    }

    const ruleKeyMapping: RuleKeyEntry[] = placements.map((p) => ({
      recordId: p.rule.recordId,
      name: p.rule.recordName,
      ruleKey: p.rule.ruleKey,
    }));

    const recordUpdateFile = await this.writeRecordUpdateFile(records, ruleKeyMapping, api, safeApi, workspaceDir);

    return this.writeMergedOutputFiles(mergedCml, ruleKeyMapping, safeApi, workspaceDir, api, recordUpdateFile);
  }

  protected parseRecord(record: UnderwritingRuleRecord): ParsedRuleDefinition | null {
    if (!record.DynamicRuleDefinition) {
      this.warn(`Skipping ${record.Name}: no DynamicRuleDefinition`);
      return null;
    }
    try {
      const raw = JSON.parse(decodeHtmlEntities(record.DynamicRuleDefinition)) as {
        apiName?: string;
        name?: string;
        status?: string;
        description?: string;
        productPath?: string;
        ruleCriteria?: unknown[];
      };
      return {
        ...raw,
        name: raw.name ?? record.Name,
        apiName: raw.apiName ?? record.ApiName ?? record.Name,
        productPath: raw.productPath ?? record.ProductPath,
      } as ParsedRuleDefinition;
    } catch {
      this.warn(`Failed to parse DynamicRuleDefinition for ${record.Name}`);
      return null;
    }
  }

  /**
   * Pure transform — the file-only successor to the old live updateOrgRecords. Produces the exact
   * org-record changes convert previously applied: (1) each UnderwritingRuleGroup flipped to
   * RuleEngineType=ConstraintEngine, then (2) each BRE UnderwritingRule's DynamicRuleDefinition blob
   * rewritten with the converted ruleKey (and, only when this plan also flips that rule's group, the
   * nested underwritingRuleGroup.ruleEngineType). Groups are emitted first so a faithful apply
   * mirrors the original ordering, and so step (2) can read back which groups step (1) flipped. The blob
   * rewrite uses a RAW JSON.parse of the org's stored value (NOT decodeHtmlEntities) — byte-for-byte
   * the same mutation the live path performed.
   *
   * `ruleKeyMapping` is the authoritative "landed in the CML" set: runMergeConvert builds it from
   * the merge's `placements` (inserted + replaced) only, so every skipped rule is absent from it.
   */
  protected buildRecordUpdates(records: UnderwritingRuleRecord[], ruleKeyMapping: RuleKeyEntry[]): RecordUpdate[] {
    const updates: RecordUpdate[] = [];

    // (1) UnderwritingRuleGroup flips. The flip is the migration's point of no return: once a group
    // is on ConstraintEngine the platform stops evaluating its BRE rules and evaluates the CML
    // constraints instead. So a group may only be flipped when EVERY one of its rules in this run
    // actually landed in the merged CML — deriving the set from all queried records flipped groups
    // whose rules were skipped (blank ProductPath, unresolved type tag, missing/ambiguous type
    // block, duplicate constraint name), silently disabling rules with nothing behind them.
    //
    // Partial groups (some rules placed, some skipped) are withheld too, and warned about. Neither
    // choice is free: withholding leaves the placed constraints inert, flipping disables the
    // skipped rules' logic. Withholding is the safer default because it is recoverable — the org is
    // left exactly as it was, and re-running after fixing the skip reasons flips the group with all
    // its constraints in place. Flipping is not: the disabled rules stop firing immediately, with
    // nothing in the plan or the org to indicate which logic went dark.
    const placedRecordIds = new Set(ruleKeyMapping.map((m) => m.recordId));
    type GroupState = { name: string | null; placed: string[]; unplaced: string[] };
    const groups = new Map<string, GroupState>();
    for (const record of records) {
      const groupId = record.UnderwritingRuleGroupId;
      if (!groupId) continue;
      const state = groups.get(groupId) ?? { name: null, placed: [], unplaced: [] };
      // Name resolved from the queried relationship so the apply-time identity guard has something
      // to cross-check; first non-null wins (the rows of one group should agree on it).
      state.name = state.name ?? record.UnderwritingRuleGroup?.Name ?? null;
      (placedRecordIds.has(record.Id) ? state.placed : state.unplaced).push(record.Name);
      groups.set(groupId, state);
    }

    const withheld: string[] = [];
    for (const [groupId, state] of groups) {
      if (state.placed.length === 0) {
        // Nothing of this group reached the CML. Every one of its rules was already reported as
        // SKIPPED with a reason, so a per-group warning would only repeat that; the count is logged
        // below so the operator can reconcile it against the merge summary.
        withheld.push(groupId);
        continue;
      }
      if (state.unplaced.length > 0) {
        this.warn(
          `Not flipping UnderwritingRuleGroup '${state.name ?? groupId}' (${groupId}): ${
            state.unplaced.length
          } of its ${
            state.placed.length + state.unplaced.length
          } rules were not merged into the CML (${state.unplaced.join(
            ', '
          )}). Flipping it would stop those rules being evaluated with no constraint behind them; instead the converted constraint(s) for ${state.placed.join(
            ', '
          )} stay inert until you fix the skip reasons above and re-run.`
        );
        withheld.push(groupId);
        continue;
      }
      if (!state.name) {
        // Without a Name the apply can't run its identity guard; skip rather than write blind.
        this.warn(`Skipping UnderwritingRuleGroup ${groupId}: no Name resolved (cannot verify identity on apply)`);
        continue;
      }
      updates.push({
        sobject: 'UnderwritingRuleGroup',
        id: groupId,
        name: state.name,
        fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
      });
    }
    if (withheld.length > 0) {
      this.log(
        `Withheld ${
          withheld.length
        } UnderwritingRuleGroup flip(s) whose rules did not all reach the merged CML: ${withheld.join(', ')}`
      );
    }

    // (2) UnderwritingRule DynamicRuleDefinition rewrites — same subset and same mutation as live.
    // The flipped set is read back off the group updates actually pushed above rather than
    // re-derived from the withhold conditions, so all three no-flip paths (zero placed, partial,
    // no Name resolved) are covered by construction and the two decisions cannot drift apart.
    const flippedGroupIds = new Set(updates.filter((u) => u.sobject === 'UnderwritingRuleGroup').map((u) => u.id));
    updates.push(...this.buildBlobRewrites(records, ruleKeyMapping, flippedGroupIds));

    return updates;
  }

  /**
   * Step (2) of the plan: rewrite each placed BRE rule's DynamicRuleDefinition blob. Uses a RAW
   * JSON.parse of the org's stored value (NOT decodeHtmlEntities) and re-stringifies — byte-for-byte
   * the same mutation the old live code path performed; the document is never reformatted or re-keyed.
   *
   * The nested `underwritingRuleGroup.ruleEngineType` is stamped ONLY when this same plan also flips
   * that rule's group record. Setting it unconditionally left the plan internally inconsistent
   * whenever a flip was withheld: the applied blob asserted ConstraintEngine while the group record
   * it belongs to still carried its old RuleEngineType, and nothing in the apply preview surfaces
   * the disagreement. Whether the platform READS the nested copy is not established — the sibling
   * `underwritingRuleGroupId` is null in every stored blob and appears not to be maintained by the
   * platform — so this is a consistency fix, not a known runtime failure. When the group is not
   * flipped the nested value is left exactly as the org stored it: not deleted, not substituted.
   *
   * The `ruleKey` rewrite happens either way — it is what the placed constraint needs, and the
   * reason the record update is still emitted for a withheld group's placed rules at all.
   */
  private buildBlobRewrites(
    records: UnderwritingRuleRecord[],
    ruleKeyMapping: RuleKeyEntry[],
    flippedGroupIds: ReadonlySet<string>
  ): RecordUpdate[] {
    const rewrites: RecordUpdate[] = [];
    const ruleKeyMap = new Map(ruleKeyMapping.map((m) => [m.recordId, m.ruleKey]));
    const breRecords = records.filter((r) => !r.RuleKey && r.DynamicRuleDefinition);

    for (const record of breRecords) {
      const ruleKey = ruleKeyMap.get(record.Id);
      if (!ruleKey || !record.DynamicRuleDefinition) continue;

      const groupIsFlipping = !!record.UnderwritingRuleGroupId && flippedGroupIds.has(record.UnderwritingRuleGroupId);

      try {
        const defn = JSON.parse(record.DynamicRuleDefinition) as Record<string, unknown>;
        defn.ruleKey = ruleKey;
        if (groupIsFlipping && defn.underwritingRuleGroup && typeof defn.underwritingRuleGroup === 'object') {
          (defn.underwritingRuleGroup as Record<string, unknown>).ruleEngineType = 'ConstraintEngine';
        }
        rewrites.push({
          sobject: 'UnderwritingRule',
          id: record.Id,
          name: record.Name,
          apiName: record.ApiName ?? undefined,
          fields: [{ field: 'DynamicRuleDefinition', value: JSON.stringify(defn) }],
        });
      } catch {
        this.warn(`  Failed to parse DynamicRuleDefinition for ${record.Name}`);
      }
    }

    return rewrites;
  }
}
