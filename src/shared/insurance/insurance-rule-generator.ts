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

// Operators whose RHS the shared emitter interpolates UNQUOTED (e.g. `attr > 2020`). Insurance
// data for these is always numeric, so we require a safe numeric literal here — a malformed or
// hostile value (e.g. `2020) || evil(`) can otherwise reach the curated model verbatim.
const UNQUOTED_RELATIONAL_OPERATORS: ReadonlySet<string> = new Set([
  'LessThan',
  'LessThanOrEquals',
  'GreaterThan',
  'GreaterThanOrEquals',
]);

function isSafeNumericLiteral(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

function buildConditionExpression(condition: RuleCondition): string | null {
  if (!isKnownOperator(condition.operator)) return null;

  const op = condition.operator;
  if (operatorRequiresValues(op) && (!condition.values || condition.values.length === 0)) {
    return null;
  }

  // Relational operators emit their RHS unquoted; only safe numeric literals are allowed through
  // so the value cannot inject CML or produce a type-unsafe comparison. A failing value drops the
  // condition (the caller filters nulls), exactly as an unknown operator or a missing value does.
  if (UNQUOTED_RELATIONAL_OPERATORS.has(op) && !(condition.values ?? []).every(isSafeNumericLiteral)) {
    return null;
  }

  const attrName = sanitizeName(condition.attributeName ?? condition.contextTagName ?? 'unknown');
  const cmlDataType = dataTypeToCml(condition.dataType);
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

export function buildCmlModel(
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  keyPrefix: string,
  constraintLabel: string,
  // When set, eligibility is emitted as a CML `rule(decl, "<ruleType>", "<ruleKey>", "True")`
  // statement instead of a `constraint NAME = (decl, "label");`. Surcharge passes
  // 'InsuranceSurchargeRule'; underwriting leaves it undefined to keep the constraint form.
  ruleType?: string
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
    for (const attrName of attrs) {
      productType.addAttribute(new CmlAttribute(null, sanitizeName(attrName), CML_DATA_TYPES.STRING));
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
    cmlModel.addAssociation(
      new Association(null, typeName, ASSOCIATION_TYPES.TYPE, rootProductId, 'Product2', productCode)
    );
  }

  return { cmlModel, ruleKeyMapping };
}
