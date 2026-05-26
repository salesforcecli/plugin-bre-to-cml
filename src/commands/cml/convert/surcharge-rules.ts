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

type ProductSurchargeRecord = RuleRecord & {
  RuleApiName: string | null;
  RuleDefinition: string | null;
};

export type CmlConvertSurchargeRulesResult = {
  cmlFile: string;
  associationsFile: string;
  ruleKeyMapping: RuleKeyEntry[];
};

export default class CmlConvertSurchargeRules extends SfCommand<CmlConvertSurchargeRulesResult> {
  public static readonly summary = 'Converts BRE-based Product Surcharge dynamic rules to CML eligibility constraints.';
  public static readonly description =
    'Reads ProductSurcharge records from the org (or a JSON file), parses their RuleDefinition, and generates CML constraints that evaluate surcharge eligibility. Each surcharge rule becomes a named constraint that returns true/false. The command outputs a .cml file with the constraint model, an _Associations.csv file for ExpressionSetConstraintObj records, and a _RuleKeyMapping.json with the ProductSurcharge ID to RuleKey mapping for updating records.';
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --target-org myOrg',
    '<%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --surcharge-file path/to/surcharges.json --workspace-dir data --target-org myOrg',
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
    'surcharge-file': Flags.file({
      summary:
        'Optional JSON file with pre-exported ProductSurcharge records. If omitted, records are queried from the org.',
      char: 'f',
      exists: true,
    }),
    'update-records': Flags.boolean({
      summary: 'Update ProductSurcharge records in the org with RuleEngineType=ConstraintEngine.',
      default: false,
    }),
  };

  public async run(): Promise<CmlConvertSurchargeRulesResult> {
    const { flags } = await this.parse(CmlConvertSurchargeRules);

    const workspaceDir = flags['workspace-dir'] ?? '.';
    const targetOrg = flags['target-org'];

    const records = await this.loadRecords(flags, targetOrg);
    if (records.length === 0) {
      this.log('No surcharge rules to convert.');
      return { cmlFile: '', associationsFile: '', ruleKeyMapping: [] };
    }

    const ruleDefs = this.parseRuleDefinitions(records);
    const productIdToCode = await this.resolveProductCodes(ruleDefs, targetOrg, flags);

    const api = flags['cml-api'] ?? (await this.discoverCmlApi(ruleDefs, productIdToCode, targetOrg, flags));
    const safeApi = api.replace(/[^a-zA-Z0-9_-]/g, '_');
    const { cmlModel, ruleKeyMapping } = buildCmlModel(ruleDefs, productIdToCode, 'SC', 'Surcharge eligibility');
    ruleKeyMapping.forEach((m) => this.log(`  -> ${m.name} => ${m.ruleKey}`));

    if (flags['update-records']) {
      await this.updateOrgRecords(targetOrg, flags, ruleKeyMapping);
    }

    return this.writeOutputFiles(cmlModel, ruleKeyMapping, safeApi, workspaceDir, api);
  }

  private async loadRecords(
    flags: Record<string, unknown>,
    targetOrg: { getConnection: (v?: string) => Connection }
  ): Promise<ProductSurchargeRecord[]> {
    const surchargeFile = flags['surcharge-file'] as string | undefined;
    if (surchargeFile) {
      this.log(`Reading surcharges from file: ${surchargeFile}`);
      const contents = await fs.readFile(surchargeFile, 'utf8');
      return JSON.parse(contents) as ProductSurchargeRecord[];
    }

    this.log('Querying ProductSurcharge records from org...');
    const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);
    const result = await conn.query<ProductSurchargeRecord>(
      'SELECT Id, Name, RuleApiName, RuleDefinition, ProductPath FROM ProductSurcharge WHERE RuleApiName != null'
    );
    this.log(`Found ${result.records.length} ProductSurcharge records with BRE rules`);
    return result.records;
  }

  private parseRuleDefinitions(
    records: ProductSurchargeRecord[]
  ): Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> {
    const parsed: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> = [];
    for (const record of records) {
      if (!record.RuleDefinition) {
        this.warn(`Skipping ${record.Name}: no RuleDefinition`);
        continue;
      }
      try {
        const raw = JSON.parse(record.RuleDefinition) as { ruleApiName?: string; ruleCriteria?: unknown[] };
        parsed.push({
          record,
          ruleDef: {
            ...raw,
            name: record.Name,
            apiName: raw.ruleApiName ?? record.Name,
            productPath: record.ProductPath,
          } as ParsedRuleDefinition,
        });
      } catch {
        this.warn(`Failed to parse RuleDefinition for ${record.Name}`);
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
    const generated = `SC_${codes.join('_')}`;
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

  private async updateOrgRecords(
    targetOrg: { getConnection: (v?: string) => Connection },
    flags: Record<string, unknown>,
    ruleKeyMapping: RuleKeyEntry[]
  ): Promise<void> {
    const conn = targetOrg.getConnection(flags['api-version'] as string | undefined);
    this.log('\nUpdating ProductSurcharge records with RuleEngineType and RuleKey...');
    const updates = ruleKeyMapping.map((m) => ({
      Id: m.recordId,
      RuleEngineType: 'ConstraintEngine',
    }));
    const results = await conn.sobject('ProductSurcharge').update(updates);
    const successes = (Array.isArray(results) ? results : [results]).filter((r) => r.success);
    const failures = (Array.isArray(results) ? results : [results]).filter((r) => !r.success);
    this.log(`  Updated ${successes.length} records successfully`);
    for (const f of failures) {
      this.warn(`  Failed to update ${f.id ?? 'unknown'}: ${JSON.stringify(f.errors)}`);
    }
  }

  private async writeOutputFiles(
    cmlModel: CmlModel,
    ruleKeyMapping: RuleKeyEntry[],
    safeApi: string,
    workspaceDir: string,
    api: string
  ): Promise<CmlConvertSurchargeRulesResult> {
    const cmlPath = `${workspaceDir}/${safeApi}.cml`;
    const associationsPath = `${workspaceDir}/${safeApi}_Associations.csv`;
    const mappingPath = `${workspaceDir}/${safeApi}_RuleKeyMapping.json`;

    await fs.writeFile(cmlPath, cmlModel.generateCml(), 'utf8');
    await fs.writeFile(associationsPath, generateCsvForAssociations(safeApi, cmlModel.associations), 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nCML written to: ${cmlPath}`);
    this.log(`Associations written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log(`\nConverted ${ruleKeyMapping.length} rules to CML`);
    this.log('\nNext steps:');
    this.log('  1. Review the generated .cml file');
    this.log(
      `  2. Import: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );
    this.log('  3. Update records with RuleEngineType and RuleKey from mapping file');

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping };
  }
}
