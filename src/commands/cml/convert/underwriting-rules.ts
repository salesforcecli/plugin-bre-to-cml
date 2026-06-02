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
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.convert.underwriting-rules');

type UnderwritingRuleRecord = RuleRecord & {
  ApiName: string | null;
  DynamicRuleDefinition: string | null;
  RuleKey: string | null;
  UnderwritingRuleGroupId: string | null;
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
    'SELECT Id, Name, ApiName, DynamicRuleDefinition, ProductPath, RuleKey, UnderwritingRuleGroupId FROM UnderwritingRule WHERE RuleKey = null';

  public async run(): Promise<CmlConvertUnderwritingRulesResult> {
    const { flags } = await this.parse(CmlConvertUnderwritingRules);
    return this.runConvert({
      targetOrg: flags['target-org'],
      apiVersion: flags['api-version'],
      cmlApi: flags['cml-api'],
      workspaceDir: flags['workspace-dir'],
      inputFile: flags['uw-file'],
      updateRecords: flags['update-records'],
    });
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

  protected async updateOrgRecords(
    records: UnderwritingRuleRecord[],
    ruleKeyMapping: RuleKeyEntry[],
    conn: Connection
  ): Promise<void> {
    const groupIds = new Set<string>();
    for (const record of records) {
      if (record.UnderwritingRuleGroupId) {
        groupIds.add(record.UnderwritingRuleGroupId);
      }
    }

    if (groupIds.size > 0) {
      this.log(`\nUpdating ${groupIds.size} UnderwritingRuleGroup records with RuleEngineType=ConstraintEngine...`);
      const groupUpdates = Array.from(groupIds).map((id) => ({
        Id: id,
        RuleEngineType: 'ConstraintEngine',
      }));
      const groupResults = await conn.sobject('UnderwritingRuleGroup').update(groupUpdates);
      const groupList = Array.isArray(groupResults) ? groupResults : [groupResults];
      const groupSuccesses = groupList.filter((r) => r.success);
      const groupFailures = groupList.filter((r) => !r.success);
      this.log(`  Updated ${groupSuccesses.length} group records`);
      for (const f of groupFailures) {
        this.warn(`  Failed to update group ${f.id ?? 'unknown'}: ${JSON.stringify(f.errors)}`);
      }
    }

    const ruleKeyMap = new Map(ruleKeyMapping.map((m) => [m.recordId, m.ruleKey]));
    const breRecords = records.filter((r) => !r.RuleKey && r.DynamicRuleDefinition);

    if (breRecords.length === 0) {
      this.log('\nNo BRE rules to update with RuleKey.');
      return;
    }

    this.log(
      `\nUpdating ${breRecords.length} UnderwritingRule DynamicRuleDefinition with ruleKey and ruleEngineType...`
    );
    let successCount = 0;
    let failCount = 0;

    const updates: Array<{ Id: string; DynamicRuleDefinition: string }> = [];
    for (const record of breRecords) {
      const ruleKey = ruleKeyMap.get(record.Id);
      if (!ruleKey || !record.DynamicRuleDefinition) continue;

      try {
        const defn = JSON.parse(record.DynamicRuleDefinition) as Record<string, unknown>;
        defn.ruleKey = ruleKey;
        if (defn.underwritingRuleGroup && typeof defn.underwritingRuleGroup === 'object') {
          (defn.underwritingRuleGroup as Record<string, unknown>).ruleEngineType = 'ConstraintEngine';
        }
        updates.push({ Id: record.Id, DynamicRuleDefinition: JSON.stringify(defn) });
      } catch {
        this.warn(`  Failed to parse DynamicRuleDefinition for ${record.Name}`);
        failCount++;
      }
    }

    if (updates.length > 0) {
      const results = await conn.sobject('UnderwritingRule').update(updates);
      for (const r of Array.isArray(results) ? results : [results]) {
        if (r.success) {
          successCount++;
        } else {
          failCount++;
          this.warn(`  Failed to update ${r.id ?? 'unknown'}: ${JSON.stringify(r.errors)}`);
        }
      }
    }

    this.log(`  Updated ${successCount} rule records, ${failCount} failed`);
  }
}
