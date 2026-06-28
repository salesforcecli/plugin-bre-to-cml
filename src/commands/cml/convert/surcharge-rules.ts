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
  buildPathedSurchargeRules,
  fetchExistingConstraintModel,
  fetchProductTypeTags,
  mergeSurchargeRules,
  splitProductPath,
} from '../../../shared/insurance/insurance-cml-merge.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.convert.surcharge-rules');

type ProductSurchargeRecord = RuleRecord & {
  RuleDefinition: string | null;
};

export type CmlConvertSurchargeRulesResult = InsuranceRuleConvertResult;

// eslint-disable-next-line sf-plugin/only-extend-SfCommand
export default class CmlConvertSurchargeRules extends InsuranceRuleConvertCommand<ProductSurchargeRecord> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    ...InsuranceRuleConvertCommand.flags,
    'surcharge-file': Flags.file({
      summary: messages.getMessage('flags.surcharge-file.summary'),
      char: 'f',
      exists: true,
    }),
  };

  protected readonly recordLabel = 'ProductSurcharge';
  protected readonly keyPrefix = 'SC';
  protected readonly constraintLabel = 'Surcharge eligibility';
  protected readonly apiNamePrefix = 'SC_';
  // Emit surcharge eligibility as a CML `rule(decl, "InsuranceSurchargeRule", "<ruleKey>", "True")`.
  protected readonly ruleType = 'InsuranceSurchargeRule';
  protected readonly soql =
    'SELECT Id, Name, RuleDefinition, ProductPath FROM ProductSurcharge WHERE RuleApiName != null';
  protected readonly recordUpdateKind = 'surcharge-update' as const;

  // Populated during runMergeConvert (the only place the ProductPath→ProductCode mapping is known)
  // and consumed by buildRecordUpdates, which the base calls to serialize the update file. Maps a
  // ProductSurcharge Id to its ordered ProductCode path — advisory drift-detection for the apply.
  private readonly surchargeProductCodes = new Map<string, string[]>();

  public async run(): Promise<CmlConvertSurchargeRulesResult> {
    const { flags } = await this.parse(CmlConvertSurchargeRules);
    return this.runConvert({
      targetOrg: flags['target-org'],
      apiVersion: flags['api-version'],
      cmlApi: flags['cml-api'],
      workspaceDir: flags['workspace-dir'],
      inputFile: flags['surcharge-file'],
      updateRecords: flags['update-records'],
      // Surcharge conversion ALWAYS merges into the org's existing curated ConstraintModel —
      // the flat-overwrite build path is intentionally unreachable here (it silently drops nested
      // surcharges via non-pathed rule keys). There is no flag to opt out.
      mergeWithOrg: true,
    });
  }

  /**
   * Merge mode: read the org's existing ConstraintModel, compute each surcharge's pathed rule key
   * (matching the platform's auto-generated RuleKey), and nest the `rule(...)` statement into the
   * correct existing leaf `type` block — instead of overwriting the curated model with a flat one.
   */
  protected async runMergeConvert(
    _ctx: InsuranceRuleConvertContext,
    conn: Connection,
    records: ProductSurchargeRecord[],
    ruleDefs: ParsedRuleEntry[],
    productIdToCode: Map<string, string>,
    api: string,
    safeApi: string,
    workspaceDir: string
  ): Promise<InsuranceRuleConvertResult> {
    const existing = await fetchExistingConstraintModel(conn, api);
    if (!existing?.cmlText.trim()) {
      this.error(
        `surcharge-rules merges into an existing ConstraintModel for CML API '${api}', but none was found. Create the curated model first (e.g. via the underwriting/prod-cfg converters or by importing a baseline), then re-run this command.`
      );
    }

    const productIds = new Set<string>();
    for (const { record } of ruleDefs) {
      // [Fix #11] Route every ProductPath parse through one helper so trim + drop-empty semantics
      // never diverge between the convert layer and the merge module.
      for (const id of splitProductPath(record.ProductPath)) productIds.add(id);
    }
    const productIdToType = await fetchProductTypeTags(conn, productIds);

    // Capture the ProductCode path per surcharge so the emitted update file can carry it (same
    // mapping buildPathedSurchargeRules uses for the rule key). Drift here would desync the platform
    // RuleKey, so it is recorded for the apply-time check rather than discarded.
    this.surchargeProductCodes.clear();
    for (const { record } of ruleDefs) {
      // [Fix #11] Same single helper.
      const codes = splitProductPath(record.ProductPath).map((id) => productIdToCode.get(id) ?? id);
      this.surchargeProductCodes.set(record.Id, codes);
    }

    const rules = buildPathedSurchargeRules(this.keyPrefix, ruleDefs, productIdToCode, productIdToType);
    rules.forEach((r) => this.log(`  -> ${r.recordName} => ${r.ruleKey} (type: ${r.typeName ?? 'UNRESOLVED'})`));

    const { mergedCml, placements, skips, attributeWarnings } = mergeSurchargeRules(existing.cmlText, rules);

    this.log(
      `\nMerge summary: ${placements.filter((p) => p.status === 'inserted').length} inserted, ${
        placements.filter((p) => p.status === 'replaced').length
      } updated in place, ${skips.length} skipped.`
    );
    for (const s of skips) this.warn(`  SKIPPED ${s.rule.recordName}: ${s.reason}`);
    for (const w of attributeWarnings) this.warn(`  ATTRIBUTE ${w}`);

    // [Fix #9] When skips are present, log a high-signal final summary that buckets reasons —
    // an operator scanning hundreds of per-rule warnings should not have to grep to learn whether
    // they're staring at one duplicate or fifty missing-type-tag rules. Buckets match the merge
    // module's skip-reason vocabulary; anything that doesn't match a known reason falls into "other".
    if (skips.length > 0) {
      const counts = { duplicate: 0, emptyPath: 0, noTypeTag: 0, typeBlockMissing: 0, typeBlockAmbiguous: 0, other: 0 };
      for (const s of skips) {
        if (s.reason.startsWith('duplicate pathed rule key')) counts.duplicate += 1;
        else if (s.reason.startsWith('empty ProductPath')) counts.emptyPath += 1;
        else if (s.reason.startsWith('no CML type tag')) counts.noTypeTag += 1;
        else if (s.reason.includes('not found in existing model')) counts.typeBlockMissing += 1;
        else if (s.reason.includes('is ambiguous')) counts.typeBlockAmbiguous += 1;
        else counts.other += 1;
      }
      this.log(
        `Skip breakdown: ${counts.duplicate} duplicate-key, ${counts.emptyPath} empty-ProductPath, ` +
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

  protected parseRecord(record: ProductSurchargeRecord): ParsedRuleDefinition | null {
    if (!record.RuleDefinition) {
      this.warn(`Skipping ${record.Name}: no RuleDefinition`);
      return null;
    }
    try {
      const raw = JSON.parse(decodeHtmlEntities(record.RuleDefinition)) as {
        ruleApiName?: string;
        ruleCriteria?: unknown[];
      };
      return {
        ...raw,
        name: record.Name,
        apiName: raw.ruleApiName ?? record.Name,
        productPath: record.ProductPath,
      } as ParsedRuleDefinition;
    } catch {
      this.warn(`Failed to parse RuleDefinition for ${record.Name}`);
      return null;
    }
  }

  /**
   * Pure transform — the file-only successor to the old live updateOrgRecords. Mirrors it exactly:
   * one ProductSurcharge per placed rule, flipping RuleEngineType to ConstraintEngine. The
   * expectedRuleKey (the convert-computed pathed key) and productCodes are advisory — they are NOT
   * written to the org (the platform regenerates ProductSurcharge.RuleKey on the flip); the apply
   * uses them to verify the surcharge will actually fire and to flag ProductCode/ProductPath drift.
   */
  protected buildRecordUpdates(_records: ProductSurchargeRecord[], ruleKeyMapping: RuleKeyEntry[]): RecordUpdate[] {
    return ruleKeyMapping.map((m) => ({
      sobject: 'ProductSurcharge',
      id: m.recordId,
      name: m.name,
      fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
      expectedRuleKey: m.ruleKey,
      productCodes: this.surchargeProductCodes.get(m.recordId),
    }));
  }
}
