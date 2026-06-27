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
  collectEmittedAttributes,
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
 * Brace-matches the block whose opening `{` is at `openIdx` and returns the index of its matched
 * closing `}`. The scanner ignores `{`/`}`/`"` that appear inside double-quoted string literals,
 * `//` line comments, and `/* *\/` block comments — a curated Gold-Standard model routinely carries
 * comments, and a stray `}` inside one (or inside a quoted rule value) must NOT be mistaken for the
 * structural close, which would return a too-early closeIdx and splice a new rule mid-statement.
 */
function matchClosingBrace(cml: string, openIdx: number): number | undefined {
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
function findTypeBlock(cml: string, typeName: string): TypeBlock | { ambiguous: true } | undefined {
  const re = new RegExp(`(^|\\n)[ \\t]*type[ \\t]+${escapeRegExp(typeName)}\\b[^{;]*\\{`, 'g');
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cml)) !== null) {
    const openIdx = cml.indexOf('{', m.index);
    if (openIdx >= 0) matches.push(openIdx);
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return { ambiguous: true };

  const openIdx = matches[0];
  const closeIdx = matchClosingBrace(cml, openIdx);
  if (closeIdx === undefined) return undefined;
  return { openIdx, closeIdx };
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
    // M7: only attributes from conditions that actually emitted CML (non-null buildConditionExpression)
    // count as "referenced". Attributes from conditions the safe-literal guard / unknown-operator
    // filter dropped never appear in the declaration, so warning about them would be spurious noise.
    const referencedAttributes = Array.from(collectEmittedAttributes([{ ruleDef }]));

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

  // H1: keys this run has already placed. A second rule resolving to the same pathed key must be
  // reported as a collision skip, NOT treated as an idempotent replace of the first rule's
  // just-inserted statement (which would silently drop the second record's distinct declaration).
  const placedKeys = new Set<string>();

  for (const rule of rules) {
    if (placedKeys.has(rule.ruleKey)) {
      skips.push({
        rule,
        reason: `duplicate pathed rule key '${rule.ruleKey}' collides with another rule in this run (${rule.recordName} skipped)`,
      });
      continue;
    }

    // C2/M4/L1: only a REAL surcharge `rule(...)` statement carrying this exact key in the
    // action-scope slot counts as "present". A bare quoted-key substring inside an unrelated rule's
    // value, a longer key, or a comment must NOT trigger a destructive line replace.
    const stmt = findSurchargeStatement(cml, rule.ruleKey);

    if (stmt) {
      // L2: preserve the original line ending (CRLF vs LF) of the replaced line.
      const indentMatch = /^[ \t]*/.exec(cml.slice(stmt.lineStart, stmt.lineEnd));
      const indent = indentMatch ? indentMatch[0] : '    ';
      cml = cml.slice(0, stmt.lineStart) + indent + rule.statement + cml.slice(stmt.lineEnd);
      placements.push({ rule, status: 'replaced' });
      placedKeys.add(rule.ruleKey);
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
    if ('ambiguous' in block) {
      skips.push({
        rule,
        reason: `type block '${rule.typeName}' is ambiguous (multiple/duplicate declarations) in existing model; skipping ${rule.recordName} rather than guessing`,
      });
      continue;
    }

    // Insert before the closing brace, indented one level (4 spaces), with a leading blank line.
    const insertion = `\n    ${rule.statement}\n`;
    cml = cml.slice(0, block.closeIdx) + insertion + cml.slice(block.closeIdx);
    placements.push({ rule, status: 'inserted' });
    placedKeys.add(rule.ruleKey);
    collectAttributeWarning(baseCml, rule, attributeWarnings);
  }

  return { mergedCml: cml, placements, skips, attributeWarnings };
}

type StatementMatch = { lineStart: number; lineEnd: number };

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
function findSurchargeStatement(cml: string, ruleKey: string): StatementMatch | undefined {
  const anchor = new RegExp(
    `rule\\([^;\\r\\n]*"${escapeRegExp(SURCHARGE_RULE_ACTION)}"\\s*,\\s*"${escapeRegExp(ruleKey)}"\\s*,`
  );
  // Comment-blanked, length-preserving view of the model: matching against this view ignores any
  // rule-shaped text that lives inside `//` or `/* */` comments while keeping every offset aligned
  // with the original `cml` so the returned span still references the real (un-blanked) text.
  const scan = blankComments(cml);
  let lineStart = 0;
  while (lineStart <= scan.length) {
    const nl = scan.indexOf('\n', lineStart);
    const rawEnd = nl < 0 ? scan.length : nl;
    const line = scan.slice(lineStart, rawEnd);
    if (anchor.test(line)) {
      // Strip a trailing \r from the matched line span so CRLF can be preserved by the caller.
      const lineEnd = rawEnd > lineStart && cml[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
      return { lineStart, lineEnd };
    }
    if (nl < 0) break;
    lineStart = nl + 1;
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
function blankComments(cml: string): string {
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
function collectAttributeWarning(baseCml: string, rule: PathedSurchargeRule, warnings: string[]): void {
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
  const scope = rule.typeName ? collectTypeScopeText(baseCml, rule.typeName) ?? '' : '';

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
function collectTypeScopeText(cml: string, leafType: string, visited = new Set<string>()): string | undefined {
  if (visited.has(leafType)) return '';
  visited.add(leafType);

  const block = findTypeBlock(cml, leafType);
  if (!block || 'ambiguous' in block) return undefined;

  const headerStart = cml.lastIndexOf('\n', block.openIdx) + 1;
  const header = cml.slice(headerStart, block.openIdx);
  const body = cml.slice(block.openIdx, block.closeIdx + 1);
  let text = stripCommentsAndStrings(body);

  // Resolve `type Leaf : Parent {` ancestry and append parent scope(s).
  const parentMatch = /:\s*([A-Za-z_]\w*)/.exec(header);
  if (parentMatch) {
    const parentText = collectTypeScopeText(cml, parentMatch[1], visited);
    if (parentText) text += '\n' + parentText;
  }
  return text;
}
