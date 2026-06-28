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
import * as path from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Connection, Messages, Org } from '@salesforce/core';
import { CmlModel } from '../types/types.js';
import { generateCsvForAssociations } from '../utils/association.utils.js';
import { ParsedRuleDefinition, RecordUpdate, RecordUpdatePlan, RuleKeyEntry, RuleRecord } from './models.js';
import { buildCmlModel, isSafeAssociationReferenceValue, sanitizeName } from './insurance-rule-generator.js';
import { discoverCmlApiByProducts, fetchProductCodes } from './insurance-org.js';
import { splitProductPath } from './insurance-cml-merge.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.convert.insurance-shared');

// Header row for the header-only `_Associations.csv` the merge path writes (merge mode creates no
// new Type associations). Kept here in the insurance layer — the common association util owns the
// build-path CSV and its own copy of this header.
const ASSOCIATIONS_CSV_HEADER =
  'ExpressionSet.ApiName,ConstraintModelTag,ConstraintModelTagType,ReferenceObjectId,$Product2ReferenceId,$ProductClassificationName,$ProductRelatedComponentKey';

// File-name suffix per record-update kind. The convert commands emit `<safeApi>_<suffix>.json` as a
// reviewable manifest of the org-record changes; this plugin does NOT apply it (convert is file-only).
const RECORD_UPDATE_FILE_SUFFIX: Record<RecordUpdatePlan['kind'], string> = {
  'underwriting-update': 'UnderwritingUpdate',
  'surcharge-update': 'SurchargeUpdate',
};

