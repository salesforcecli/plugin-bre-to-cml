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

/**
 * Source data type -> CML data type. Keyed uppercase because payloads are inconsistent about case
 * ('Datetime' and 'DateTime' both occur in real RuleDefinitions) — the same normalization
 * PcmGenerator's `dataTypeToCmlType` applies to its own keys.
 *
 * PcmGenerator declares these same attributes into the same model, so wherever both maps hold a
 * key they must resolve it identically or one attribute ends up with two contradictory
 * declarations. They do not otherwise mirror each other: this map additionally carries the
 * spellings only a condition payload or an AttributePicklist produces (INTEGER, DECIMAL, DOUBLE,
 * BOOLEAN, DATETIME), for which PcmGenerator has no entry.
 */
const SOURCE_DATA_TYPE_TO_CML: Record<string, string> = {
  // decimal, not int: a Salesforce Number attribute may carry decimal places, and PcmGenerator
  // declares one `decimal` in this same model.
  NUMBER: CML_DATA_TYPES.DECIMAL,
  INTEGER: CML_DATA_TYPES.INTEGER,
  PERCENT: CML_DATA_TYPES.DECIMAL,
  CURRENCY: CML_DATA_TYPES.DECIMAL,
  DECIMAL: CML_DATA_TYPES.DECIMAL,
  DOUBLE: CML_DATA_TYPES.DECIMAL,
  BOOLEAN: CML_DATA_TYPES.BOOLEAN,
  // 'Checkbox' is what AttributeDefinition.DataType calls a boolean attribute (AttributePicklist
  // spells the same thing 'Boolean'), and fetchAttributeDataTypes passes it through verbatim.
  CHECKBOX: CML_DATA_TYPES.BOOLEAN,
  DATE: CML_DATA_TYPES.DATE,
  DATETIME: CML_DATA_TYPES.DATE,
  TEXT: CML_DATA_TYPES.STRING,
  STRING: CML_DATA_TYPES.STRING,
};

/**
 * Resolves a source data type to a CML data type. An absent or unrecognized type falls back to
 * STRING, which quotes the value — the conservative direction, since an unquoted value reaches the
 * curated model verbatim.
 *
 * The `!dataType` guard also covers the empty string. Returning '' would be neither a known type
 * nor STRING, so the value would take the unquoted path, fail the safe-literal guard, drop its
 * condition, and collapse the whole declaration to `true` — a rule that then applies to everything.
 */
function dataTypeToCml(dataType?: string): string {
  if (!dataType) return CML_DATA_TYPES.STRING;
  return SOURCE_DATA_TYPE_TO_CML[dataType.trim().toUpperCase()] ?? CML_DATA_TYPES.STRING;
}

/**
 * AttributeDefinition id -> the data type its values must be compared as, resolved from the org by
 * {@link fetchAttributeDataTypes}.
 *
 * Needed because a condition reports `dataType: 'Picklist'`, and a picklist carries no comparable
 * type of its own — a Deductible whose values are 250/500/1000 sits behind a Currency picklist.
 * Left unresolved, its values are emitted quoted while PcmGenerator declares the attribute
 * `decimal`, so the model compares a decimal against a string literal and the rule never fires.
 */
export type AttributeDataTypes = ReadonlyMap<string, string>;

/**
 * The org's AttributeDefinition is authoritative for an attribute's type, so a resolved entry wins
 * over the condition's own `dataType` snapshot. Conditions keyed only by contextTagName carry no
 * attribute id and always fall back to the snapshot.
 */
function conditionDataType(condition: RuleCondition, attributeDataTypes?: AttributeDataTypes): string | undefined {
  const resolved = condition.attributeId ? attributeDataTypes?.get(condition.attributeId) : undefined;
  return resolved ?? condition.dataType;
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

// Operators whose values are emitted unquoted unless cmlDataType === STRING. Equals/NotEquals go
// through doubleQuotedIfNeeded; In/NotIn expand into a chain of `==` comparisons that follows the
// same rule. In/NotIn are also the only multi-value operators here, so the guard below has to clear
// every element of the list, not just the first.
const VALUE_EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['Equals', 'NotEquals', 'In', 'NotIn']);

