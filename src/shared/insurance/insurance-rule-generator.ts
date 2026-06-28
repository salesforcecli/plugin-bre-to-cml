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
import { ASSOCIATION_TYPES, CML_DATA_TYPES, CONSTRAINT_TYPES } from '../constants/constants.js';
import { Association, CmlAttribute, CmlConstraint, CmlModel, CmlType } from '../types/types.js';
import { convertToCmlExpression, isKnownOperator, operatorRequiresValues } from '../cml-operators.js';
import {
  ParsedRuleDefinition,
  RuleCondition,
  RuleCriteria,
  RuleKeyEntry,
  RuleRecord,
  UnderwritingRuleGroup,
} from './models.js';

function dataTypeToCml(dataType?: string): string {
  const types: Record<string, string> = {
    Number: CML_DATA_TYPES.INTEGER,
    Integer: CML_DATA_TYPES.INTEGER,
    Percent: CML_DATA_TYPES.DECIMAL,
    Currency: CML_DATA_TYPES.DECIMAL,
    Boolean: CML_DATA_TYPES.BOOLEAN,
    Date: CML_DATA_TYPES.DATE,
    DateTime: CML_DATA_TYPES.DATE,
  };
  return (dataType && types[dataType]) ?? CML_DATA_TYPES.STRING;
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Decodes the common HTML entities that can appear in a RuleDefinition / DynamicRuleDefinition
 * field when the JSON was persisted HTML-escaped. `&amp;` is decoded last so already-decoded
 * ampersands are not double-processed.
 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripSpaces(stage: string): string {
  return stage.replace(/\s+/g, '');
}

export function buildStageTransition(ruleGroup?: UnderwritingRuleGroup): string | undefined {
  if (!ruleGroup?.fromStage || !ruleGroup?.toStage) return undefined;
  return `${stripSpaces(ruleGroup.fromStage)}To${stripSpaces(ruleGroup.toStage)}`;
}

export function generateRuleKey(
  prefix: string,
  productCode: string,
  apiName: string,
  stageTransition?: string
): string {
  const parts = [prefix, sanitizeName(productCode)];
  if (stageTransition) parts.push(stageTransition);
  parts.push(sanitizeName(apiName));
  return parts.join('__');
}

// Relational operators (<, <=, >, >=) ALWAYS interpolate their RHS unquoted, regardless of
// dataType. Equals/NotEquals interpolate unquoted whenever the resolved cmlDataType is NOT
// CML_DATA_TYPES.STRING (the shared emitter only quotes when dataType === 'string'). Either way an
// unquoted, attacker-influenced value (e.g. `2020) || evil(`) would reach the curated model
// verbatim, so every value on an unquoted-emission condition must be a bare safe literal.
const ALWAYS_UNQUOTED_OPERATORS: ReadonlySet<string> = new Set([
  'LessThan',
  'LessThanOrEquals',
  'GreaterThan',
  'GreaterThanOrEquals',
]);

// Operators that emit a value via doubleQuotedIfNeeded — unquoted unless cmlDataType === STRING.
const VALUE_EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['Equals', 'NotEquals']);

function isSafeNumericLiteral(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function isSafeBooleanLiteral(value: string): boolean {
  return /^(true|false)$/.test(value.trim());
}

// Bare date / datetime literal: YYYY-MM-DD optionally followed by an ISO-8601 time component. No
// parens, operators, or whitespace that could break out of the unquoted slot.
function isSafeDateLiteral(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value.trim());
}

// A value is safe to emit unquoted only if it is a bare literal of the target CML type. Anything
// that isn't (including strings, which must never reach an unquoted slot) is rejected.
function isSafeUnquotedLiteral(value: string, cmlDataType: string): boolean {
  switch (cmlDataType) {
    case CML_DATA_TYPES.INTEGER:
    case CML_DATA_TYPES.DECIMAL:
      return isSafeNumericLiteral(value);
    case CML_DATA_TYPES.BOOLEAN:
      return isSafeBooleanLiteral(value);
    case CML_DATA_TYPES.DATE:
      return isSafeDateLiteral(value);
    default:
      return false;
  }
}

// A value destined for a string-quoted slot must be safely single-line quotable. The shared
// escapeQuotes escapes ' and " but NOT backslash, so a value containing a backslash (e.g. ending
// in `\`, or a `\"` sequence) can escape its own closing quote and break out into raw CML. Reject
// any backslash, plus newlines that would split the single-line literal.
function isSafeQuotableString(value: string): boolean {
  return !/[\\\r\n]/.test(value);
}

