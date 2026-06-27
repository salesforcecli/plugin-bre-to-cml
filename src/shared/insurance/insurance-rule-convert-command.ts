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
/* eslint-disable sf-plugin/command-summary, sf-plugin/command-example, sf-plugin/no-hardcoded-messages-commands */
// This file is a shared abstract base, not a user-invocable command, so the
// command-shape lint rules do not apply.
import * as fs from 'node:fs/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Connection, Messages, Org } from '@salesforce/core';
import { CmlModel } from '../types/types.js';
import { generateCsvForAssociations } from '../utils/association.utils.js';
import { ParsedRuleDefinition, RuleKeyEntry, RuleRecord } from './models.js';
import { buildCmlModel } from './insurance-rule-generator.js';
import { discoverCmlApiByProducts, fetchProductCodes } from './insurance-org.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.convert.insurance-shared');

// Header row for the header-only `_Associations.csv` the merge path writes (merge mode creates no
// new Type associations). Kept here in the insurance layer — the common association util owns the
// build-path CSV and its own copy of this header.
const ASSOCIATIONS_CSV_HEADER =
  'ExpressionSet.ApiName,ConstraintModelTag,ConstraintModelTagType,ReferenceObjectId,$Product2ReferenceId,$ProductClassificationName,$ProductRelatedComponentKey';

export type InsuranceRuleConvertResult = {
  cmlFile: string;
  associationsFile: string;
  ruleKeyMapping: RuleKeyEntry[];
};

export type InsuranceRuleConvertContext = {
  targetOrg: Org;
  apiVersion: string | undefined;
  cmlApi: string | undefined;
  workspaceDir: string | undefined;
  inputFile: string | undefined;
  updateRecords: boolean;
  // When true, merge the generated rules into the org's existing ConstraintModel instead of
  // building a fresh single-type model. Only surcharge supports this (see runMergeConvert).
  mergeWithOrg?: boolean;
};

export type ParsedRuleEntry = { record: RuleRecord; ruleDef: ParsedRuleDefinition };