function isSafeNumericLiteral(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function isSafeBooleanLiteral(value: string): boolean {
  return /^(true|false)$/.test(value.trim());
}

// Bare date literal: YYYY-MM-DD and nothing else. No parens, operators, or whitespace that could
// break out of the unquoted slot — and no time component, because the only slot CML offers is
// `date`, which cannot hold one (see {@link isDateTimeLiteral}).
function isSafeDateLiteral(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

// A bare date carrying an ISO-8601 time component. Well-formed, but unrepresentable: CML's
// primitives are boolean/date/decimal/double/int/string/string[] — there is no datetime and no
// time. PcmGenerator takes the same view from the other side, filtering Datetime attributes out of
// the model entirely rather than declaring them as something else.
function isDateTimeLiteral(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value.trim());
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

/**
 * Whether this operator/dataType pair emits its RHS UNQUOTED. Relational operators always do;
 * Equals/NotEquals do whenever the cmlDataType is not STRING. On the unquoted path every value must
 * be a bare safe literal; otherwise the value would land in the curated model verbatim and could
 * inject CML or produce a type-unsafe comparison. A failing value drops the condition (callers
 * filter nulls), exactly as an unknown operator or missing value does.
 */
function emitsUnquoted(op: string, cmlDataType: string): boolean {
  return (
    ALWAYS_UNQUOTED_OPERATORS.has(op) || (VALUE_EQUALITY_OPERATORS.has(op) && cmlDataType !== CML_DATA_TYPES.STRING)
  );
}

// Operators the shared emitter turns into a CML `strcontain(...)` call — a string function, with no
// numeric, boolean or date counterpart.
const SUBSTRING_OPERATORS: ReadonlySet<string> = new Set(['Contains', 'DoesNotContain']);

/**
 * The reasons, if any, why a rule cannot be converted faithfully — one per offending condition.
 * A rule with any reason must be SKIPPED with those reasons reported, never partially converted.
 *
 * Dropping just the offending condition is not an option: `buildConstraintDeclaration` returns
 * `true` once every condition of a criteria is gone, and nothing downstream withholds a rule whose
 * declaration is `true`, so a rule that lost its conditions arrives matching everything. That is
 * the empty-`dataType` defect, and the guard exists so a new cause cannot re-create it. Dropping
 * one condition of several is no better — it widens what the rule matches.
 *
 * Two of the three causes today are a condition CML has no primitive for.
 *
 * A date-typed condition whose value carries a time: CML has no datetime primitive, so the
 * alternatives were to emit a timestamp into a `date` slot (platform behavior unverified) or to
 * silently truncate it to its date part (changes what the rule matches, with no signal).
 *
 * A substring test (Contains / DoesNotContain) on an attribute that is not a string: `strcontain`
 * is a string function, and against a `decimal`, `boolean` or `date` attribute there is nothing
 * faithful to emit — quoting the value produces the never-fires type mismatch, and unquoting it is
 * not a substring test at all.
 *
 * In both cases declining the rule and saying so beats emitting something that quietly does nothing.
 *
 * The third reason is not about one condition but about the rule as a whole: a rule whose criteria
 * existed and lost EVERY condition — see {@link collapsesToUnconditional}. It is raised here rather
 * than through a second mechanism because this function is the single point all three skip-reason
 * collectors (`buildCmlModel`, `buildPathedSurchargeRules`, `buildUnderwritingConstraintRules`)
 * already consult, so every caller withholds the rule the same way and a future caller cannot get
 * half the behaviour.
 */
export function findUnconvertibleConditions(
  // `apiName` / `name` are read only to name the rule in the whole-rule reason below; every real
  // caller passes a ParsedRuleDefinition, which carries both.
  ruleDef: { ruleCriteria?: RuleCriteria[]; apiName?: string; name?: string },
  attributeDataTypes?: AttributeDataTypes
): string[] {
  const reasons: string[] = [];
  for (const criteria of ruleDef.ruleCriteria ?? []) {
    for (const condition of criteria.conditions ?? []) {
      // An unknown operator or a missing value already drops the condition for reasons this guard
      // does not own; only classify conditions that would otherwise have emitted.
      if (!isKnownOperator(condition.operator)) continue;
      const values = condition.values ?? [];
      if (values.length === 0) continue;
      const cmlDataType = dataTypeToCml(conditionDataType(condition, attributeDataTypes));
      const attrName = condition.attributeName ?? condition.contextTagName ?? 'unknown';

      if (SUBSTRING_OPERATORS.has(condition.operator) && cmlDataType !== CML_DATA_TYPES.STRING) {
        reasons.push(
          `condition on '${attrName}' applies the substring test '${condition.operator}' to an attribute the model ` +
            `declares ${cmlDataType}, which CML cannot represent — strcontain() is a string function, and there is ` +
            'no numeric, boolean or date counterpart. Converting the rule would have to compare the value as text ' +
            'against a non-text attribute, which imports cleanly and never fires, so the rule is left on the rule ' +
            'engine. Re-model the condition as an equality or range comparison, or migrate this rule by hand.'
        );
        continue;
      }

      if (cmlDataType !== CML_DATA_TYPES.DATE || !emitsUnquoted(condition.operator, cmlDataType)) continue;
      const offending = values.find((v) => isDateTimeLiteral(v));
      if (!offending) continue;
      reasons.push(
        `condition on '${attrName}' compares the timestamp '${offending.trim()}', which CML cannot represent — it ` +
          'has no datetime primitive, and a `date` cannot carry a time. Converting the rule would have to drop the ' +
          'time and change what it matches, so the rule is left on the rule engine. Re-model the condition against ' +
          'a date-only attribute, or migrate this rule by hand.'
      );
    }
  }

  // Checked last, and only when nothing above spoke: a condition-specific refusal already says why
  // the rule is withheld, so the whole-rule reason would just repeat it less usefully.
  if (reasons.length === 0 && collapsesToUnconditional(ruleDef, attributeDataTypes)) {
    const ruleName = ruleDef.apiName ?? ruleDef.name ?? 'unknown';
    reasons.push(
      `the conditions of rule '${ruleName}' could not be converted — every one of them was dropped (an ` +
        'unrecognized operator, a missing value, or a value the safe-literal / quotable-string guards ' +
        'refused), leaving nothing to compare. Converting the rule would emit the unconditional ' +
        'declaration `true`, which matches every quote rather than the set the rule selects, so the rule ' +
        'is left on the rule engine. Correct the offending condition values or operators and re-run, or ' +
        'migrate this rule by hand.'
    );
  }

  return reasons;
}

/**
 * Whether every condition of a rule that HAD conditions was dropped, leaving
 * {@link buildConstraintDeclaration} nothing to build from.
 *
 * That function answers `'true'` from two places that mean opposite things. A rule with no criteria
 * genuinely applies always, and curated models contain such lines — that `true` is correct. A rule
 * whose criteria existed but lost every expression is a conversion FAILURE reported as success: the
 * rule is placed as `rule(true, ...)` (or an always-satisfied constraint) and matches every quote.
 * For a surcharge that means charging every customer. Only the second is a reason to withhold, and
 * by the time the declaration exists the two are indistinguishable, so the distinction is drawn
 * here from the criteria themselves.
 *
 * A criteria carrying no conditions dropped nothing either, so a rule made only of those is the
 * genuinely-applies-always case in a different spelling, not a failure — hence the condition count
 * rather than a `ruleCriteria.length` test.
 *
 * Losing SOME conditions is a related but distinct defect and deliberately out of scope: a criteria
 * ANDs its conditions, so dropping one widens what the rule matches without collapsing it. That
 * rule still emits.
 */
function collapsesToUnconditional(
  ruleDef: { ruleCriteria?: RuleCriteria[] },
  attributeDataTypes?: AttributeDataTypes
): boolean {
  const criteria = ruleDef.ruleCriteria ?? [];
  const conditionCount = criteria.reduce((total, c) => total + (c.conditions?.length ?? 0), 0);
  if (conditionCount === 0) return false;
  return criteria.every((c) => buildCriteriaExpression(c, attributeDataTypes) === null);
}

function buildConditionExpression(condition: RuleCondition, attributeDataTypes?: AttributeDataTypes): string | null {
  if (!isKnownOperator(condition.operator)) return null;

  const op = condition.operator;
  if (operatorRequiresValues(op) && (!condition.values || condition.values.length === 0)) {
    return null;
  }

  const values = condition.values ?? [];
  const cmlDataType = dataTypeToCml(conditionDataType(condition, attributeDataTypes));

  if (emitsUnquoted(op, cmlDataType)) {
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

function buildCriteriaExpression(criteria: RuleCriteria, attributeDataTypes?: AttributeDataTypes): string | null {
  const parts: string[] = [];

  if (criteria.conditions) {
    for (const condition of criteria.conditions) {
      const expr = buildConditionExpression(condition, attributeDataTypes);
      if (expr) parts.push(expr);
    }
  }

  return parts.length > 0 ? parts.join(' && ') : null;
}

/**
 * Both `'true'` returns below are deliberate and stay total — the function must answer for any
 * input, because merge mode builds a rule's statement before deciding whether to place it, and
 * throwing here would bypass a caller's skip handling. Only the FIRST is a faithful conversion (a
 * rule with no criteria really does always apply). The second means every expression was dropped,
 * which {@link findUnconvertibleConditions} classifies as unconvertible so the callers that collect
 * skip reasons withhold the rule instead of placing this declaration.
 */
export function buildConstraintDeclaration(
  ruleDef: { ruleCriteria?: RuleCriteria[] },
  attributeDataTypes?: AttributeDataTypes
): string {
  if (!ruleDef.ruleCriteria || ruleDef.ruleCriteria.length === 0) {
    return 'true';
  }

  const expressions = ruleDef.ruleCriteria
    .map((criteria) => buildCriteriaExpression(criteria, attributeDataTypes))
    .filter((e): e is string => e !== null);

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
export function collectEmittedAttributes(
  ruleDefs: Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>,
  attributeDataTypes?: AttributeDataTypes
): Set<string> {
  const attrs = new Set<string>();
  for (const { ruleDef } of ruleDefs) {
    for (const criteria of ruleDef.ruleCriteria ?? []) {
      for (const cond of criteria.conditions ?? []) {
        if (buildConditionExpression(cond, attributeDataTypes) === null) continue;
        const name = cond.attributeName ?? cond.contextTagName;
        if (name) attrs.add(sanitizeName(name));
      }
    }
  }
  return attrs;
}

/**
 * Derives the real CML data type for each collected attribute from its resolved data type (falling
 * back to the condition's own `dataType`). When an attribute appears with more than one distinct CML
 * type (a conflict), or its type is unknown, it falls back to STRING. Returned alongside (not
 * replacing) the Set from collectAttributes, which merge mode still depends on.
 *
 * Shares `conditionDataType` with the declaration builder so an attribute is never declared as one
 * type and then compared as another.
 */
export function collectAttributeTypes(
  ruleDefs: Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>,
  attributeDataTypes?: AttributeDataTypes
): Map<string, string> {
  const types = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const { ruleDef } of ruleDefs) {
    for (const criteria of ruleDef.ruleCriteria ?? []) {
      for (const cond of criteria.conditions ?? []) {
        const name = cond.attributeName ?? cond.contextTagName;
        if (!name) continue;
        const cmlType = dataTypeToCml(conditionDataType(cond, attributeDataTypes));
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

/** A rule withheld from the built model, with the reason to report to the operator. */
export type SkippedRule = { recordId: string; name: string; reason: string };

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
  productIdToName?: Map<string, string>,
  // Org-resolved attribute types, so a picklist attribute is declared and compared as the type
  // behind the picklist (e.g. decimal for a Currency picklist) rather than degrading to string.
  attributeDataTypes?: AttributeDataTypes
): { cmlModel: CmlModel; ruleKeyMapping: RuleKeyEntry[]; skipped: SkippedRule[] } {
  const cmlModel = new CmlModel();
  const skipped: SkippedRule[] = [];

  const rulesByProduct = new Map<string, Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>>();
  for (const entry of ruleDefs) {
    // Withheld here rather than at declaration time so an unconvertible rule contributes neither a
    // constraint nor a ruleKeyMapping entry — the record is then never flipped to the constraint
    // engine, leaving the rule live on the rule engine instead of disabled with nothing behind it.
    const unconvertible = findUnconvertibleConditions(entry.ruleDef, attributeDataTypes);
    if (unconvertible.length > 0) {
      skipped.push({ recordId: entry.record.Id, name: entry.record.Name, reason: unconvertible.join(' ') });
      continue;
    }
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
    const attrTypes = collectAttributeTypes(productRules, attributeDataTypes);
    for (const attrName of attrs) {
      const cmlType = attrTypes.get(attrName) ?? CML_DATA_TYPES.STRING;
      productType.addAttribute(new CmlAttribute(null, sanitizeName(attrName), cmlType));
    }

    for (const { record, ruleDef } of productRules) {
      const apiName = ruleDef.apiName ?? record.Name;
      const stageTransition = buildStageTransition(ruleDef.underwritingRuleGroup);
      const ruleKey = generateRuleKey(keyPrefix, productCode, apiName, stageTransition);

      const declaration = buildConstraintDeclaration(ruleDef, attributeDataTypes);
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

  return { cmlModel, ruleKeyMapping, skipped };
}
