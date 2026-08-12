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
import { Connection } from '@salesforce/core';
import { CmlConstraint } from '../types/types.js';
import { CONSTRAINT_TYPES } from '../constants/constants.js';
import { ParsedRuleDefinition, RuleRecord } from './models.js';
import {
  AttributeDataTypes,
  buildConstraintDeclaration,
  collectAttributeTypes,
  collectEmittedAttributes,
  findUnconvertibleConditions,
  sanitizeName,
  buildStageTransition,
} from './insurance-rule-generator.js';
import { quoteSoqlIdList } from './insurance-org.js';

/**
 * MERGE MODE (insurance-only): instead of building a fresh single-type CML and PATCH-replacing
 * the org's curated "Gold Standard" ConstraintModel, this module reads the existing model text,
 * computes each surcharge's PLATFORM-COMPATIBLE pathed rule key, and inserts/updates the
 * `rule(...)` statement inside the correct existing leaf `type` block. The result is the full
 * merged model, written to the same `${cmlApi}.cml` path the common import reads — so the import
 * still does a whole-file PATCH, but the file now contains the curated model + the surcharge rules
 * nested correctly rather than a flat overwrite.
 *
 * Why pathed keys: when a ProductSurcharge is persisted as ConstraintEngine the platform
 * auto-generates `RuleKey` as `SC` + sanitize(ProductCode) of every segment in ProductPath (in
 * order) + sanitize(leaf), joined by `__`. The leaf is the parent `Surcharge.Code` (resolved via
 * ProductSurcharge.SurchargeId), NOT the rule apiName — see {@link fetchSurchargeCodes} and
 * {@link buildPathedSurchargeRules}. The Core surcharge engine matches the fired CML rule key
 * against that auto-generated RuleKey by exact string, so the CML rule key MUST be pathed and use
 * the same Code-derived leaf.
 */

export const SURCHARGE_RULE_ACTION = 'InsuranceSurchargeRule';

export type PathedSurchargeRule = {
  recordId: string;
  recordName: string;
  apiName: string;
  /** Full pathed key: SC__<code-of-each-path-segment>__<apiName>. */
  ruleKey: string;
  /**
   * Ordered ProductCodes for every ProductPath segment used to build {@link ruleKey}. Empty when the
   * source ProductPath was blank/whitespace-only — the merge guards on this to refuse the replace
   * path for malformed input (an empty-path rule degenerates to `SC__<apiName>` which could
   * coincidentally match a curated short-keyed line).
   */
  pathProductCodes: string[];
  /** Leaf CML type name (ConstraintModelTag of the LAST ProductPath segment). */
  typeName: string | undefined;
  /** The generated `rule(<decl>, "InsuranceSurchargeRule", "<ruleKey>", "True");` statement. */
  statement: string;
  /** Sanitized attribute names referenced by the rule declaration (for visibility warnings). */
  referencedAttributes: string[];
  /**
   * Set when {@link findUnconvertibleConditions} found something in this rule CML cannot express.
   * The merge refuses such a rule outright — `statement` is built anyway (the shapes stay uniform)
   * but must never be placed.
   */
  unconvertibleReason?: string;
};

export type MergePlacement = {
  rule: PathedSurchargeRule;
  status: 'inserted' | 'replaced';
};

export type MergeSkip = {
  rule: PathedSurchargeRule;
  reason: string;
};

export type MergeResult = {
  mergedCml: string;
  placements: MergePlacement[];
  skips: MergeSkip[];
  attributeWarnings: string[];
};

export type UwMergePlacement = {
  rule: UnderwritingConstraintRule;
  status: 'inserted' | 'replaced';
};

export type UwMergeSkip = {
  rule: UnderwritingConstraintRule;
  reason: string;
};

export type UwMergeResult = {
  mergedCml: string;
  placements: UwMergePlacement[];
  skips: UwMergeSkip[];
  attributeWarnings: string[];
};

/**
 * Underwriting analogue of {@link PathedSurchargeRule}: instead of a `rule(...)` action statement,
 * underwriting eligibility is emitted as a named `constraint <name> = (<expr>, "<label>");`
 * statement nested inside the leaf product's `type` block (see `buildCmlModel`'s constraint-form
 * branch in insurance-rule-generator.ts, which this mirrors for merge mode).
 */
export type UnderwritingConstraintRule = {
  recordId: string;
  recordName: string;
  apiName: string;
  /** Full pathed key: UW__<code-of-each-path-segment>__<apiName> (advisory; not emitted in the constraint form, but tracked for the RuleKeyMapping output). */
  ruleKey: string;
  /** Ordered ProductCodes for every ProductPath segment. Empty when the source ProductPath was blank/whitespace-only. */
  pathProductCodes: string[];
  /** Leaf CML type name (ConstraintModelTag of the LAST ProductPath segment). */
  typeName: string | undefined;
  /** Sanitized constraint name used in the CML (the `constraint <name> = (...)` identifier). */
  constraintName: string;
  /** The full generated `constraint <name> = (<expr>, "<label>");` statement. */
  statement: string;
  /**
   * Attributes the declaration references, with their derived CML type — used to auto-insert
   * missing attribute declarations into the leaf type block during merge.
   */
  referencedAttributes: Array<{ name: string; cmlType: string }>;
  /** See {@link PathedSurchargeRule.unconvertibleReason}. */
  unconvertibleReason?: string;
};

