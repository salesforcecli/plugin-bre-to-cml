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
import { ParsedRuleDefinition, RuleRecord } from './models.js';
import {
  buildConstraintDeclaration,
  collectAttributes,
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
 * order) + sanitize(apiName), joined by `__`. The Core surcharge engine matches the fired CML rule
 * key against that auto-generated RuleKey by exact string, so the CML rule key MUST be pathed too.
 */

export const SURCHARGE_RULE_ACTION = 'InsuranceSurchargeRule';

export type PathedSurchargeRule = {
  recordId: string;
  recordName: string;
  apiName: string;
  /** Full pathed key: SC__<code-of-each-path-segment>__<apiName>. */
  ruleKey: string;
  /** Leaf CML type name (ConstraintModelTag of the LAST ProductPath segment). */
  typeName: string | undefined;
  /** The generated `rule(<decl>, "InsuranceSurchargeRule", "<ruleKey>", "True");` statement. */
  statement: string;
  /** Sanitized attribute names referenced by the rule declaration (for visibility warnings). */
  referencedAttributes: string[];
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

/** Splits a `ProductPath` into its ordered Product2 ids (slash-separated). */
export function splitProductPath(productPath: string): string[] {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TypeBlock = { openIdx: number; closeIdx: number };

/**
 * Locates a `type <name> [: Parent] { ... }` block and returns the index of its opening brace and
 * its brace-matched closing brace. Block-less forward declarations (`type X : Y;`) are skipped
 * because the regex requires a `{` before any `;`. Word-boundary after the name keeps `Auto` from
 * matching `AutoSilver`/`AutoDriver`.
 */
function findTypeBlock(cml: string, typeName: string): TypeBlock | undefined {
  const re = new RegExp(`(^|\\n)\\s*type\\s+${escapeRegExp(typeName)}\\b[^{;]*\\{`);
  const m = re.exec(cml);
  if (!m) return undefined;

  const openIdx = cml.indexOf('{', m.index);
  if (openIdx < 0) return undefined;

  // Brace-match while skipping braces that appear inside double-quoted string literals (a CML rule
  // declaration can carry an arbitrary string value such as `make == "weird}brace"`). Without this,
  // a `}` inside a quoted value is mistaken for the block's closing brace and we return a too-early
  // closeIdx, splicing the new rule into the middle of an existing statement.
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < cml.length; i++) {
    const ch = cml[i];
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped character
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { openIdx, closeIdx: i };
    }
  }
  return undefined;
}

/** Builds the `rule(...)` statement for a surcharge, using the same constraint generator as build mode. */
export function buildSurchargeRuleStatement(declaration: string, ruleKey: string): string {
  return CmlConstraint.createRuleConstraint(declaration, SURCHARGE_RULE_ACTION, ruleKey, 'True').generateCml();
}

/**
 * Prepares the pathed-rule descriptors for a set of parsed surcharge records.
 * `productIdToCode` and `productIdToType` must already cover every ProductPath segment.
 */
export function buildPathedSurchargeRules(
  prefix: string,
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  productIdToType: Map<string, string>
): PathedSurchargeRule[] {
  return ruleDefs.map(({ record, ruleDef }) => {
    const apiName = ruleDef.apiName ?? record.Name;
    const segments = splitProductPath(record.ProductPath);
    const pathCodes = segments.map((id) => productIdToCode.get(id) ?? id);
    const stageTransition = buildStageTransition(ruleDef.underwritingRuleGroup);
    const ruleKey = buildPathedRuleKey(prefix, pathCodes, apiName, stageTransition);

    const leafProductId = segments[segments.length - 1];
    const typeName = leafProductId ? productIdToType.get(leafProductId) : undefined;

    const declaration = buildConstraintDeclaration(ruleDef);
    const statement = buildSurchargeRuleStatement(declaration, ruleKey);
    const referencedAttributes = Array.from(collectAttributes([{ ruleDef }])).map(sanitizeName);

    return {
      recordId: record.Id,
      recordName: record.Name,
      apiName,
      ruleKey,
      typeName,
      statement,
      referencedAttributes,
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

  for (const rule of rules) {
    const quotedKey = `"${rule.ruleKey}"`;
    const keyIdx = cml.indexOf(quotedKey);

    if (keyIdx >= 0) {
      // Replace the whole line that carries this key (rule statements are single-line here).
      const lineStart = cml.lastIndexOf('\n', keyIdx) + 1;
      let lineEnd = cml.indexOf('\n', keyIdx);
      if (lineEnd < 0) lineEnd = cml.length;
      const indentMatch = /^\s*/.exec(cml.slice(lineStart, lineEnd));
      const indent = indentMatch ? indentMatch[0] : '    ';
      cml = cml.slice(0, lineStart) + indent + rule.statement + cml.slice(lineEnd);
      placements.push({ rule, status: 'replaced' });
      collectAttributeWarning(baseCml, rule, attributeWarnings);
      continue;
    }

    if (!rule.typeName) {
      skips.push({ rule, reason: `no CML type tag found for the leaf product of ${rule.recordName}` });
      continue;
    }

    const block = findTypeBlock(cml, rule.typeName);
    if (!block) {
      skips.push({ rule, reason: `type block '${rule.typeName}' not found in existing model` });
      continue;
    }

    // Insert before the closing brace, indented one level (4 spaces), with a leading blank line.
    const insertion = `\n    ${rule.statement}\n`;
    cml = cml.slice(0, block.closeIdx) + insertion + cml.slice(block.closeIdx);
    placements.push({ rule, status: 'inserted' });
    collectAttributeWarning(baseCml, rule, attributeWarnings);
  }

  return { mergedCml: cml, placements, skips, attributeWarnings };
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
function collectAttributeWarning(baseCml: string, rule: PathedSurchargeRule, warnings: string[]): void {
  for (const attr of rule.referencedAttributes) {
    const present = new RegExp(`\\b${escapeRegExp(attr)}\\b`).test(baseCml);
    if (!present) {
      warnings.push(`${rule.recordName}: declaration references '${attr}' which is absent from the model`);
    }
  }
}
