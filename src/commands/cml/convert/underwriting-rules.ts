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
import { Messages } from '@salesforce/core';
import { ParsedRuleDefinition, RecordUpdate, RuleKeyEntry, RuleRecord } from '../../../shared/insurance/models.js';
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

  /**
   * Pure transform — the file-only successor to the old live updateOrgRecords. Produces the exact
   * org-record changes convert previously applied: (1) each UnderwritingRuleGroup flipped to
   * RuleEngineType=ConstraintEngine, then (2) each BRE UnderwritingRule's DynamicRuleDefinition blob
   * rewritten with the converted ruleKey (and the nested underwritingRuleGroup.ruleEngineType, when
   * present). Groups are emitted first so a faithful apply mirrors the original ordering. The blob
   * rewrite uses a RAW JSON.parse of the org's stored value (NOT decodeHtmlEntities) — byte-for-byte
   * the same mutation the live path performed.
   */
  protected buildRecordUpdates(records: UnderwritingRuleRecord[], ruleKeyMapping: RuleKeyEntry[]): RecordUpdate[] {
    const updates: RecordUpdate[] = [];

    // (1) UnderwritingRuleGroup flips — union of every referenced group, name resolved from the
    // queried relationship so the apply-time identity guard has something to cross-check.
    const groupNames = new Map<string, string | null>();
    for (const record of records) {
      if (record.UnderwritingRuleGroupId) {
        groupNames.set(record.UnderwritingRuleGroupId, record.UnderwritingRuleGroup?.Name ?? null);
      }
    }
    for (const [groupId, groupName] of groupNames) {
      if (!groupName) {
        // Without a Name the apply can't run its identity guard; skip rather than write blind.
        this.warn(`Skipping UnderwritingRuleGroup ${groupId}: no Name resolved (cannot verify identity on apply)`);
        continue;
      }
      updates.push({
        sobject: 'UnderwritingRuleGroup',
        id: groupId,
        name: groupName,
        fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
      });
    }

    // (2) UnderwritingRule DynamicRuleDefinition rewrites — same subset and same mutation as live.
    const ruleKeyMap = new Map(ruleKeyMapping.map((m) => [m.recordId, m.ruleKey]));
    const breRecords = records.filter((r) => !r.RuleKey && r.DynamicRuleDefinition);
    for (const record of breRecords) {
      const ruleKey = ruleKeyMap.get(record.Id);
      if (!ruleKey || !record.DynamicRuleDefinition) continue;

      try {
        const defn = JSON.parse(record.DynamicRuleDefinition) as Record<string, unknown>;
        defn.ruleKey = ruleKey;
        if (defn.underwritingRuleGroup && typeof defn.underwritingRuleGroup === 'object') {
          (defn.underwritingRuleGroup as Record<string, unknown>).ruleEngineType = 'ConstraintEngine';
        }
        updates.push({
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

    return updates;
  }
}