/**
 * Builds the pathed surcharge rule key that mirrors the platform's auto-generated
 * `ProductSurcharge.RuleKey`: prefix + every path-segment product code + apiName.
 */
export function buildPathedRuleKey(
  prefix: string,
  pathProductCodes: string[],
  apiName: string,
  stageTransition?: string
): string {
  const parts = [prefix, ...pathProductCodes.map(sanitizeName)];
  if (stageTransition) parts.push(stageTransition);
  parts.push(sanitizeName(apiName));
  return parts.join('__');
}

/**
 * Splits a `ProductPath` into its ordered Product2 ids (slash-separated).
 *
 * ProductPath is nullable in the org even on records that carry a rule, so nullish input yields an
 * empty path rather than throwing. Callers rely on that: an empty path is already a recognized skip
 * (see the empty-ProductPath guard in mergeSurchargeRules), whereas throwing here aborted the whole
 * conversion run before any record could be skipped.
 */
export function splitProductPath(productPath: string | null | undefined): string[] {
  if (!productPath) return [];
  return productPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Reads the org's existing ConstraintModel text for the given CML API name, mirroring the lookup
 * the common import uses (ExpressionSetDefinition.DeveloperName -> ExpressionSetDefinitionVersion).
 * Returns undefined when no model exists yet (caller should then fall back to the build path).
 */
export async function fetchExistingConstraintModel(
  conn: Connection,
  cmlApiName: string
): Promise<{ versionId: string; cmlText: string } | undefined> {
  const def = await conn.sobject('ExpressionSetDefinition').findOne({ DeveloperName: cmlApiName }, ['Id']);
  const defId = (def as { Id?: string } | null)?.Id;
  if (!defId) return undefined;

  const version = await conn
    .sobject('ExpressionSetDefinitionVersion')
    .findOne({ ExpressionSetDefinitionId: defId }, ['Id']);
  const versionId = (version as { Id?: string } | null)?.Id;
  if (!versionId) return undefined;

  // ConstraintModel is a blob field: a plain row GET returns only a URL pointing at the blob, not
  // its content. Fetch the blob endpoint directly — it streams back the raw CML text (the platform
  // base64-decodes what the import PATCHes), so the body IS the model text and needs no decoding.
  const blob = await conn.request(
    `/services/data/v${conn.getApiVersion()}/sobjects/ExpressionSetDefinitionVersion/${versionId}/ConstraintModel`
  );

  const cmlText = typeof blob === 'string' ? blob : '';
  return { versionId, cmlText };
}

/**
 * Resolves Product2 id -> CML type name from the authoritative source: ExpressionSetConstraintObj
 * rows with ConstraintModelTagType='Type' (ReferenceObjectId is the Product2 id, ConstraintModelTag
 * is the CML type name). This is how the curated model binds products to type blocks, so it's the
 * correct way to find which existing `type` block a surcharge's leaf product nests into.
 */
export async function fetchProductTypeTags(conn: Connection, productIds: Set<string>): Promise<Map<string, string>> {
  const idToTag = new Map<string, string>();
  const idList = quoteSoqlIdList(productIds);
  if (!idList) return idToTag;

  const result = await conn.query<{ ReferenceObjectId: string; ConstraintModelTag: string }>(
    `SELECT ReferenceObjectId, ConstraintModelTag FROM ExpressionSetConstraintObj WHERE ReferenceObjectId IN (${idList}) AND ConstraintModelTagType = 'Type'`
  );
  for (const r of result.records) {
    if (r.ReferenceObjectId && r.ConstraintModelTag) idToTag.set(r.ReferenceObjectId, r.ConstraintModelTag);
  }
  return idToTag;
}

/**
 * Resolves Surcharge id -> Surcharge.Code. The platform builds the LEAF segment of
 * `ProductSurcharge.RuleKey` from the parent Surcharge's Code (e.g. `basictaxcode`), NOT from the
 * rule apiName. `buildPathedSurchargeRules` uses this map so the emitted CML rule key matches the
 * platform-generated RuleKey exactly; without it the surcharge imports cleanly but never fires
 * ("No active rule model found"). Ids with no resolvable Code are omitted (caller warns + falls
 * back to apiName).
 */
export async function fetchSurchargeCodes(conn: Connection, surchargeIds: Set<string>): Promise<Map<string, string>> {
  const idToCode = new Map<string, string>();
  const idList = quoteSoqlIdList(surchargeIds);
  if (!idList) return idToCode;

  const result = await conn.query<{ Id: string; Code: string | null }>(
    `SELECT Id, Code FROM Surcharge WHERE Id IN (${idList})`
  );
  for (const r of result.records) {
    if (!r.Id || !r.Code) continue;
    // SOQL always returns 18-char Ids, but a RuleDefinition blob could carry a 15-char surchargeId.
    // Index under both the full and 15-char-prefix forms so the caller's verbatim lookup hits either
    // way (SOQL `IN` is 15/18 tolerant, so the returned key would otherwise not match a 15-char id).
    idToCode.set(r.Id, r.Code);
    if (r.Id.length === 18) idToCode.set(r.Id.slice(0, 15), r.Code);
  }
  return idToCode;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * [Fix #4] Detects the dominant line ending of a CML text by counting CRLF vs bare-LF occurrences.
 * Returns `\r\n` when at least one CRLF appears AND CRLFs are at least as common as bare LFs (mixed
 * CRLF-majority files still get CRLF; pure-LF and empty files get `\n`). Used by the INSERT path so
 * a CRLF-curated model stays byte-clean after splicing. The L2 replace path preserves the line
 * ending of the REPLACED span directly, so this only matters for new inserts.
 */
export function detectDominantLineEnding(cml: string): string {
  const crlfCount = (cml.match(/\r\n/g) ?? []).length;
  // Subtract CRLFs from the total LF count to get the BARE-LF count (an LF preceded by CR is part of a CRLF).
  const totalLf = (cml.match(/\n/g) ?? []).length;
  const bareLfCount = totalLf - crlfCount;
  return crlfCount > 0 && crlfCount >= bareLfCount ? '\r\n' : '\n';
}

type TypeBlock = { openIdx: number; closeIdx: number };

/**
 * Brace-matches the block whose opening `{` is at `openIdx` and returns the index of its matched
 * closing `}`. The scanner ignores `{`/`}`/`"` that appear inside double-quoted string literals,
 * `//` line comments, and `/* *\/` block comments — a curated Gold-Standard model routinely carries
 * comments, and a stray `}` inside one (or inside a quoted rule value) must NOT be mistaken for the
 * structural close, which would return a too-early closeIdx and splice a new rule mid-statement.
 */
export function matchClosingBrace(cml: string, openIdx: number): number | undefined {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < cml.length; i++) {
    const ch = cml[i];
    const next = cml[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped character
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * Locates a `type <name> [: Parent] { ... }` block and returns the index of its opening brace and
 * its brace-matched closing brace. Block-less forward declarations (`type X : Y;`) are skipped
 * because the regex requires a `{` before any `;`. Word-boundary after the name keeps `Auto` from
 * matching `AutoSilver`/`AutoDriver`.
 *
 * M1/M5: when more than one block declares the same type name the result is AMBIGUOUS — rather than
 * guessing the first lexical match (which could nest the surcharge under the wrong product), the
 * caller is told via `undefined` + a distinct ambiguity reason. A single unique match resolves
 * normally.
 */
function findTypeBlock(
  cml: string,
  typeName: string,
  scan: string = blankComments(cml)
): TypeBlock | { ambiguous: true } | undefined {
  // [Fix #1] Run the anchor regex against the comment-blanked, length-preserving SCAN view rather
  // than the raw cml. matchClosingBrace below is comment-aware; if the anchor regex ran on raw cml a
  // commented-out `type Collision { ... }` header could be picked up as a real declaration (and then
  // matchClosingBrace, which ignores comment braces, would either return the WRONG closeIdx or
  // confuse a real same-name type for an "ambiguous" duplicate). The scan view zeroes the comment
  // characters to spaces while preserving offsets, so the indices returned here still slice the
  // real cml correctly. The default-argument pattern lets callers reuse a single hoisted scan
  // across multiple lookups (Fix #1 hoisting site).
  const re = new RegExp(`(^|\\n)[ \\t]*type[ \\t]+${escapeRegExp(typeName)}\\b[^{;]*\\{`, 'g');
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scan)) !== null) {
    const openIdx = scan.indexOf('{', m.index);
    if (openIdx >= 0) matches.push(openIdx);
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { ambiguous: true };

  const openIdx = matches[0];
  const closeIdx = matchClosingBrace(cml, openIdx);
  if (closeIdx === undefined) return undefined;
  return { openIdx, closeIdx };
}

/**
 * Prefix every merge skip raised by {@link findUnconvertibleConditions} carries, so the commands'
 * skip breakdown can bucket it the way it buckets the other reasons.
 */
export const UNCONVERTIBLE_SKIP_PREFIX = 'cannot be expressed in CML';

function joinReasons(reasons: string[]): string | undefined {
  return reasons.length > 0 ? `${UNCONVERTIBLE_SKIP_PREFIX}: ${reasons.join(' ')}` : undefined;
}

/** Builds the `rule(...)` statement for a surcharge, using the same constraint generator as build mode. */
export function buildSurchargeRuleStatement(declaration: string, ruleKey: string): string {
  return CmlConstraint.createRuleConstraint(declaration, SURCHARGE_RULE_ACTION, ruleKey, 'True').generateCml();
}

export type BuildPathedSurchargeRulesOptions = {
  /**
   * Surcharge id -> Surcharge.Code (from {@link fetchSurchargeCodes}). The platform derives the
   * LEAF segment of ProductSurcharge.RuleKey from the parent Surcharge's Code, so this is preferred
   * over the rule apiName for the key leaf. When a rule's surchargeId is missing or not present in
   * this map, the leaf falls back to the apiName and {@link onSurchargeCodeFallback} fires.
   */
  surchargeIdToCode?: Map<string, string>;
  /** Called with the rule's recordName when its Surcharge.Code could not be resolved (key leaf fell back to apiName). */
  onSurchargeCodeFallback?: (recordName: string) => void;
  /**
   * Org-resolved attribute types (see {@link AttributeDataTypes}). Required for a numeric picklist
   * to be compared as a number: without it the merged rule compares a decimal attribute — as the
   * curated model already declares it — against a quoted string, and the surcharge never fires.
   */
  attributeDataTypes?: AttributeDataTypes;
};

/**
 * Prepares the pathed-rule descriptors for a set of parsed surcharge records.
 * `productIdToCode` and `productIdToType` must already cover every ProductPath segment.
 * `options.surchargeIdToCode` should map every rule's parent Surcharge id to its Code so the key
 * leaf matches the platform-generated RuleKey (see {@link fetchSurchargeCodes}).
 */
export function buildPathedSurchargeRules(
  prefix: string,
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  productIdToType: Map<string, string>,
  options: BuildPathedSurchargeRulesOptions = {}
): PathedSurchargeRule[] {
  return ruleDefs.map(({ record, ruleDef }) => {
    const apiName = ruleDef.apiName ?? record.Name;
    // The platform builds the RuleKey leaf from the parent Surcharge.Code, not the rule apiName.
    // Prefer the resolved Code; fall back to apiName (and warn) only when it can't be resolved.
    const surchargeCode = ruleDef.surchargeId ? options.surchargeIdToCode?.get(ruleDef.surchargeId) : undefined;
    const keyLeaf = surchargeCode ?? apiName;
    if (!surchargeCode) options.onSurchargeCodeFallback?.(record.Name);
    const segments = splitProductPath(record.ProductPath);
    const pathCodes = segments.map((id) => productIdToCode.get(id) ?? id);
    const stageTransition = buildStageTransition(ruleDef.underwritingRuleGroup);
    const ruleKey = buildPathedRuleKey(prefix, pathCodes, keyLeaf, stageTransition);

    const leafProductId = segments[segments.length - 1];
    const typeName = leafProductId ? productIdToType.get(leafProductId) : undefined;

    const declaration = buildConstraintDeclaration(ruleDef, options.attributeDataTypes);
    const statement = buildSurchargeRuleStatement(declaration, ruleKey);
    // M7: only attributes from conditions that actually emitted CML (non-null buildConditionExpression)
    // count as "referenced". Attributes from conditions the safe-literal guard / unknown-operator
    // filter dropped never appear in the declaration, so warning about them would be spurious noise.
    const referencedAttributes = Array.from(collectEmittedAttributes([{ ruleDef }], options.attributeDataTypes));

    return {
      recordId: record.Id,
      recordName: record.Name,
      apiName,
      ruleKey,
      pathProductCodes: pathCodes,
      typeName,
      statement,
      referencedAttributes,
      unconvertibleReason: joinReasons(findUnconvertibleConditions(ruleDef, options.attributeDataTypes)),
    };
  });
}

/**
 * Builds the `constraint <name> = (...)` statement for underwriting eligibility, using the same
 * constraint generator as build mode's constraint-form branch (see `buildCmlModel`).
 */
export function buildUnderwritingConstraintStatement(
  constraintName: string,
  declaration: string,
  label: string
): string {
  const constraint = new CmlConstraint(CONSTRAINT_TYPES.CONSTRAINT, declaration, `"${label}"`);
  constraint.name = constraintName;
  return constraint.generateCml();
}

/**
 * Builds the constraint-form rule descriptors for underwriting eligibility, mirroring
 * {@link buildPathedSurchargeRules} but emitting a named `constraint` statement (matching the
 * constraint-form branch of `buildCmlModel` in insurance-rule-generator.ts) instead of a `rule(...)`
 * action statement. `productIdToCode` and `productIdToType` must already cover every ProductPath
 * segment.
 */
export function buildUnderwritingConstraintRules(
  keyPrefix: string,
  constraintLabel: string,
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  productIdToType: Map<string, string>,
  // Org-resolved attribute types, so a picklist attribute is compared as the type behind the
  // picklist and declared with that same type in referencedAttributes.
  attributeDataTypes?: AttributeDataTypes
): UnderwritingConstraintRule[] {
  return ruleDefs.map(({ record, ruleDef }) => {
    const apiName = ruleDef.apiName ?? record.Name;
    const segments = splitProductPath(record.ProductPath);
    const pathCodes = segments.map((id) => productIdToCode.get(id) ?? id);
    const stageTransition = buildStageTransition(ruleDef.underwritingRuleGroup);
    const ruleKey = buildPathedRuleKey(keyPrefix, pathCodes, apiName, stageTransition);

    const leafProductId = segments[segments.length - 1];
    const typeName = leafProductId ? productIdToType.get(leafProductId) : undefined;

    const declaration = buildConstraintDeclaration(ruleDef, attributeDataTypes);
    // Mirrors buildCmlModel's constraint naming: sanitized apiName, with the stage transition
    // appended so two rules sharing an apiName under the same product (gated on different
    // transitions) don't collide.
    const constraintName = sanitizeName(stageTransition ? `${apiName}_${stageTransition}` : apiName);
    const statement = buildUnderwritingConstraintStatement(
      constraintName,
      declaration,
      `${constraintLabel}: ${record.Name}`
    );

    // Same emitted-vs-collected reconciliation buildPathedSurchargeRules uses for
    // referencedAttributes, but ALSO carrying each attribute's derived CML type:
    // collectAttributeTypes keys its map by the RAW attribute name, whereas
    // collectEmittedAttributes returns SANITIZED names, so we sanitize each raw key before
    // matching it against the emitted-name set.
    const emittedSanitized = collectEmittedAttributes([{ ruleDef }], attributeDataTypes);
    const attrTypesByRawName = collectAttributeTypes([{ ruleDef }], attributeDataTypes);
    const referencedAttributes: Array<{ name: string; cmlType: string }> = [];
    for (const [rawName, cmlType] of attrTypesByRawName) {
      const sanitized = sanitizeName(rawName);
      if (emittedSanitized.has(sanitized)) {
        referencedAttributes.push({ name: sanitized, cmlType });
      }
    }

    return {
      recordId: record.Id,
      recordName: record.Name,
      apiName,
      ruleKey,
      pathProductCodes: pathCodes,
      typeName,
      constraintName,
      statement,
      referencedAttributes,
      unconvertibleReason: joinReasons(findUnconvertibleConditions(ruleDef, attributeDataTypes)),
    };
  });
}

/**
 * Merges the pathed surcharge `rule(...)` statements into the existing CML text. If the rule key is
 * already present, the existing statement line is replaced in place (idempotent). Otherwise the
 * statement is inserted just before the closing brace of the leaf `type` block. Rules whose leaf type
 * block can't be found are skipped (reported, never silently dropped).
 */
export function mergeSurchargeRules(existingCml: string, rules: PathedSurchargeRule[]): MergeResult {
  let cml = existingCml;
  const placements: MergePlacement[] = [];
  const skips: MergeSkip[] = [];
  const attributeWarnings: string[] = [];

  // Capture the curated model text BEFORE any rule statements are spliced in. The attribute-presence
  // check must run against this baseline, not the progressively-mutated `cml`: a rule's own inserted
  // statement always contains its referenced attribute (the declaration sanitizes attribute names the
  // same way), so checking the mutated text would always find it and suppress every warning.
  const baseCml = existingCml;
  // [Fix #1] Comment-blanked, length-preserving view of the BASELINE cml — shared by every
  // collectTypeScopeText / baseline lookup so the attribute-presence anchor regex ignores comment
  // contents without losing offset alignment. The per-iteration scan for findTypeBlock /
  // findSurchargeStatement is computed against the current (possibly mutated) `cml` inside the loop.
  const baseScan = blankComments(baseCml);
  // [Fix #4] Detect the dominant line ending ONCE so the INSERT path can splice in the model's own
  // convention (CRLF on Windows-curated files, LF elsewhere). Before this, a hardcoded `\n` mixed
  // bare LFs into a CRLF model and produced a byte-unclean diff. The L2 replace path already
  // preserves the original line ending of the replaced span; this guard does the same for inserts.
  const eol = detectDominantLineEnding(existingCml);

  // H1: keys this run has already placed. A second rule resolving to the same pathed key must be
  // reported as a collision skip, NOT treated as an idempotent replace of the first rule's
  // just-inserted statement (which would silently drop the second record's distinct declaration).
  const placedKeys = new Set<string>();

  for (const rule of rules) {
    // Checked first: a rule CML cannot express must not be placed on any path, and placing it
    // would mean placing a declaration its dropped conditions had already emptied to `true`.
    if (rule.unconvertibleReason) {
      skips.push({ rule, reason: rule.unconvertibleReason });
      continue;
    }

    if (placedKeys.has(rule.ruleKey)) {
      skips.push({
        rule,
        reason: `duplicate pathed rule key '${rule.ruleKey}' collides with another rule in this run (${rule.recordName} skipped)`,
      });
      continue;
    }

    // [Fix #3] Refuse the destructive replace path for malformed/empty-ProductPath input. An empty
    // pathProductCodes degenerates the rule key to `SC__<apiName>`, which could COINCIDENTALLY match
    // a curated short-keyed line and clobber it; an absent typeName means we'd have nowhere to
    // re-insert and would also have no way to scope the replace to the correct block. Short-circuit
    // these as skips BEFORE findSurchargeStatement runs so a malformed surcharge can never reach the
    // replace splice. The pre-existing intra-run duplicate guard above is preserved.
    if (rule.pathProductCodes.length === 0) {
      skips.push({
        rule,
        reason: `empty ProductPath for ${rule.recordName}; refusing to merge a non-pathed surcharge`,
      });
      continue;
    }
    if (!rule.typeName) {
      skips.push({ rule, reason: `no CML type tag found for the leaf product of ${rule.recordName}` });
      continue;
    }

    // [Fix #1] One comment-blanked view of the current `cml` reused by both the replace-anchor
    // search and the type-block search this iteration. Recomputed per-iteration because a prior
    // rule's splice may have mutated `cml`.
    const scan = blankComments(cml);

    // C2/M4/L1: only a REAL surcharge `rule(...)` statement carrying this exact key in the
    // action-scope slot counts as "present". A bare quoted-key substring inside an unrelated rule's
    // value, a longer key, or a comment must NOT trigger a destructive line replace.
    const stmt = findSurchargeStatement(cml, rule.ruleKey, scan);

    if (stmt) {
      // [Fix #2] Splice ONLY the matched statement span (`rule(...);`) rather than the entire
      // physical line. A curated line carrying two `rule(...);` statements (rare but valid) keeps
      // the unrelated statement intact. Block formatting is preserved as long as the matched
      // statement is the only thing on its line (the common case): the original indent prefix lives
      // in `cml[lineStart..stmt.start)` and is left untouched by the splice; only `cml[start..end)`
      // is replaced. If other code shares the line, that code stays in place verbatim too.
      cml = cml.slice(0, stmt.start) + rule.statement + cml.slice(stmt.end);
      placements.push({ rule, status: 'replaced' });
      placedKeys.add(rule.ruleKey);
      collectAttributeWarning(baseCml, rule, attributeWarnings, baseScan);
      continue;
    }

    const block = findTypeBlock(cml, rule.typeName, scan);
    if (!block) {
      skips.push({ rule, reason: `type block '${rule.typeName}' not found in existing model` });
      continue;
    }
    if ('ambiguous' in block) {
      skips.push({
        rule,
        reason: `type block '${rule.typeName}' is ambiguous (multiple/duplicate declarations) in existing model; skipping ${rule.recordName} rather than guessing`,
      });
      continue;
    }

    // Insert before the closing brace, indented one level (4 spaces), with a leading blank line.
    // [Fix #4] Use the dominant line ending of the original model, not a hardcoded `\n`.
    const insertion = `${eol}    ${rule.statement}${eol}`;
    cml = cml.slice(0, block.closeIdx) + insertion + cml.slice(block.closeIdx);
    placements.push({ rule, status: 'inserted' });
    placedKeys.add(rule.ruleKey);
    collectAttributeWarning(baseCml, rule, attributeWarnings, baseScan);
  }

  return { mergedCml: cml, placements, skips, attributeWarnings };
}

/**
 * Merges the underwriting `constraint <name> = (...)` statements into the existing CML text.
 * Mirrors {@link mergeSurchargeRules}'s insert/replace/skip shape, but for the constraint form
 * underwriting eligibility uses instead of a `rule(...)` action statement:
 *
 * - If a constraint with the same name already exists in the rule's leaf `type` block, its full
 * statement (from the `constraint` keyword through the terminating `;`) is replaced in place
 * (idempotent — re-running the merge with the same input reproduces the same output).
 * - Otherwise the statement is inserted just before the closing brace of the leaf `type` block.
 * - Before placing a rule's constraint, any of its `referencedAttributes` not already declared
 * anywhere in the leaf `type` block are auto-inserted (as `<cmlType> <attrName>;`) right after
 * the block's opening brace, and reported via `attributeWarnings` so the caller can log them —
 * unlike surcharge merge (which only WARNS about missing attributes, since injecting into the
 * curated model there was judged too risky for a `rule(...)` action statement), underwriting
 * constraints reference attributes that must resolve for the constraint to compile, so the
 * declaration is added rather than merely flagged.
 *
 * Rules with a blank ProductPath, no resolved leaf type tag, an ambiguous/duplicate type block, or
 * an intra-run duplicate (typeName, constraintName) pair are skipped (reported, never silently
 * dropped) — never throws on a single rule's failure.
 */
export function mergeUnderwritingConstraints(existingCml: string, rules: UnderwritingConstraintRule[]): UwMergeResult {
  let cml = existingCml;
  const placements: UwMergePlacement[] = [];
  const skips: UwMergeSkip[] = [];
  const attributeWarnings: string[] = [];
  const eol = detectDominantLineEnding(existingCml);

  // Mirrors mergeSurchargeRules' placedKeys guard: a second rule resolving to the same
  // (typeName, constraintName) pair must be reported as a collision skip, not treated as an
  // idempotent replace of the first rule's just-placed statement.
  const placedNames = new Set<string>();

  for (const rule of rules) {
    // Checked first, for the same reason as in mergeSurchargeRules.
    if (rule.unconvertibleReason) {
      skips.push({ rule, reason: rule.unconvertibleReason });
      continue;
    }

    if (rule.pathProductCodes.length === 0) {
      skips.push({
        rule,
        reason: `empty ProductPath for ${rule.recordName}; refusing to merge a non-pathed underwriting rule`,
      });
      continue;
    }
    if (!rule.typeName) {
      skips.push({ rule, reason: `no CML type tag found for the leaf product of ${rule.recordName}` });
      continue;
    }

    const placementKey = `${rule.typeName}::${rule.constraintName}`;
    if (placedNames.has(placementKey)) {
      skips.push({
        rule,
        reason: `duplicate constraint name '${rule.constraintName}' in type '${rule.typeName}' collides with another rule in this run (${rule.recordName} skipped)`,
      });
      continue;
    }

    // Recomputed per-iteration because a prior rule's splice (attribute insert, constraint
    // replace/insert) may have mutated `cml`.
    const scan = blankComments(cml);
    const block = findTypeBlock(cml, rule.typeName, scan);
    if (!block) {
      skips.push({ rule, reason: `type block '${rule.typeName}' not found in existing model` });
      continue;
    }
    if ('ambiguous' in block) {
      skips.push({
        rule,
        reason: `type block '${rule.typeName}' is ambiguous (multiple/duplicate declarations) in existing model; skipping ${rule.recordName} rather than guessing`,
      });
      continue;
    }

    // Warn (but do not auto-insert) when a referenced attribute is not declared in the type
    // block — matching the surcharge merge's behavior. The curated model is not mutated for
    // attributes; the operator must add them manually before import.
    for (const attr of rule.referencedAttributes) {
      const bodyScan = scan.slice(block.openIdx, block.closeIdx + 1);
      const declRe = new RegExp(`\\b${escapeRegExp(attr.cmlType)}\\s+${escapeRegExp(attr.name)}\\b`);
      if (declRe.test(bodyScan)) continue;
      attributeWarnings.push(
        `${rule.recordName}: declaration references '${attr.name}' which is absent from type '${rule.typeName}'`
      );
    }

    const stmt = findConstraintStatement(cml, block, rule.constraintName, scan);
    if (stmt) {
      // Splice ONLY the matched statement span (`constraint ... ;`), mirroring the precise-span
      // splice mergeSurchargeRules uses for its rule(...) replace path.
      cml = cml.slice(0, stmt.start) + rule.statement + cml.slice(stmt.end);
      placements.push({ rule, status: 'replaced' });
      placedNames.add(placementKey);
      continue;
    }

    // Insert before the closing brace, indented one level (4 spaces), with a leading blank line.
    const insertion = `${eol}    ${rule.statement}${eol}`;
    cml = cml.slice(0, block.closeIdx) + insertion + cml.slice(block.closeIdx);
    placements.push({ rule, status: 'inserted' });
    placedNames.add(placementKey);
  }

  return { mergedCml: cml, placements, skips, attributeWarnings };
}

/**
 * Finds the single `constraint <name> = (...)` statement carrying `constraintName` INSIDE the
 * given `block` (the rule's leaf `type` block) and returns the precise start/end offsets of the
 * whole statement (from the `constraint` keyword through the terminating `;`), so the caller can
 * splice only that statement in place. Scoped to `block` so a same-named constraint in a sibling
 * type block is never mistaken for a match. Runs against the comment-blanked `scan` view (see
 * {@link findSurchargeStatement}'s companion rationale) so a constraint-shaped string sitting
 * inside a comment can't be clobbered.
 */
function findConstraintStatement(
  cml: string,
  block: TypeBlock,
  constraintName: string,
  scan: string
): StatementMatch | undefined {
  const bodyScan = scan.slice(block.openIdx, block.closeIdx + 1);
  const anchor = new RegExp(`constraint\\s+${escapeRegExp(constraintName)}\\s*=\\s*\\(`);
  const m = anchor.exec(bodyScan);
  if (!m) return undefined;

  const start = block.openIdx + m.index;
  const semi = findStructuralSemicolon(scan, start + m[0].length);
  if (semi === undefined) {
    // Malformed unterminated constraint(...) — refuse to splice rather than guessing.
    return undefined;
  }
  return { start, end: semi + 1 };
}

/**
 * [Fix #2] Precise span of a matched surcharge statement.
 *
 * - `start`  — offset of the matched `rule(` token in the original cml
 * - `end`    — offset just AFTER the terminating `;` (so cml.slice(start, end) is the whole statement)
 *
 * The previous shape (`lineStart..lineEnd`) replaced the entire physical line, which silently
 * clobbered any OTHER `rule(...);` statement that happened to share that line. The precise span
 * splices ONLY the matched statement and leaves other statements on the same line intact.
 */
type StatementMatch = { start: number; end: number };

/**
 * C2/M4/L1: finds the single-line surcharge `rule(...)` statement that carries `ruleKey` in the
 * action-scope slot — i.e. `rule(<decl>, "InsuranceSurchargeRule", "<ruleKey>", ...`. Only such a
 * real statement is a legitimate replace target. A bare `"<ruleKey>"` substring appearing inside an
 * unrelated rule's VALUE, inside a `//` line comment, inside a `/* *\/` block comment, or as part of
 * a LONGER key is deliberately NOT matched, so the caller falls through to the insert path instead of
 * clobbering curated text.
 *
 * Comment-awareness: the anchor scan runs against a length-preserving COPY of `cml` in which every
 * character inside a `//`/`/* *\/` comment is blanked to a space (newlines kept). Offsets into that
 * copy therefore map 1:1 onto the original, so the returned line span still slices the real text —
 * but a rule-shaped string sitting inside a (single- or multi-line) block comment can no longer match
 * the anchor and be clobbered.
 *
 * Returns the start/end offsets of the matched line (lineEnd points at the newline / EOF, excluding
 * any trailing `\r` so the caller can re-emit the original CRLF/LF).
 */
function findSurchargeStatement(
  cml: string,
  ruleKey: string,
  scan: string = blankComments(cml)
): StatementMatch | undefined {
  // [Fix #2] Match the surcharge rule statement and return the PRECISE span from the `rule(` token
  // to just past its terminating `;`. The previous implementation returned a whole-line span which
  // clobbered any OTHER `rule(...);` statement sharing the same physical line. The global flag is
  // required so a coincidental earlier match (e.g. an unrelated rule whose VALUE quotes the key
  // before the real statement) can be skipped by walking to subsequent matches via `exec`. We do
  // NOT use a single-line anchor: a real surcharge statement is single-line by convention, but the
  // anchor's `[^;\r\n]*` constraint already guarantees the prefix is single-line; what matters here
  // is bounding the SPAN, not the search.
  const anchor = new RegExp(
    `rule\\([^;\\r\\n]*"${escapeRegExp(SURCHARGE_RULE_ACTION)}"\\s*,\\s*"${escapeRegExp(ruleKey)}"\\s*,`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(scan)) !== null) {
    const start = m.index;
    // Walk forward in the SCAN view (comment chars blanked) to find the terminating `;`. Using scan
    // keeps a `;` that lives inside a `// ...` or `/* ... */` comment from terminating the span.
    // String-literal contents within the statement are kept intact by blankComments, so a `;` inside
    // a quoted RHS value is also ignored — find the structural `;` by walking past string literals.
    const semi = findStructuralSemicolon(scan, m.index + m[0].length);
    if (semi === undefined) {
      // Malformed unterminated rule(...) — refuse to splice rather than guessing.
      return undefined;
    }
    return { start, end: semi + 1 };
  }
  return undefined;
}

/**
 * [Fix #2] Walks forward from `from` returning the index of the structural `;` terminating the
 * current statement. The scan is comment-blanked, so `;` inside `//` or `/* *\/` cannot terminate.
 * Double-quoted string literals are still present in the scan (blankComments only blanks comments);
 * skip them here so a `;` inside a quoted value is ignored.
 */
function findStructuralSemicolon(scan: string, from: number): number | undefined {
  let inString = false;
  for (let i = from; i < scan.length; i++) {
    const ch = scan[i];
    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === ';') {
      return i;
    }
  }
  return undefined;
}

/**
 * Returns a copy of `cml` with identical length where every character inside a `//` line comment or
 * a `/* *\/` block comment is replaced by a space (newlines preserved). Used so the replace-anchor
 * scan can ignore comment contents without losing offset alignment with the original text. String
 * literals are left intact: the anchor itself requires the literal `"InsuranceSurchargeRule"` action
 * token, so a same-key VALUE inside another rule's string still won't satisfy the action-scope shape.
 */
export function blankComments(cml: string): string {
  const out = cml.split('');
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < cml.length; i++) {
    const ch = cml[i];
    const next = cml[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      else out[i] = ' ';
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        inBlockComment = false;
      } else if (ch !== '\n') {
        out[i] = ' ';
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char (left intact)
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
    } else if (ch === '"') {
      inString = true;
    }
  }
  return out.join('');
}