/**
 * Whether a product Name is safe to emit as a Type association's reference value
 * (`$Product2ReferenceId`). That value travels two unescaped hops we do NOT own and cannot change:
 * the naive comma-joined `_Associations.csv` column (a comma shifts every later column), and the
 * common `cml import as-expression-set` resolver's single-quoted SOQL `WHERE Name IN ('<value>')`
 * (a single quote breaks out of the literal; a backslash or newline corrupts the row).
 * A Name failing this guard is dropped by the convert layer (it falls back to the ProductCode and
 * warns) rather than silently producing a corrupt CSV / injecting SOQL. An empty / whitespace-only
 * Name is also rejected — it can never match a real Product2 by name. Mirrors the reject-don't-escape
 * stance of {@link isSafeQuotableString} for condition values.
 */
export function isSafeAssociationReferenceValue(value: string): boolean {
  if (value.trim().length === 0) return false;
  return !/[,'"\\\r\n]/.test(value);
}

function buildConditionExpression(condition: RuleCondition): string | null {
  if (!isKnownOperator(condition.operator)) return null;

  const op = condition.operator;
  if (operatorRequiresValues(op) && (!condition.values || condition.values.length === 0)) {
    return null;
  }

  const values = condition.values ?? [];
  const cmlDataType = dataTypeToCml(condition.dataType);

  // Determine whether this operator/dataType pair emits its RHS UNQUOTED. Relational operators
  // always do; Equals/NotEquals do whenever the cmlDataType is not STRING. On the unquoted path we
  // require every value to be a bare safe literal; otherwise the value would land in the curated
  // model verbatim and could inject CML or produce a type-unsafe comparison. A failing value drops
  // the condition (the caller filters nulls), exactly as an unknown operator or missing value does.
  const emitsUnquoted =
    ALWAYS_UNQUOTED_OPERATORS.has(op) || (VALUE_EQUALITY_OPERATORS.has(op) && cmlDataType !== CML_DATA_TYPES.STRING);

  if (emitsUnquoted) {
    if (!values.every((v) => isSafeUnquotedLiteral(v, cmlDataType))) {
      return null;
    }
  } else if (!values.every(isSafeQuotableString)) {
    // String-quoted path: reject values the shared escaper cannot safely contain (backslash, etc.).
    return null;
  }

  const attrName = sanitizeName(condition.attributeName ?? condition.contextTagName ?? 'unknown');
  return convertToCmlExpression(attrName, op, condition.values, cmlDataType);
}

function buildCriteriaExpression(criteria: RuleCriteria): string | null {
  const parts: string[] = [];

  if (criteria.conditions) {
    for (const condition of criteria.conditions) {
      const expr = buildConditionExpression(condition);
      if (expr) parts.push(expr);
    }
  }

  return parts.length > 0 ? parts.join(' && ') : null;
}

export function buildConstraintDeclaration(ruleDef: { ruleCriteria?: RuleCriteria[] }): string {
  if (!ruleDef.ruleCriteria || ruleDef.ruleCriteria.length === 0) {
    return 'true';
  }

  const expressions = ruleDef.ruleCriteria.map(buildCriteriaExpression).filter((e): e is string => e !== null);

  if (expressions.length === 0) return 'true';
  if (expressions.length === 1) return expressions[0];
  return expressions.map((e) => `(${e})`).join(' || ');
}

export function collectAttributes(ruleDefs: Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>): Set<string> {
  const attrs = new Set<string>();
  for (const { ruleDef } of ruleDefs) {
    for (const criteria of ruleDef.ruleCriteria ?? []) {
      for (const cond of criteria.conditions ?? []) {
        const name = cond.attributeName ?? cond.contextTagName;
        if (name) attrs.add(name);
      }
    }
  }
  return attrs;
}

/**
 * Collects only the attributes that actually reach the emitted CML — i.e. those on conditions whose
 * `buildConditionExpression` returned a non-null expression. Conditions dropped by the safe-literal
 * guard, an unknown operator, or missing values do NOT contribute their attribute. This is the
 * companion to `collectAttributes` for merge-mode attribute-presence warnings: warning about an
 * attribute the declaration never emitted (because the guard dropped its condition) is spurious
 * noise on exactly the inputs the guard sanitized. Unlike `collectAttributes`, names are returned
 * sanitized to match how they appear in the emitted declaration.
 */
export function collectEmittedAttributes(ruleDefs: Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>): Set<string> {
  const attrs = new Set<string>();
  for (const { ruleDef } of ruleDefs) {
    for (const criteria of ruleDef.ruleCriteria ?? []) {
      for (const cond of criteria.conditions ?? []) {
        if (buildConditionExpression(cond) === null) continue;
        const name = cond.attributeName ?? cond.contextTagName;
        if (name) attrs.add(sanitizeName(name));
      }
    }
  }
  return attrs;
}

/**
 * Derives the real CML data type for each collected attribute from its condition `dataType`.
 * When an attribute appears with more than one distinct CML type (a conflict), or its type is
 * unknown, it falls back to STRING. Returned alongside (not replacing) the Set from
 * collectAttributes, which merge mode still depends on.
 */
export function collectAttributeTypes(
  ruleDefs: Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>
): Map<string, string> {
  const types = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const { ruleDef } of ruleDefs) {
    for (const criteria of ruleDef.ruleCriteria ?? []) {
      for (const cond of criteria.conditions ?? []) {
        const name = cond.attributeName ?? cond.contextTagName;
        if (!name) continue;
        const cmlType = dataTypeToCml(cond.dataType);
        const existing = types.get(name);
        if (existing === undefined) {
          types.set(name, cmlType);
        } else if (existing !== cmlType) {
          conflicting.add(name);
        }
      }
    }
  }
  for (const name of conflicting) {
    types.set(name, CML_DATA_TYPES.STRING);
  }
  return types;
}

