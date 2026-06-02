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

function buildConditionExpression(condition: RuleCondition): string | null {
  if (!isKnownOperator(condition.operator)) return null;

  const op = condition.operator;
  if (operatorRequiresValues(op) && (!condition.values || condition.values.length === 0)) {
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
  constraintLabel: string
): { cmlModel: CmlModel; ruleKeyMapping: RuleKeyEntry[] } {
  const cmlModel = new CmlModel();

  const rulesByProduct = new Map<string, Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>>();
  for (const entry of ruleDefs) {
    const rootProductId = entry.record.ProductPath.split('/')[0];
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

      const constraint = new CmlConstraint(
        CONSTRAINT_TYPES.CONSTRAINT,
        buildConstraintDeclaration(ruleDef),
        `"${constraintLabel}: ${record.Name}"`
      );
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