export abstract class InsuranceRuleConvertCommand<R extends RuleRecord> extends SfCommand<InsuranceRuleConvertResult> {
  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    'cml-api': Flags.string({
      summary: messages.getMessage('flags.cml-api.summary'),
      char: 'c',
    }),
    'workspace-dir': Flags.directory({
      summary: messages.getMessage('flags.workspace-dir.summary'),
      char: 'd',
      exists: true,
    }),
    'update-records': Flags.boolean({
      summary: messages.getMessage('flags.update-records.summary'),
      default: false,
    }),
  };

  // When defined, eligibility is emitted as a CML `rule(...)` statement tagged with this rule
  // type instead of a `constraint`. Subclasses that want the constraint form leave it undefined.
  protected readonly ruleType?: string;
  protected abstract readonly recordLabel: string;
  protected abstract readonly keyPrefix: string;
  protected abstract readonly constraintLabel: string;
  protected abstract readonly apiNamePrefix: string;
  protected abstract readonly soql: string;

  protected async runConvert(ctx: InsuranceRuleConvertContext): Promise<InsuranceRuleConvertResult> {
    const workspaceDir = ctx.workspaceDir ?? '.';
    this.log(`Using Workspace Directory: ${ctx.workspaceDir ?? 'not specified'}`);
    const conn = ctx.targetOrg.getConnection(ctx.apiVersion);

    const records = await this.loadRecords(conn, ctx.inputFile);
    if (records.length === 0) {
      this.log(`No ${this.recordLabel} rules to convert.`);
      return { cmlFile: '', associationsFile: '', ruleKeyMapping: [] };
    }

    const ruleDefs = this.parseAllRecords(records);
    const productIdToCode = await this.resolveProductCodes(conn, ruleDefs);

    const api = ctx.cmlApi ?? (await this.discoverCmlApi(conn, ruleDefs, productIdToCode));
    const safeApi = api.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (ctx.mergeWithOrg) {
      return this.runMergeConvert(ctx, conn, records, ruleDefs, productIdToCode, api, safeApi, workspaceDir);
    }

    const { cmlModel, ruleKeyMapping } = buildCmlModel(
      ruleDefs,
      productIdToCode,
      this.keyPrefix,
      this.constraintLabel,
      this.ruleType
    );
    ruleKeyMapping.forEach((m) => this.log(`  -> ${m.name} => ${m.ruleKey}`));

    if (ctx.updateRecords) {
      await this.updateOrgRecords(records, ruleKeyMapping, conn);
    }

    return this.writeOutputFiles(cmlModel, ruleKeyMapping, safeApi, workspaceDir, api);
  }

  /**
   * Merge-mode entry point. The default errors because merging only makes sense for rule-statement
   * subclasses (surcharge); constraint-form subclasses (underwriting) leave it unimplemented.
   */
  /* eslint-disable @typescript-eslint/no-unused-vars */
  protected runMergeConvert(
    ctx: InsuranceRuleConvertContext,
    conn: Connection,
    records: R[],
    ruleDefs: ParsedRuleEntry[],
    productIdToCode: Map<string, string>,
    api: string,
    safeApi: string,
    workspaceDir: string
  ): Promise<InsuranceRuleConvertResult> {
    this.error(`Merge mode is not supported for ${this.recordLabel} rules.`);
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  /**
   * Writes the merged outputs: the full merged CML, a header-only associations CSV (merge mode
   * touches only existing type blocks, so no new Type associations are needed — but the common
   * import errors on an empty CSV, so the header line must be present), and the rule-key mapping.
   */
  protected async writeMergedOutputFiles(
    mergedCml: string,
    ruleKeyMapping: RuleKeyEntry[],
    safeApi: string,
    workspaceDir: string,
    api: string
  ): Promise<InsuranceRuleConvertResult> {
    const cmlPath = `${workspaceDir}/${safeApi}.cml`;
    const associationsPath = `${workspaceDir}/${safeApi}_Associations.csv`;
    const mappingPath = `${workspaceDir}/${safeApi}_RuleKeyMapping.json`;

    await fs.writeFile(cmlPath, mergedCml, 'utf8');
    await fs.writeFile(associationsPath, `${ASSOCIATIONS_CSV_HEADER}\n`, 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nMerged CML written to: ${cmlPath}`);
    this.log(`Associations (header-only, no new type associations) written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log('\nNext steps:');
    this.log('  1. Review the merged .cml file (diff against the org model)');
    this.log(
      `  2. Import: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping };
  }

  private async loadRecords(conn: Connection, inputFile: string | undefined): Promise<R[]> {
    if (inputFile) {
      this.log(`Reading ${this.recordLabel} records from file: ${inputFile}`);
      const contents = await fs.readFile(inputFile, 'utf8');
      return JSON.parse(contents) as R[];
    }

    this.log(`Querying ${this.recordLabel} records from org...`);
    const result = await conn.query<R>(this.soql);
    this.log(`Found ${result.records.length} ${this.recordLabel} records with BRE rules`);
    return result.records;
  }

  private parseAllRecords(records: R[]): Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> {
    const parsed: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }> = [];
    for (const record of records) {
      try {
        const ruleDef = this.parseRecord(record);
        if (ruleDef) {
          parsed.push({ record, ruleDef });
        }
      } catch (e) {
        this.warn(`Failed to convert ${record.Name}: ${(e as Error).message}`);
      }
    }
    this.log(`Parsed ${parsed.length} valid rule definitions`);
    return parsed;
  }

  private async resolveProductCodes(
    conn: Connection,
    ruleDefs: Array<{ record: RuleRecord }>
  ): Promise<Map<string, string>> {
    // Collect EVERY ProductPath segment, not just the root: merge mode needs the code of each
    // segment to build the platform-compatible pathed rule key, and the leaf segment's code to
    // resolve its CML type. The non-merge path only reads the root code, so this is a superset.
    const productIds = collectAllProductIds(ruleDefs);
    try {
      return await fetchProductCodes(conn, productIds);
    } catch (e) {
      this.warn(`Could not fetch product codes: ${(e as Error).message}. Using product IDs instead.`);
      return new Map<string, string>();
    }
  }

  private async discoverCmlApi(
    conn: Connection,
    ruleDefs: Array<{ record: RuleRecord }>,
    productIdToCode: Map<string, string>
  ): Promise<string> {
    const productIds = collectRootProductIds(ruleDefs);
    try {
      const discovered = await discoverCmlApiByProducts(conn, productIds);
      if (discovered) {
        this.log(`Auto-discovered existing CML API: ${discovered}`);
        return discovered;
      }
    } catch (e) {
      this.warn(`CML auto-discovery failed: ${(e as Error).message}`);
    }

    const codes = Array.from(productIds).map((id) => productIdToCode.get(id) ?? id);
    const generated = `${this.apiNamePrefix}${codes.join('_')}`;
    this.log(`No existing CML found. Generated new CML API name: ${generated}`);
    return generated;
  }

  private async writeOutputFiles(
    cmlModel: CmlModel,
    ruleKeyMapping: RuleKeyEntry[],
    safeApi: string,
    workspaceDir: string,
    api: string
  ): Promise<InsuranceRuleConvertResult> {
    const cmlPath = `${workspaceDir}/${safeApi}.cml`;
    const associationsPath = `${workspaceDir}/${safeApi}_Associations.csv`;
    const mappingPath = `${workspaceDir}/${safeApi}_RuleKeyMapping.json`;

    await fs.writeFile(cmlPath, cmlModel.generateCml(), 'utf8');
    await fs.writeFile(associationsPath, generateCsvForAssociations(safeApi, cmlModel.associations), 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nCML written to: ${cmlPath}`);
    this.log(`Associations written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log(`\nConverted ${ruleKeyMapping.length} ${this.recordLabel} rules to CML`);
    this.log('\nNext steps:');
    this.log('  1. Review the generated .cml file');
    this.log(
      `  2. Import: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );
    this.log('  3. Update records with RuleKey from mapping file');

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping };
  }

  protected abstract parseRecord(record: R): ParsedRuleDefinition | null;
  protected abstract updateOrgRecords(records: R[], ruleKeyMapping: RuleKeyEntry[], conn: Connection): Promise<void>;
}

function collectAllProductIds(ruleDefs: Array<{ record: RuleRecord }>): Set<string> {
  const productIds = new Set<string>();
  for (const { record } of ruleDefs) {
    for (const segment of record.ProductPath.split('/')) {
      const id = segment.trim();
      if (id) productIds.add(id);
    }
  }
  return productIds;
}

// CML auto-discovery and the generated API name key off the ROOT product of each path only, so
// this stays a root-only collector (the merge path uses collectAllProductIds for the full set).
function collectRootProductIds(ruleDefs: Array<{ record: RuleRecord }>): Set<string> {
  const productIds = new Set<string>();
  for (const { record } of ruleDefs) {
    const root = record.ProductPath.split('/')[0]?.trim();
    if (root) productIds.add(root);
  }
  return productIds;
}
