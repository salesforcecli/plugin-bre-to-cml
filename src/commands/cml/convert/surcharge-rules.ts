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
import { ParsedRuleDefinition, RuleKeyEntry, RuleRecord } from '../../../shared/insurance/models.js';
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
    ctx: InsuranceRuleConvertContext,
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
      for (const segment of record.ProductPath.split('/')) {
        const id = segment.trim();
        if (id) productIds.add(id);
      }
    }
    const productIdToType = await fetchProductTypeTags(conn, productIds);

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

    const ruleKeyMapping: RuleKeyEntry[] = placements.map((p) => ({
      recordId: p.rule.recordId,
      name: p.rule.recordName,
      ruleKey: p.rule.ruleKey,
    }));

    if (ctx.updateRecords) {
      await this.updateOrgRecords(records, ruleKeyMapping, conn);
    }

    return this.writeMergedOutputFiles(mergedCml, ruleKeyMapping, safeApi, workspaceDir, api);
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

  protected async updateOrgRecords(
    _records: ProductSurchargeRecord[],
    ruleKeyMapping: RuleKeyEntry[],
    conn: Connection
  ): Promise<void> {
    this.log('\nUpdating ProductSurcharge records with RuleEngineType=ConstraintEngine...');
    const updates = ruleKeyMapping.map((m) => ({
      Id: m.recordId,
      RuleEngineType: 'ConstraintEngine',
    }));
    const results = await conn.sobject('ProductSurcharge').update(updates);
    const list = Array.isArray(results) ? results : [results];
    const successes = list.filter((r) => r.success);
    const failures = list.filter((r) => !r.success);
    this.log(`  Updated ${successes.length} records successfully`);
    for (const f of failures) {
      this.warn(`  Failed to update ${f.id ?? 'unknown'}: ${JSON.stringify(f.errors)}`);
    }
  }
}
