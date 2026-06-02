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
import { expect } from 'chai';
import {
  convertToCmlExpression,
  escapeQuotes,
  isKnownOperator,
  operatorRequiresValues,
} from '../../src/shared/cml-operators.js';
import { RuleConditionOperator } from '../../src/shared/models.js';

describe('escapeQuotes', () => {
  it('escapes single quotes', () => {
    expect(escapeQuotes("O'Brien")).to.equal("O\\'Brien");
  });

  it('escapes double quotes', () => {
    expect(escapeQuotes('He said "hi"')).to.equal('He said \\"hi\\"');
  });

  it('leaves quote-free strings unchanged', () => {
    expect(escapeQuotes('plain')).to.equal('plain');
  });
});

describe('convertToCmlExpression', () => {
  it('maps comparison operators (including the LessThan < / LessThanOrEquals <= distinction)', () => {
    const cases: Array<{ operator: RuleConditionOperator; expected: string }> = [
      { operator: 'Equals', expected: 'X == 5' },
      { operator: 'NotEquals', expected: 'X != 5' },
      { operator: 'LessThan', expected: 'X < 5' },
      { operator: 'LessThanOrEquals', expected: 'X <= 5' },
      { operator: 'GreaterThan', expected: 'X > 5' },
      { operator: 'GreaterThanOrEquals', expected: 'X >= 5' },
    ];
    for (const { operator, expected } of cases) {
      expect(convertToCmlExpression('X', operator, ['5'], 'integer')).to.equal(expected);
    }
  });

  it('keeps LessThan as < and LessThanOrEquals as <= (regression guard for the prior <= typo)', () => {
    expect(convertToCmlExpression('Age', 'LessThan', ['60'], 'integer')).to.equal('Age < 60');
    expect(convertToCmlExpression('Age', 'LessThanOrEquals', ['60'], 'integer')).to.equal('Age <= 60');
  });

  it('quotes string values for Equals/NotEquals', () => {
    expect(convertToCmlExpression('Model', 'Equals', ['SUV'], 'string')).to.equal('Model == "SUV"');
    expect(convertToCmlExpression('Model', 'NotEquals', ['SUV'], 'string')).to.equal('Model != "SUV"');
  });

  it('Contains emits strcontain(...)', () => {
    expect(convertToCmlExpression('Description', 'Contains', ['SUV'], 'string')).to.equal(
      'strcontain(Description, "SUV")'
    );
  });

  it('DoesNotContain negates strcontain(...)', () => {
    expect(convertToCmlExpression('Description', 'DoesNotContain', ['SUV'], 'string')).to.equal(
      '!strcontain(Description, "SUV")'
    );
  });

  it('In expands every value into a parenthesized || chain', () => {
    expect(convertToCmlExpression('Model', 'In', ['SUV', 'Sedan', 'Truck'], 'string')).to.equal(
      '(Model == "SUV" || Model == "Sedan" || Model == "Truck")'
    );
  });

  it('In with a single value still wraps in parentheses', () => {
    expect(convertToCmlExpression('Model', 'In', ['SUV'], 'string')).to.equal('(Model == "SUV")');
  });

  it('NotIn negates the parenthesized || chain', () => {
    expect(convertToCmlExpression('Model', 'NotIn', ['SUV', 'Sedan'], 'string')).to.equal(
      '!(Model == "SUV" || Model == "Sedan")'
    );
  });

  it('IsNull and IsNotNull need no values', () => {
    expect(convertToCmlExpression('Model', 'IsNull')).to.equal('Model == null');
    expect(convertToCmlExpression('Model', 'IsNotNull')).to.equal('Model != null');
  });

  it('escapes single quotes inside string values', () => {
    expect(convertToCmlExpression('Name', 'Equals', ["O'Brien"], 'string')).to.equal('Name == "O\\\'Brien"');
  });

  it('escapes double quotes inside string values', () => {
    expect(convertToCmlExpression('Greeting', 'Equals', ['He said "hi"'], 'string')).to.equal(
      'Greeting == "He said \\"hi\\""'
    );
  });

  it('throws on an unsupported operator', () => {
    expect(() => convertToCmlExpression('X', 'Foobar' as RuleConditionOperator, ['1'], 'string')).to.throw(
      'Unsupported rule operator: Foobar'
    );
  });
});

describe('isKnownOperator', () => {
  it('returns true for every supported operator', () => {
    const known = [
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
    ];
    for (const op of known) {
      expect(isKnownOperator(op), op).to.equal(true);
    }
  });

  it('returns false for an unknown operator (guards the skip path)', () => {
    expect(isKnownOperator('Foobar')).to.equal(false);
    expect(isKnownOperator('')).to.equal(false);
  });
});

describe('operatorRequiresValues', () => {
  it('returns false for null operators', () => {
    expect(operatorRequiresValues('IsNull')).to.equal(false);
    expect(operatorRequiresValues('IsNotNull')).to.equal(false);
  });

  it('returns true for value-bearing operators', () => {
    expect(operatorRequiresValues('Equals')).to.equal(true);
    expect(operatorRequiresValues('In')).to.equal(true);
    expect(operatorRequiresValues('Contains')).to.equal(true);
  });
});
