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
import {
  BASE_LINE_ITEM_TYPE_NAME,
  CmlAttribute,
  CmlConstraint,
  CmlModel,
  CmlType,
  Association,
} from './types/types.js';
import { CML_DATA_TYPES, CONSTRAINT_TYPES, ASSOCIATION_TYPES } from './constants/constants.js';

// Shared types for insurance dynamic rule criteria (same for surcharge + underwriting)
export type RuleCondition = {
  contextTagName?: string;
  operator: string;
  conditionIndex?: number;
  attributeName?: string;
  attributePicklistValueId?: string;
  attributeId?: string;
  dataType?: string;
  type?: string;
  values?: string[];
};

export type RuleCriteria = {
  rootObjectId: string;
  criteriaIndex?: number;
  sourceContextTagName?: string;
  sourceOperator?: string;
  sourceDataType?: string;
  sourceValues?: string[];
  conditions?: RuleCondition[];
};

export type ParsedRuleDefinition = {
  name: string;
  apiName: string;
  productPath: string;
  status?: string;
  description?: string;
  ruleCriteria?: RuleCriteria[];
};

export type RuleRecord = {
  Id: string;
  Name: string;
  ProductPath: string;
};

export type RuleKeyEntry = {
  recordId: string;
  name: string;
  ruleKey: string;
};

function operatorToCml(op: string): string {
  const operators: Record<string, string> = {
    Equals: '==',
    NotEquals: '!=',
    LessThan: '<',
    LessThanOrEquals: '<=',
    GreaterThan: '>',
    GreaterThanOrEquals: '>=',
    Contains: '.contains',
    In: '==',
  };
  return operators[op] ?? '==';
}

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

export function generateRuleKey(prefix: string, productCode: string, apiName: string): string {
  return `${prefix}__${sanitizeName(productCode)}__${sanitizeName(apiName)}`;
}

function buildConditionExpression(condition: RuleCondition): string | null {
  if (!condition.values || condition.values.length === 0) return null;

  const attrName = sanitizeName(condition.attributeName ?? condition.contextTagName ?? 'unknown');
  const op = operatorToCml(condition.operator);
  const value = condition.values[0];
  const cmlDataType = dataTypeToCml(condition.dataType);
  const isNumeric = cmlDataType === CML_DATA_TYPES.INTEGER || cmlDataType === CML_DATA_TYPES.DECIMAL;
  const quotedValue = isNumeric ? value : `"${value}"`;

  return `${attrName} ${op} ${quotedValue}`;
}

function buildCriteriaExpression(criteria: RuleCriteria): string | null {
  const parts: string[] = [];

  if (criteria.sourceContextTagName === 'Product' && criteria.sourceValues && criteria.sourceValues.length > 0) {
    const productIds = criteria.sourceValues.map((v) => `"${v}"`).join(', ');
    parts.push(criteria.sourceValues.length === 1 ? `product.id == ${productIds}` : `product.id in [${productIds}]`);
  }

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

export async function fetchProductCodes(conn: Connection, productIds: Set<string>): Promise<Map<string, string>> {
  const idToCode = new Map<string, string>();
  if (productIds.size === 0) return idToCode;

  const idList = Array.from(productIds)
    .map((id) => `'${id}'`)
    .join(',');
  const result = await conn.query<{ Id: string; ProductCode: string }>(
    `SELECT Id, ProductCode FROM Product2 WHERE Id IN (${idList})`
  );
  for (const p of result.records) {
    idToCode.set(p.Id, p.ProductCode ?? p.Id);
  }
  return idToCode;
}

export function buildCmlModel(
  ruleDefs: Array<{ record: RuleRecord; ruleDef: ParsedRuleDefinition }>,
  productIdToCode: Map<string, string>,
  keyPrefix: string,
  constraintLabel: string
): { cmlModel: CmlModel; ruleKeyMapping: RuleKeyEntry[] } {
  const cmlModel = new CmlModel();
  const lineItemType = new CmlType(BASE_LINE_ITEM_TYPE_NAME, undefined, undefined);

  const commonAttrs = collectAttributes(ruleDefs);
  lineItemType.addAttribute(new CmlAttribute(null, 'product_id', CML_DATA_TYPES.STRING));
  for (const attrName of commonAttrs) {
    lineItemType.addAttribute(new CmlAttribute(null, sanitizeName(attrName), CML_DATA_TYPES.STRING));
  }
  cmlModel.addType(lineItemType);

  const ruleKeyMapping: RuleKeyEntry[] = [];
  for (const { record, ruleDef } of ruleDefs) {
    const rootProductId = record.ProductPath.split('/')[0];
    const productCode = productIdToCode.get(rootProductId) ?? rootProductId;
    const apiName = ruleDef.apiName ?? record.Name;
    const ruleKey = generateRuleKey(keyPrefix, productCode, apiName);

    const constraint = new CmlConstraint(
      CONSTRAINT_TYPES.CONSTRAINT,
      buildConstraintDeclaration(ruleDef),
      `"${constraintLabel}: ${record.Name}"`
    );
    constraint.name = sanitizeName(apiName);
    lineItemType.addConstraint(constraint);

    cmlModel.addAssociation(
      new Association(null, BASE_LINE_ITEM_TYPE_NAME, ASSOCIATION_TYPES.TYPE, rootProductId, 'Product2', productCode)
    );

    ruleKeyMapping.push({ recordId: record.Id, name: record.Name, ruleKey });
  }

  return { cmlModel, ruleKeyMapping };
}
