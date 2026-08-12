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
import { RuleConditionOperator } from './models.js';

export function escapeQuotes(str: string): string {
  return str.replace(/['"]/g, '\\$&');
}

export function doubleQuoted(str: string | undefined): string {
  if (str) {
    return `"${escapeQuotes(str)}"`;
  }
  return str ?? "''";
}

export function doubleQuotedIfNeeded(value: string | string[] | undefined, dataType: string | undefined): string {
  if (typeof value === 'string' || typeof value === 'undefined') {
    return `${dataType === 'string' ? doubleQuoted(value) ?? '' : value ?? "''"}`;
  }
  const singleValue = value[0];
  return `${dataType === 'string' ? doubleQuoted(singleValue) ?? '' : singleValue ?? "''"}`;
}

/**
 * Whether values of this resolved CML type are emitted quoted. An absent type means the caller
 * resolved none, and quoting is the conservative direction — an unquoted value reaches the curated
 * model verbatim. (`doubleQuotedIfNeeded` predates this and reads an absent type as non-string;
 * `In`/`NotIn` are new to type-awareness, so an omitted type keeps their long-standing quoting.)
 */
function quotesValues(dataType: string | undefined): boolean {
  return dataType === undefined || dataType === 'string';
}

/**
 * Expands an In list into a chain of `==` comparisons. Because those are equality comparisons, the
 * values follow the same quoting rule Equals follows: quoted only for `string`. Quoting a value
 * against an attribute the model declares `decimal` compares a number with a string literal, and
 * the comparison never fires.
 *
 * `dataType` is optional and last so existing callers that pass none keep emitting quoted values.
 */
export function generateInCmlExpression(left: string, right: string | string[], dataType?: string): string {
  const emit = (value: string): string => (quotesValues(dataType) ? doubleQuoted(value) : value);
  if (typeof right === 'string') {
    return `${left} == ${emit(right)}`;
  }
  return right.map((r) => `${left} == ${emit(r)}`).join(' || ');
}

function firstValue(right: string | string[] | undefined): string | undefined {
  if (right === undefined) return undefined;
  return typeof right === 'string' ? right : right[0];
}

export function convertToCmlExpression(
  left: string,
  ruleExprOperator: RuleConditionOperator,
  right?: string | string[],
  dataType?: string
): string {
  switch (ruleExprOperator) {
    case 'Equals':
      return `${left} == ${doubleQuotedIfNeeded(right, dataType)}`;
    case 'NotEquals':
      return `${left} != ${doubleQuotedIfNeeded(right, dataType)}`;
    case 'LessThan':
      return `${left} < ${(right as string | undefined) ?? ''}`;
    case 'LessThanOrEquals':
      return `${left} <= ${(right as string | undefined) ?? ''}`;
    case 'GreaterThan':
      return `${left} > ${(right as string | undefined) ?? ''}`;
    case 'GreaterThanOrEquals':
      return `${left} >= ${(right as string | undefined) ?? ''}`;
    case 'IsNotNull':
      return `${left} != null`;
    case 'IsNull':
      return `${left} == null`;
    case 'Contains':
      return `strcontain(${left}, ${doubleQuoted(firstValue(right))})`;
    case 'DoesNotContain':
      return `!strcontain(${left}, ${doubleQuoted(firstValue(right))})`;
    case 'In':
      if (right) {
        return `(${generateInCmlExpression(left, right, dataType)})`;
      }
      return `${left} == null`;
    case 'NotIn':
      if (right) {
        return `!(${generateInCmlExpression(left, right, dataType)})`;
      }
      return `${left} != null`;
    default: {
      const exhaustive: never = ruleExprOperator;
      throw new Error(`Unsupported rule operator: ${String(exhaustive)}`);
    }
  }
}

const KNOWN_OPERATORS: ReadonlySet<string> = new Set<RuleConditionOperator>([
  'Equals',
  'NotEquals',
  'LessThan',
  'LessThanOrEquals',
  'GreaterThan',
  'GreaterThanOrEquals',
  'IsNotNull',
  'IsNull',
  'Contains',
  'DoesNotContain',
  'In',
  'NotIn',
]);

export function isKnownOperator(op: string): op is RuleConditionOperator {
  return KNOWN_OPERATORS.has(op);
}

const NULL_OPERATORS: ReadonlySet<RuleConditionOperator> = new Set(['IsNull', 'IsNotNull']);

export function operatorRequiresValues(op: RuleConditionOperator): boolean {
  return !NULL_OPERATORS.has(op);
}
