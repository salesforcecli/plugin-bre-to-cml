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
import * as fs from 'node:fs/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Connection } from '@salesforce/core';
import { CmlModel } from '../../../shared/types/types.js';
import { generateCsvForAssociations } from '../../../shared/utils/association.utils.js';
import { ParsedRuleDefinition, RuleKeyEntry, RuleRecord } from '../../../shared/insurance/models.js';
import { buildCmlModel } from '../../../shared/insurance/insurance-rule-generator.js';
import { discoverCmlApiByProducts, fetchProductCodes } from '../../../shared/insurance/insurance-org.js';

type UnderwritingRuleRecord = RuleRecord & {
  ApiName: string | null;
  DynamicRuleDefinition: string | null;
  Status: string | null;
  Sequence: number | null;
  RuleKey: string | null;
  UnderwritingRuleGroupId: string | null;
};

export type CmlConvertUnderwritingRulesResult = {
  cmlFile: string;
  associationsFile: string;
  ruleKeyMapping: RuleKeyEntry[];
};

export default class CmlConvertUnderwritingRules extends SfCommand<CmlConvertUnderwritingRulesResult> {
  public static readonly summary =
    'Converts BRE-based Insurance Underwriting dynamic rules to CML eligibility constraints.';
  public static readonly description =
    'Reads UnderwritingRule records from the org (or a JSON file), parses their DynamicRuleDefinition, and generates CML constraints that evaluate underwriting eligibility. Each rule becomes a named constraint that returns true/false. The command outputs a .cml file with the constraint model, an _Associations.csv file for ExpressionSetConstraintObj records, and a _RuleKeyMapping.json with the UnderwritingRule ID to RuleKey mapping for updating records.';
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --cml-api UW_CML --target-org myOrg',
    '<%= config.bin %> <%= command.id %> --cml-api UW_CML --uw-file data/underwriting.json --workspace-dir data --target-org myOrg',
  ];

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    'cml-api': Flags.string({
      summary: 'CML API Name. If omitted, auto-discovers an existing CML associated with the same root products.',
      char: 'c',
    }),
    'workspace-dir': Flags.directory({
      summary: 'Directory where output files will be written.',
      char: 'd',
      exists: true,
    }),
    'uw-file': Flags.file({
      summary:
        'Optional JSON file with pre-exported UnderwritingRule records. If omitted, records are queried from the org.',
      char: 'f',
      exists: true,
    }),
    'update-records': Flags.boolean({
      summary:
        'Update UnderwritingRuleGroup.RuleEngineType to ConstraintEngine and write ruleKey into each UnderwritingRule DynamicRuleDefinition.',
      default: false,
    }),
  };

  public async run(): Promise<CmlConvertUnderwritingRulesResult> {
    const { flags } = await this.parse(CmlConvertUnderwritingRules);

    const workspaceDir = flags['workspace-dir'] ?? '.';
    const targetOrg = flags['target-org'];

    const records = await this.loadRecords(flags, targetOrg);
    if (records.length === 0) {
      this.log('No underwriting rules to convert.');
      return { cmlFile: '', associationsFile: '', ruleKeyMapping: [] };
    }

    const ruleDefs = this.parseRuleDefinitions(records);
    const productIdToCode = await this.resolveProductCodes(ruleDefs, targetOrg, flags);

    const api = flags['cml-api'] ?? (await this.discoverCmlApi(ruleDefs, productIdToCode, targetOrg, flags));
    const safeApi = api.replace(/[^a-zA-Z0-9_-]/g, '_');
    const { cmlModel, ruleKeyMapping } = buildCmlModel(ruleDefs, productIdToCode, 'UW', 'Underwriting eligibility');
    ruleKeyMapping.forEach((m) => this.log(`  -> ${m.name} => ${m.ruleKey}`));

    if (flags['update-records']) {
      await this.updateRecordsViaConnectApi(records, ruleKeyMapping, targetOrg, flags);
    }

    return this.writeOutputFiles(cmlModel, ruleKeyMapping, safeApi, workspaceDir, api);
  }

  private async loadRecords(
    flags: Record<string, unknown>,
    targetOrg: { getConnection: (v?: string) => Connection }
  ): Promise<UnderwritingRuleRecord[]> {
    const uwFile = flags['uw-file'] as string | undefined;
    if (uwFile) {
      this.log(`Reading underwriting rules from file: ${uwFile}`);
      const contents = await fs.readFile(uwFile, 'utf8');
      return JSON.parse(contents) as UnderwritingRuleRecord[];
    }

    this.log('Querying UnderwritingRule records from org...');
    const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);
    const result = await conn.query<UnderwritingRuleRecord>(
      'SELECT Id, Name, ApiName, DynamicRuleDefinition, ProductPath, Status, Sequence, RuleKey, UnderwritingRuleGroupId FROM UnderwritingRule'
    );
    this.log(`Found ${result.records.length} UnderwritingRule records with BRE rules`);
    return result.records;
  }

  private parseRuleDefinitions(
    records: UnderwritingRuleRecord[]
  ): Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> {
    const parsed: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> = [];
    for (const record of records) {
      if (!record.DynamicRuleDefinition) {
        this.warn(`Skipping ${record.Name}: no DynamicRuleDefinition`);
        continue;
      }
      try {
        const raw = JSON.parse(record.DynamicRuleDefinition) as {
          apiName?: string;
          name?: string;
          status?: string;
          description?: string;
          productPath?: string;
          ruleCriteria?: unknown[];
        };
        parsed.push({
          record,
          ruleDef: {
            ...raw,
            name: raw.name ?? record.Name,
            apiName: raw.apiName ?? record.ApiName ?? record.Name,
            productPath: raw.productPath ?? record.ProductPath,
          } as ParsedRuleDefinition,
        });
      } catch {
        this.warn(`Failed to parse DynamicRuleDefinition for ${record.Name}`);
      }
    }
    this.log(`Parsed ${parsed.length} valid rule definitions`);
    return parsed;
  }

  private async discoverCmlApi(
    ruleDefs: Array<{ record: RuleRecord }>,
    productIdToCode: Map<string, string>,
    targetOrg: { getConnection: (v?: string) => Connection },
    flags: Record<string, unknown>
  ): Promise<string> {
    const productIds = new Set<string>();
    for (const { record } of ruleDefs) {
      productIds.add(record.ProductPath.split('/')[0]);
    }
    try {
      const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);
      const discovered = await discoverCmlApiByProducts(conn, productIds);
      if (discovered) {
        this.log(`Auto-discovered existing CML API: ${discovered}`);
        return discovered;
      }
    } catch (e) {
      this.warn(`CML auto-discovery failed: ${(e as Error).message}`);
    }

    const codes = Array.from(productIds).map((id) => productIdToCode.get(id) ?? id);
    const generated = `UW_${codes.join('_')}`;
    this.log(`No existing CML found. Generated new CML API name: ${generated}`);
    return generated;
  }

  private async resolveProductCodes(
    ruleDefs: Array<{ record: RuleRecord }>,
    targetOrg: { getConnection: (v?: string) => Connection },
    flags: Record<string, unknown>
  ): Promise<Map<string, string>> {
    const productIds = new Set<string>();
    for (const { record } of ruleDefs) {
      productIds.add(record.ProductPath.split('/')[0]);
    }
    try {
      const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);
      return await fetchProductCodes(conn, productIds);
    } catch (e) {
      this.warn(`Could not fetch product codes: ${(e as Error).message}. Using product IDs instead.`);
      return new Map<string, string>();
    }
  }

  private async updateRecordsViaConnectApi(
    records: UnderwritingRuleRecord[],
    ruleKeyMapping: RuleKeyEntry[],
    targetOrg: { getConnection: (v?: string) => Connection },
    flags: Record<string, unknown>
  ): Promise<void> {
    const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);

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
      const groupSuccesses = (Array.isArray(groupResults) ? groupResults : [groupResults]).filter((r) => r.success);
      const groupFailures = (Array.isArray(groupResults) ? groupResults : [groupResults]).filter((r) => !r.success);
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

  private async writeOutputFiles(
    cmlModel: CmlModel,
    ruleKeyMapping: RuleKeyEntry[],
    safeApi: string,
    workspaceDir: string,
    api: string
  ): Promise<CmlConvertUnderwritingRulesResult> {
    const cmlPath = `${workspaceDir}/${safeApi}.cml`;
    const associationsPath = `${workspaceDir}/${safeApi}_Associations.csv`;
    const mappingPath = `${workspaceDir}/${safeApi}_RuleKeyMapping.json`;

    await fs.writeFile(cmlPath, cmlModel.generateCml(), 'utf8');
    await fs.writeFile(associationsPath, generateCsvForAssociations(safeApi, cmlModel.associations), 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nCML written to: ${cmlPath}`);
    this.log(`Associations written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log(`\nConverted ${ruleKeyMapping.length} underwriting rules to CML`);
    this.log('\nNext steps:');
    this.log('  1. Review the generated .cml file');
    this.log(
      `  2. Import: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );
    this.log('  3. Update UnderwritingRule records with RuleKey from mapping file');

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping };
  }
}