export function buildCmlModel(
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  keyPrefix: string,
  constraintLabel: string,
  // When set, eligibility is emitted as a CML `rule(decl, "<ruleType>", "<ruleKey>", "True")`
  // statement instead of a `constraint NAME = (decl, "label");`. Surcharge passes
  // 'InsuranceSurchargeRule'; underwriting leaves it undefined to keep the constraint form.
  ruleType?: string,
  // Maps a root product id to its Product2 Name. The common `cml import as-expression-set` resolves
  // each Type association's Product2 by NAME (`WHERE Name IN (<$Product2ReferenceId>)`), so the Name
  // — not the ProductCode — must land in the association reference value or the importer silently
  // drops the binding. Optional + last so the legacy (code-as-reference) call sites stay valid; the
  // convert layer supplies only Names that passed isSafeAssociationReferenceValue, hence the
  // unconditional ProductCode fallback below for any product missing a safe Name.
  productIdToName?: Map<string, string>
): { cmlModel: CmlModel; ruleKeyMapping: RuleKeyEntry[] } {
  const cmlModel = new CmlModel();

  const rulesByProduct = new Map<string, Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>>();
  for (const entry of ruleDefs) {
    // Trim the root segment so leading/trailing whitespace can't split one product into two
    // groups, and skip a rule with a blank ProductPath (it can't be nested under any product)
    // instead of materializing an empty-named type. Mirrors the trimming in
    // collectAllProductIds / collectRootProductIds.
    const rootProductId = entry.record.ProductPath.split('/')[0]?.trim();
    if (!rootProductId) continue;
    if (!rulesByProduct.has(rootProductId)) {
      rulesByProduct.set(rootProductId, []);
    }
    rulesByProduct.get(rootProductId)!.push(entry);
  }

  const ruleKeyMapping: RuleKeyEntry[] = [];

  for (const [rootProductId, productRules] of rulesByProduct) {
    const productCode = productIdToCode.get(rootProductId) ?? rootProductId;
    const typeName = sanitizeName(productCode);
    const productType = new CmlType(typeName, undefined, undefined);

    const attrs = collectAttributes(productRules);
    const attrTypes = collectAttributeTypes(productRules);
    for (const attrName of attrs) {
      const cmlType = attrTypes.get(attrName) ?? CML_DATA_TYPES.STRING;
      productType.addAttribute(new CmlAttribute(null, sanitizeName(attrName), cmlType));
    }

    for (const { record, ruleDef } of productRules) {
      const apiName = ruleDef.apiName ?? record.Name;
      const stageTransition = buildStageTransition(ruleDef.underwritingRuleGroup);
      const ruleKey = generateRuleKey(keyPrefix, productCode, apiName, stageTransition);

      const declaration = buildConstraintDeclaration(ruleDef);
      const constraint = ruleType
        ? CmlConstraint.createRuleConstraint(declaration, ruleType, ruleKey, 'True')
        : new CmlConstraint(CONSTRAINT_TYPES.CONSTRAINT, declaration, `"${constraintLabel}: ${record.Name}"`);
      // Mirror generateRuleKey: include the stage transition so two rules that share an
      // apiName under the same product (gated on different transitions) don't collide.
      constraint.name = sanitizeName(stageTransition ? `${apiName}_${stageTransition}` : apiName);
      productType.addConstraint(constraint);

      ruleKeyMapping.push({ recordId: record.Id, name: record.Name, ruleKey });
    }

    cmlModel.addType(productType);
    // tag/type name stay ProductCode-derived (the CML doc keys off them); only the reference value
    // — what the common importer resolves the Product2 by — becomes the Name. Fall back to the
    // ProductCode when no safe Name was supplied (preserves legacy behavior for code-only callers).
    const referenceValue = productIdToName?.get(rootProductId) ?? productCode;
    cmlModel.addAssociation(
      new Association(null, typeName, ASSOCIATION_TYPES.TYPE, rootProductId, 'Product2', referenceValue)
    );
  }

  return { cmlModel, ruleKeyMapping };
}