export type InsuranceRuleConvertResult = {
  cmlFile: string;
  associationsFile: string;
  ruleKeyMapping: RuleKeyEntry[];
  // Path to the emitted `<safeApi>_{Underwriting,Surcharge}Update.json` file (when one was written).
  recordUpdateFile?: string;
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

  /** Discriminator that selects the on-disk file kind and name suffix for the emitted update file. */
  protected abstract readonly recordUpdateKind: RecordUpdatePlan['kind'];

  protected async runConvert(ctx: InsuranceRuleConvertContext): Promise<InsuranceRuleConvertResult> {
    // Tripwire: convert is now strictly file-only. The legacy --update-records flag mutated the org
    // as a side effect; it is removed, and passing it errors with a pointer to the new flow.
    if (ctx.updateRecords) {
      throw messages.createError('error.updateRecordsRemoved');
    }

    const workspaceDir = ctx.workspaceDir ?? '.';
    this.log(`Using Workspace Directory: ${ctx.workspaceDir ?? 'not specified'}`);
    const conn = ctx.targetOrg.getConnection(ctx.apiVersion);

    const records = await this.loadRecords(conn, ctx.inputFile);
    if (records.length === 0) {
      this.log(`No ${this.recordLabel} rules to convert.`);
      // Still emit an (empty) record-update manifest when we can name it, so automation always has a
      // concrete file to consume. Without --cml-api there are no products to discover an API name
      // from, so there is nothing to name the file after.
      if (ctx.cmlApi) {
        const safeApi = ctx.cmlApi.replace(/[^a-zA-Z0-9_-]/g, '_');
        const recordUpdateFile = await this.writeRecordUpdateFile([], [], ctx.cmlApi, safeApi, workspaceDir);
        return { cmlFile: '', associationsFile: '', ruleKeyMapping: [], recordUpdateFile };
      }
      return { cmlFile: '', associationsFile: '', ruleKeyMapping: [] };
    }

    const ruleDefs = this.parseAllRecords(records);
    const { productIdToCode, productIdToName } = await this.resolveProductCodes(conn, ruleDefs);

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
      this.ruleType,
      productIdToName
    );
    ruleKeyMapping.forEach((m) => this.log(`  -> ${m.name} => ${m.ruleKey}`));

    const recordUpdateFile = await this.writeRecordUpdateFile(records, ruleKeyMapping, api, safeApi, workspaceDir);

    return this.writeOutputFiles(cmlModel, ruleKeyMapping, safeApi, workspaceDir, api, recordUpdateFile);
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
    api: string,
    recordUpdateFile: string
  ): Promise<InsuranceRuleConvertResult> {
    // [Fix #15] Use path.join so emitted paths use the OS-native separator. Hardcoded '/' template
    // literals produced forward-slash paths on Windows; tests that assert against path.join then
    // diverged at the separator (`\` vs `/`). path.join keeps Linux unchanged ('/' verbatim) and
    // emits backslashes on Windows, matching the test's normalized expectation.
    const cmlPath = path.join(workspaceDir, `${safeApi}.cml`);
    const associationsPath = path.join(workspaceDir, `${safeApi}_Associations.csv`);
    const mappingPath = path.join(workspaceDir, `${safeApi}_RuleKeyMapping.json`);

    await fs.writeFile(cmlPath, mergedCml, 'utf8');
    await fs.writeFile(associationsPath, `${ASSOCIATIONS_CSV_HEADER}\n`, 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nMerged CML written to: ${cmlPath}`);
    this.log(`Associations (header-only, no new type associations) written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log(`Record update file written to: ${recordUpdateFile}`);
    this.log('\nNext steps (this command wrote nothing to the org):');
    this.log('  1. Review the merged .cml file (diff against the org model) and the record update file');
    this.log(
      `  2. Activate the CML: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );
    this.log(`  3. Apply the org-record changes enumerated in ${recordUpdateFile} to the target org`);

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping, recordUpdateFile };
  }

  /**
   * Build the record-update plan envelope and write it to `<safeApi>_<kind>Update.json`. This is the
   * ONLY way org-record changes leave convert now — convert never writes to the org itself. The file
   * is a reviewable manifest the operator applies to the org separately; this plugin does not apply it.
   */
  protected async writeRecordUpdateFile(
    records: R[],
    ruleKeyMapping: RuleKeyEntry[],
    api: string,
    safeApi: string,
    workspaceDir: string
  ): Promise<string> {
    const plan: RecordUpdatePlan = {
      schemaVersion: 1,
      kind: this.recordUpdateKind,
      cmlApi: api,
      generatedAt: new Date().toISOString(),
      updates: this.buildRecordUpdates(records, ruleKeyMapping),
    };
    // [Fix #15] path.join for cross-platform path separators (was hardcoded '/'). Note: this local
    // is intentionally named `filePath` rather than `path` to avoid shadowing the `path` module import.
    const filePath = path.join(workspaceDir, `${safeApi}_${RECORD_UPDATE_FILE_SUFFIX[this.recordUpdateKind]}.json`);
    await fs.writeFile(filePath, JSON.stringify(plan, null, 2), 'utf8');
    return filePath;
  }

  private async loadRecords(conn: Connection, inputFile: string | undefined): Promise<R[]> {
    if (inputFile) {
      this.log(`Reading ${this.recordLabel} records from file: ${inputFile}`);
      const contents = await fs.readFile(inputFile, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (e) {
        throw new Error(`${inputFile}: not valid JSON (${(e as Error).message})`);
      }
      // [Fix #6] The file is operator-supplied input that drives ProductPath splits, SOQL id
      // resolution, and rule-key derivation. A non-array root, or records with missing/non-string
      // Id / Name / ProductPath, would otherwise propagate `undefined`s through the pipeline and
      // surface as confusing downstream failures (or silently malformed output). Refuse upfront.
      if (!Array.isArray(parsed)) {
        throw new Error(`${inputFile}: expected a top-level JSON array of ${this.recordLabel} records`);
      }
      parsed.forEach((entry, index) => {
        if (entry === null || typeof entry !== 'object') {
          throw new Error(`${inputFile}: record #${index} is not an object`);
        }
        const rec = entry as Record<string, unknown>;
        for (const field of ['Id', 'Name', 'ProductPath'] as const) {
          const value = rec[field];
          if (typeof value !== 'string' || value.length === 0) {
            throw new Error(`${inputFile}: record #${index} has missing or non-string ${field}`);
          }
        }
      });
      return parsed as R[];
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
  ): Promise<{ productIdToCode: Map<string, string>; productIdToName: Map<string, string> }> {
    // Collect EVERY ProductPath segment, not just the root: merge mode needs the code of each
    // segment to build the platform-compatible pathed rule key, and the leaf segment's code to
    // resolve its CML type. The non-merge path only reads the root code, so this is a superset.
    const productIds = collectAllProductIds(ruleDefs);
    const productIdToName = new Map<string, string>();
    try {
      const productIdToCode = await fetchProductCodes(conn, productIds, {
        // M2: a blank ProductCode forces a Name/Id fallback, so the pathed rule key is derived from a
        // non-authoritative field and will NOT match the platform-generated RuleKey — the surcharge
        // then imports cleanly but silently never fires. Surface it instead of substituting silently.
        onFallback: (productId) =>
          this.warn(
            `Product ${productId} has no ProductCode; rule key derived from Name/Id and may not match the platform-generated RuleKey (surcharge may silently not fire)`
          ),
        // Capture Names so convert can emit them as the Type association reference value — the field
        // the common importer resolves the Product2 by. Validated below before they reach the model.
        collectNames: productIdToName,
      });
      // [Fix #8] An id we ASKED Product2 about and got nothing back for is distinct from a found
      // product with a null ProductCode (which `onFallback` already covers). Missing-from-result
      // ids mean the Product2 row is invalid / deleted / outside the visible scope — generation
      // will silently fall back to the raw Id for that path segment, again yielding a non-matching
      // platform RuleKey. Surface this case explicitly so the operator can investigate.
      for (const id of productIds) {
        if (!productIdToCode.has(id)) {
          this.warn(
            `Product ${id} was not returned by Product2 query (not found, not visible, or filtered out); ` +
              'rule key for paths through this product will fall back to the raw Id and may not match the platform-generated RuleKey'
          );
        }
      }
      this.validateAssociationNames(productIdToName);
      return { productIdToCode, productIdToName };
    } catch (e) {
      this.warn(`Could not fetch product codes: ${(e as Error).message}. Using product IDs instead.`);
      return { productIdToCode: new Map<string, string>(), productIdToName: new Map<string, string>() };
    }
  }

  /**
   * Validates the Id -> Name map that feeds each Type association's reference value, mutating it in
   * place so only safe, importer-resolvable Names survive. The Name is written into the naive
   * comma-joined associations CSV and, downstream, into the common importer's single-quoted SOQL
   * `WHERE Name IN ('<Name>')`. Two hazards, neither of which we can fix in the (Rev-Cloud-owned)
   * importer. Unsafe characters (comma, quote, backslash, newline) corrupt the CSV column or break
   * out of the SOQL literal — such a Name is dropped from the map (the generator falls back to the
   * ProductCode) and warned, so the association may not resolve but the output stays valid and
   * injection-free instead of silently wrong. Duplicate Names across distinct product ids make the
   * importer's by-Name lookup ambiguous (last-writer-wins), so a Type could bind to the wrong
   * Product2 — we warn but keep the entries; the documented precondition is that Product Name is
   * unique per migration scope.
   */
  private validateAssociationNames(productIdToName: Map<string, string>): void {
    const nameToIds = new Map<string, string[]>();
    for (const [productId, name] of productIdToName) {
      if (!isSafeAssociationReferenceValue(name)) {
        this.warn(
          `Product ${productId} Name "${name}" contains characters unsafe for the associations CSV / import SOQL; ` +
            'falling back to ProductCode for its Type association (the association may not resolve on import)'
        );
        productIdToName.delete(productId);
        continue;
      }
      const ids = nameToIds.get(name) ?? [];
      ids.push(productId);
      nameToIds.set(name, ids);
    }
    for (const [name, ids] of nameToIds) {
      if (ids.length > 1) {
        this.warn(
          `Product Name "${name}" is shared by ${ids.length} products (${ids.join(', ')}); ` +
            'the import resolves Type associations by Name, so bindings may be ambiguous. Product Name must be unique.'
        );
      }
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

    // [Fix #5] The fallback API name is downstream written to disk as `<safeApi>.cml` and used in
    // SOQL/log lines. Raw ProductCodes can contain spaces, slashes, quotes, or other characters
    // that break path/SOQL semantics; sanitize each segment to the same `[A-Za-z0-9_]` alphabet
    // the rest of the generator uses so the generated name is injection-/path-traversal-safe.
    const codes = Array.from(productIds).map((id) => sanitizeName(productIdToCode.get(id) ?? id));
    const generated = `${this.apiNamePrefix}${codes.join('_')}`;
    this.log(`No existing CML found. Generated new CML API name: ${generated}`);
    return generated;
  }

  private async writeOutputFiles(
    cmlModel: CmlModel,
    ruleKeyMapping: RuleKeyEntry[],
    safeApi: string,
    workspaceDir: string,
    api: string,
    recordUpdateFile: string
  ): Promise<InsuranceRuleConvertResult> {
    // [Fix #15] path.join for cross-platform path separators (was hardcoded '/'). See companion site
    // in writeMergedOutputFiles — same rationale: Windows-unit-tests assert against path.join, and
    // forward-slash literals broke the equality there.
    const cmlPath = path.join(workspaceDir, `${safeApi}.cml`);
    const associationsPath = path.join(workspaceDir, `${safeApi}_Associations.csv`);
    const mappingPath = path.join(workspaceDir, `${safeApi}_RuleKeyMapping.json`);

    await fs.writeFile(cmlPath, cmlModel.generateCml(), 'utf8');
    await fs.writeFile(associationsPath, generateCsvForAssociations(safeApi, cmlModel.associations), 'utf8');
    await fs.writeFile(mappingPath, JSON.stringify(ruleKeyMapping, null, 2), 'utf8');

    this.log(`\nCML written to: ${cmlPath}`);
    this.log(`Associations written to: ${associationsPath}`);
    this.log(`Rule key mapping written to: ${mappingPath}`);
    this.log(`Record update file written to: ${recordUpdateFile}`);
    this.log(`\nConverted ${ruleKeyMapping.length} ${this.recordLabel} rules to CML`);
    this.log('\nNext steps (this command wrote nothing to the org):');
    this.log('  1. Review the generated .cml file and the record update file');
    this.log(
      `  2. Activate the CML: sf cml import as-expression-set --cml-api ${api} --context-definition <CD_NAME> --target-org <org>`
    );
    this.log(`  3. Apply the org-record changes enumerated in ${recordUpdateFile} to the target org`);

    return { cmlFile: cmlPath, associationsFile: associationsPath, ruleKeyMapping, recordUpdateFile };
  }

  protected abstract parseRecord(record: R): ParsedRuleDefinition | null;

  /**
   * Pure transform: given the parsed records and the rule-key mapping, return the list of org-record
   * changes convert WOULD have made. No org writes — the result is serialized into the update file.
   */
  protected abstract buildRecordUpdates(records: R[], ruleKeyMapping: RuleKeyEntry[]): RecordUpdate[];
}

function collectAllProductIds(ruleDefs: Array<{ record: RuleRecord }>): Set<string> {
  const productIds = new Set<string>();
  for (const { record } of ruleDefs) {
    // [Fix #11] One canonical split helper so trim + drop-empty semantics never diverge from the
    // merge module's parsing.
    for (const id of splitProductPath(record.ProductPath)) productIds.add(id);
  }
  return productIds;
}

// CML auto-discovery and the generated API name key off the ROOT product of each path only, so
// this stays a root-only collector (the merge path uses collectAllProductIds for the full set).
function collectRootProductIds(ruleDefs: Array<{ record: RuleRecord }>): Set<string> {
  const productIds = new Set<string>();
  for (const { record } of ruleDefs) {
    // [Fix #11] splitProductPath already trims and drops empty segments, so the root is the first
    // emitted id (or undefined when the entire path is blank).
    const root = splitProductPath(record.ProductPath)[0];
    if (root) productIds.add(root);
  }
  return productIds;
}