/**
 * Surfaces (does not auto-fix) rule declarations that reference an attribute not present anywhere in
 * the curated model. In merge mode we never inject `string <attr>;` into the curated model, so an
 * unknown attribute would fail to compile on import — better to warn the engineer than to mangle the
 * Gold Standard. Attributes already present are trusted to be visible via the coverage type hierarchy.
 *
 * IMPORTANT: `baseCml` must be the ORIGINAL model text, captured before any surcharge statement was
 * spliced in. Checking the post-insertion text would always find the attribute inside the rule's own
 * just-inserted declaration (which sanitizes attribute names identically), suppressing every warning.
 */
function collectAttributeWarning(
  baseCml: string,
  rule: PathedSurchargeRule,
  warnings: string[],
  baseScan?: string
): void {
  // H5/M3: scope the presence check to the leaf type block plus its `: Parent` ancestry, with
  // comments and string literals stripped. CML attribute visibility is hierarchy-scoped, so an
  // unscoped whole-file `\battr\b` test gives false negatives (an attribute named only in a comment,
  // a string value, or an unrelated SIBLING type would wrongly suppress a real absent-attribute
  // warning).
  //
  // H5 (fallback facet): when the leaf scope can't be resolved — typeName is undefined, or the leaf
  // `type` block is ambiguous/duplicate so collectTypeScopeText returns undefined — we have NO
  // hierarchy-scoped view to prove the attribute is visible. We must NOT widen to the whole model
  // (that re-introduces the sibling-type false negative on exactly the records that hit the replace
  // path before type resolution). Fail VISIBLE instead: treat the scope as empty so an attribute we
  // cannot prove visible is reported, never silently suppressed.
  const scope = rule.typeName ? collectTypeScopeText(baseCml, rule.typeName, undefined, baseScan) ?? '' : '';

  for (const attr of rule.referencedAttributes) {
    const present = new RegExp(`\\b${escapeRegExp(attr)}\\b`).test(scope);
    if (!present) {
      warnings.push(`${rule.recordName}: declaration references '${attr}' which is absent from the model`);
    }
  }
}

