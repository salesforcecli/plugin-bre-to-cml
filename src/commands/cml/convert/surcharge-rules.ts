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
  InsuranceRuleConvertResult,
} from '../../../shared/insurance/insurance-rule-convert-command.js';
import { decodeHtmlEntities } from '../../../shared/insurance/insurance-rule-generator.js';

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
    });
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