/**
 * Removes `//` line comments, `/* *\/` block comments, and double-quoted string-literal CONTENTS
 * from CML text so that attribute-presence checks match only real declarations/expressions, never a
 * name that merely appears in a comment or a string value. String delimiters are kept so structure
 * is preserved; only the interior characters are blanked.
 */
function stripCommentsAndStrings(cml: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < cml.length; i++) {
    const ch = cml[i];
    const next = cml[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped char (and drop it)
      } else if (ch === '"') {
        inString = false;
        out += '"';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (ch === '"') {
      inString = true;
      out += '"';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Builds the comment/string-stripped text of the leaf `type <name> { ... }` block plus every
 * `: Parent` ancestor block reachable in the model, concatenated. Returns undefined when the leaf
 * block can't be resolved (or is ambiguous), so the caller can fall back. Bounded against cycles by
 * a visited set.
 */
function collectTypeScopeText(
  cml: string,
  leafType: string,
  visited = new Set<string>(),
  scan: string = blankComments(cml)
): string | undefined {
  if (visited.has(leafType)) return '';
  visited.add(leafType);

  const block = findTypeBlock(cml, leafType, scan);
  if (!block || 'ambiguous' in block) return undefined;

  const headerStart = cml.lastIndexOf('\n', block.openIdx) + 1;
  const header = cml.slice(headerStart, block.openIdx);
  const body = cml.slice(block.openIdx, block.closeIdx + 1);
  let text = stripCommentsAndStrings(body);

  // Resolve `type Leaf : Parent {` ancestry and append parent scope(s).
  const parentMatch = /:\s*([A-Za-z_]\w*)/.exec(header);
  if (parentMatch) {
    const parentText = collectTypeScopeText(cml, parentMatch[1], visited, scan);
    if (parentText) text += '\n' + parentText;
  }
  return text;
}
