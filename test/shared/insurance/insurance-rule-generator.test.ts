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
import { Connection } from '@salesforce/core';
import {
  buildCmlModel,
  buildConstraintDeclaration,
  buildStageTransition,
  collectAttributes,
  collectAttributeTypes,
  decodeHtmlEntities,
  findUnconvertibleConditions,
  generateRuleKey,
  isSafeAssociationReferenceValue,
  sanitizeName,
} from '../../../src/shared/insurance/insurance-rule-generator.js';
import { PcmGenerator } from '../../../src/shared/pcm-generator.js';
import { CML_DATA_TYPES } from '../../../src/shared/constants/constants.js';
import { ParsedRuleDefinition, RuleCondition, RuleCriteria, RuleRecord } from '../../../src/shared/insurance/models.js';
import {
  discoverCmlApiByProducts,
  fetchAttributeDataTypes,
  fetchProductCodes,
  quoteSoqlIdList,
} from '../../../src/shared/insurance/insurance-org.js';

function mockConnection(queryResults: Record<string, { records: unknown[] }>): Connection {
  return {
    query: (soql: string) => {
      for (const [key, value] of Object.entries(queryResults)) {
        if (soql.includes(key)) return Promise.resolve(value);
      }
      return Promise.resolve({ records: [] });
    },
  } as unknown as Connection;
}

describe('sanitizeName', () => {
  it('replaces non-alphanumeric characters with underscores', () => {
    expect(sanitizeName('Draft to InReview')).to.equal('Draft_to_InReview');
  });

  it('leaves alphanumeric and underscores unchanged', () => {
    expect(sanitizeName('AutoSilverRoot')).to.equal('AutoSilverRoot');
  });

  it('handles special characters', () => {
    expect(sanitizeName('foo-bar.baz')).to.equal('foo_bar_baz');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &quot; into double quotes so JSON parses', () => {
    const raw = '{&quot;name&quot;:&quot;Auto_Auto&quot;,&quot;ruleCriteria&quot;:null}';
    const decoded = decodeHtmlEntities(raw);
    expect(decoded).to.equal('{"name":"Auto_Auto","ruleCriteria":null}');
    expect((JSON.parse(decoded) as { name: string }).name).to.equal('Auto_Auto');
  });

  it('decodes &lt; &gt; &#39; and &apos;', () => {
    expect(decodeHtmlEntities('a &lt; b &gt; c &#39;d&#39; &apos;e&apos;')).to.equal("a < b > c 'd' 'e'");
  });

  it('decodes &amp; last so it does not double-decode', () => {
    expect(decodeHtmlEntities('&amp;quot;')).to.equal('&quot;');
  });

  it('leaves already-decoded JSON unchanged', () => {
    const raw = '{"name":"Plain","ruleCriteria":[]}';
    expect(decodeHtmlEntities(raw)).to.equal(raw);
  });
});

describe('buildStageTransition', () => {
  it('returns undefined when ruleGroup is undefined', () => {
    expect(buildStageTransition(undefined)).to.be.undefined;
  });

  it('returns undefined when fromStage is missing', () => {
    expect(buildStageTransition({ toStage: 'Approved' })).to.be.undefined;
  });

  it('returns undefined when toStage is missing', () => {
    expect(buildStageTransition({ fromStage: 'Draft' })).to.be.undefined;
  });

  it('builds transition from simple stages', () => {
    expect(buildStageTransition({ fromStage: 'Draft', toStage: 'Approved' })).to.equal('DraftToApproved');
  });

  it('strips spaces from stage names', () => {
    expect(buildStageTransition({ fromStage: 'In Review', toStage: 'Approved' })).to.equal('InReviewToApproved');
  });

  it('handles Draft To In Review', () => {
    expect(buildStageTransition({ fromStage: 'Draft', toStage: 'In Review' })).to.equal('DraftToInReview');
  });
});

describe('generateRuleKey', () => {
  it('generates 3-segment key without stage transition (surcharge)', () => {
    expect(generateRuleKey('SC', 'autoSilver', 'MyRule')).to.equal('SC__autoSilver__MyRule');
  });

  it('generates 4-segment key with stage transition (underwriting)', () => {
    expect(generateRuleKey('UW', 'autoSilver', 'AutoSilverRoot', 'DraftToApproved')).to.equal(
      'UW__autoSilver__DraftToApproved__AutoSilverRoot'
    );
  });

  it('sanitizes product code and apiName', () => {
    expect(generateRuleKey('UW', 'auto Silver', 'My Rule')).to.equal('UW__auto_Silver__My_Rule');
  });
});

describe('buildConstraintDeclaration', () => {
  it('returns true when no ruleCriteria', () => {
    expect(buildConstraintDeclaration({})).to.equal('true');
  });

  it('returns true when ruleCriteria is empty', () => {
    expect(buildConstraintDeclaration({ ruleCriteria: [] })).to.equal('true');
  });

  it('builds single condition expression', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Model',
              operator: 'Equals',
              dataType: 'String',
              values: ['SUV'],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SUV"');
  });

  it('builds numeric condition without quotes', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Year',
              operator: 'GreaterThan',
              dataType: 'Number',
              values: ['2020'],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Year > 2020');
  });

  it('joins multiple conditions with &&', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] },
            { attributeName: 'Year', operator: 'GreaterThan', dataType: 'Number', values: ['2020'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SUV" && Year > 2020');
  });

  it('joins multiple criteria with ||', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'A', operator: 'Equals', dataType: 'String', values: ['x'] }],
        },
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'B', operator: 'Equals', dataType: 'String', values: ['y'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('(A == "x") || (B == "y")');
  });

  it('ignores product source conditions (removed per meeting decision)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          sourceContextTagName: 'Product',
          sourceValues: ['01tABC'],
          conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Number', values: ['60'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Age < 60');
  });

  // Operator-level semantics (mapping, strcontain, In/NotIn chains, null operators, quote
  // escaping, unknown-operator handling) are locked in test/shared/cml-operators.test.ts so
  // the shared module keeps its own coverage independent of this generator.

  it('skips conditions with unknown operators', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'X', operator: 'Foobar', dataType: 'String', values: ['1'] },
            { attributeName: 'Y', operator: 'Equals', dataType: 'String', values: ['1'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Y == "1"');
  });

  // Relational operators (<, <=, >, >=) interpolate their RHS UNQUOTED into the curated model.
  // The insurance layer validates that value is a safe numeric literal so a hostile or malformed
  // DynamicRuleDefinition value can neither inject CML nor emit a type-unsafe comparison.
  it('drops a relational condition whose value is not a safe numeric literal (CML-injection guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Year', operator: 'GreaterThan', dataType: 'Number', values: ['2020) || hijack('] },
            { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] },
          ],
        },
      ] as RuleCriteria[],
    };
    // The hostile relational value is dropped; the safe Equals condition survives.
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SUV"');
  });

  it('drops a relational condition with a non-numeric value', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Number', values: ['old'] }],
        },
      ] as RuleCriteria[],
    };
    // No safe conditions remain, so the declaration collapses to the permissive default.
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('allows signed and decimal numeric literals through relational operators', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Temp', operator: 'GreaterThanOrEquals', dataType: 'Number', values: ['-12.5'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Temp >= -12.5');
  });

  it('still quotes and escapes Equals values (relational guard does not touch quoted operators)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SU"V'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SU\\"V"');
  });

  // C1 — Equals/NotEquals also emit their RHS UNQUOTED whenever the cmlDataType is non-string
  // (Number/Currency/Percent/Boolean/Date). The relational-only guard left this open: a hostile
  // value reaches the curated model verbatim. The guard must key off the unquoted emission path,
  // not an operator allowlist.
  it('drops a numeric-typed Equals condition whose value is not a safe numeric literal (C1 injection)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Year', operator: 'Equals', dataType: 'Number', values: ['2020) || evil('] },
            { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] },
          ],
        },
      ] as RuleCriteria[],
    };
    // The hostile unquoted Equals is dropped; the safe (string-quoted) Equals survives.
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SUV"');
  });

  it('drops a Currency-typed NotEquals condition that forges a rule statement (C1 injection)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Premium',
              operator: 'NotEquals',
              dataType: 'Currency',
              values: ['0) , "InsuranceSurchargeRule", "x", "True"); evil('],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('preserves a clean numeric Equals unquoted (C1 regression guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Year', operator: 'Equals', dataType: 'Number', values: ['2020'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Year == 2020');
  });

  it('drops a Boolean-typed Equals whose value is not a bare true/false literal (C1 injection)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'IsActive', operator: 'Equals', dataType: 'Boolean', values: ['true) || x('] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('preserves a clean Boolean Equals unquoted (C1 regression guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'IsActive', operator: 'Equals', dataType: 'Boolean', values: ['true'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('IsActive == true');
  });

  // In/NotIn emit their values unquoted on a non-string type, exactly as Equals does, so the
  // safe-literal guard has to cover them too — otherwise a hostile value reaches the curated model
  // verbatim through the one operator that was left out of the unquoted classification.
  it('drops a numeric-typed In condition whose value is not a safe numeric literal (injection guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Year', operator: 'In', dataType: 'Number', values: ['2020) || evil('] },
            { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == "SUV"');
  });

  // In is the only multi-value operator on this path, so the guard must clear EVERY element — a
  // per-list check that stopped at the first value would let the second one through unquoted.
  it('drops an In condition when any later value in the list is hostile (injection guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Deductible',
              operator: 'In',
              dataType: 'Currency',
              values: ['500', '1000) , "InsuranceSurchargeRule", "x", "True"); evil('],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    const declaration = buildConstraintDeclaration(ruleDef);
    expect(declaration).to.equal('true');
    expect(declaration).to.not.include('evil');
  });

  it('drops a NotIn condition whose value is not a safe literal (injection guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'IsActive', operator: 'NotIn', dataType: 'Boolean', values: ['true) || x('] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  // A string-typed In stays on the quoted path, where the escaper — not the literal guard — is what
  // has to hold, so the backslash rejection must still apply to every element of the list.
  it('drops a string In condition when any value contains a backslash (H3 quote break-out)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'In', dataType: 'String', values: ['SUV', 'evil\\'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('drops a Date-typed Equals whose value is not a bare date literal (C1 injection)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'EffDate', operator: 'Equals', dataType: 'Date', values: ['2020-01-01) || x('] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  // H3 — escapeQuotes (out of scope) does not escape backslash, so a string value ending in a
  // backslash escapes its own closing quote and the following content lands as raw CML. The
  // insurance layer must reject any string-quoted value containing a backslash.
  it('drops a string Equals value ending in a backslash (H3 quote break-out)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['evil\\'] },
            { attributeName: 'Trim', operator: 'Equals', dataType: 'String', values: [') || hijack(('] },
          ],
        },
      ] as RuleCriteria[],
    };
    // The backslash-terminated value is dropped; the (now harmless) second value is still quoted.
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Trim == ") || hijack(("');
  });

  it('drops a string Contains value containing a backslash-quote sequence (H3 quote break-out)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Notes', operator: 'Contains', dataType: 'String', values: ['a\\"; bad'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('preserves a clean string Contains value (H3 regression guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Notes', operator: 'Contains', dataType: 'String', values: ['premium'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('strcontain(Notes, "premium")');
  });
});

describe('collectAttributes', () => {
  it('returns empty set when no criteria', () => {
    const result = collectAttributes([{ ruleDef: {} }]);
    expect(result.size).to.equal(0);
  });

  it('collects unique attribute names across rules', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            { rootObjectId: '01t', conditions: [{ attributeName: 'Model', operator: 'Equals', values: ['x'] }] },
          ],
        },
      },
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [
                { attributeName: 'Model', operator: 'Equals', values: ['y'] },
                { attributeName: 'Year', operator: 'Equals', values: ['z'] },
              ],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    const result = collectAttributes(ruleDefs);
    expect(result).to.deep.equal(new Set(['Model', 'Year']));
  });

  it('uses contextTagName when attributeName is missing', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            { rootObjectId: '01t', conditions: [{ contextTagName: 'TagA', operator: 'Equals', values: ['x'] }] },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    const result = collectAttributes(ruleDefs);
    expect(result).to.deep.equal(new Set(['TagA']));
  });
});

describe('buildCmlModel', () => {
  const makeRecord = (id: string, name: string, productPath: string): RuleRecord => ({
    Id: id,
    Name: name,
    ProductPath: productPath,
  });

  const makeRuleDef = (
    name: string,
    apiName: string,
    productPath: string,
    criteria?: RuleCriteria[],
    underwritingRuleGroup?: ParsedRuleDefinition['underwritingRuleGroup']
  ): ParsedRuleDefinition => ({
    name,
    apiName,
    productPath,
    ruleCriteria: criteria,
    underwritingRuleGroup,
  });

  it('creates one type per root product', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', 'p1/child1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1/child1') },
      { record: makeRecord('r2', 'Rule2', 'p1/child2'), ruleDef: makeRuleDef('Rule2', 'Rule2', 'p1/child2') },
      { record: makeRecord('r3', 'Rule3', 'p2'), ruleDef: makeRuleDef('Rule3', 'Rule3', 'p2') },
    ];
    const productMap = new Map([
      ['p1', 'ProductA'],
      ['p2', 'ProductB'],
    ]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');

    const types = cmlModel.types;
    expect(types).to.have.length(2);
    expect(types.map((t) => t.name).sort()).to.deep.equal(['ProductA', 'ProductB']);
  });

  it('puts constraints under their product type', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', 'p1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1') },
      { record: makeRecord('r2', 'Rule2', 'p2'), ruleDef: makeRuleDef('Rule2', 'Rule2', 'p2') },
    ];
    const productMap = new Map([
      ['p1', 'Alpha'],
      ['p2', 'Beta'],
    ]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'UW', 'Test');

    const alphaType = cmlModel.getType('Alpha');
    const betaType = cmlModel.getType('Beta');
    expect(alphaType?.constraints).to.have.length(1);
    expect(betaType?.constraints).to.have.length(1);
    expect(alphaType?.constraints[0].name).to.equal('Rule1');
    expect(betaType?.constraints[0].name).to.equal('Rule2');
  });

  it('creates one association per product (not per rule)', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', 'p1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1') },
      { record: makeRecord('r2', 'Rule2', 'p1'), ruleDef: makeRuleDef('Rule2', 'Rule2', 'p1') },
    ];
    const productMap = new Map([['p1', 'ProdX']]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');

    expect(cmlModel.associations).to.have.length(1);
    expect(cmlModel.associations[0].tag).to.equal('ProdX');
    expect(cmlModel.associations[0].referenceObjectId).to.equal('p1');
  });

  // The common `cml import as-expression-set` resolves a Type association's Product2 by NAME
  // (`SELECT Id, Name FROM Product2 WHERE Name IN (<$Product2ReferenceId>)`), then keys the lookup
  // off that same value. convert must therefore emit the product Name — not its ProductCode — into
  // the association reference value, or the importer finds no match and silently drops the
  // association (the Type block imports with zero Product2 bindings and never evaluates).
  it('emits the product Name (not the ProductCode) as the association reference value when a name map is provided', () => {
    const ruleDefs = [{ record: makeRecord('r1', 'Rule1', 'p1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1') }];
    const { cmlModel } = buildCmlModel(
      ruleDefs,
      new Map([['p1', 'autoSilver']]),
      'SC',
      'Test',
      undefined,
      new Map([['p1', 'Auto Silver']])
    );

    expect(cmlModel.associations).to.have.length(1);
    // The tag / CML type name stay ProductCode-derived (the CML doc keys off them)...
    expect(cmlModel.associations[0].tag).to.equal('autoSilver');
    // ...but $Product2ReferenceId — what the importer resolves by — must be the product Name.
    expect(cmlModel.associations[0].referenceObjectReferenceValue).to.equal('Auto Silver');
  });

  it('falls back to the ProductCode reference value when the name map has no entry for the product', () => {
    const ruleDefs = [{ record: makeRecord('r1', 'Rule1', 'p1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1') }];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'SC', 'Test', undefined, new Map());

    expect(cmlModel.associations[0].referenceObjectReferenceValue).to.equal('autoSilver');
  });

  it('preserves the legacy ProductCode reference value when no name map is passed (backward compatible)', () => {
    const ruleDefs = [{ record: makeRecord('r1', 'Rule1', 'p1'), ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1') }];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'SC', 'Test');

    expect(cmlModel.associations[0].referenceObjectReferenceValue).to.equal('autoSilver');
  });

  it('generates surcharge ruleKey with 3 segments', () => {
    const ruleDefs = [{ record: makeRecord('r1', 'MyRule', 'p1'), ruleDef: makeRuleDef('MyRule', 'MyRule', 'p1') }];
    const productMap = new Map([['p1', 'autoSilver']]);
    const { ruleKeyMapping } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');

    expect(ruleKeyMapping).to.have.length(1);
    expect(ruleKeyMapping[0].ruleKey).to.equal('SC__autoSilver__MyRule');
  });

  it('generates underwriting ruleKey with 4 segments including stage transition', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'UWRule1', 'p1'),
        ruleDef: makeRuleDef('UWRule1', 'UWRule1', 'p1', undefined, {
          fromStage: 'Draft',
          toStage: 'Approved',
        }),
      },
    ];
    const productMap = new Map([['p1', 'autoSilver']]);
    const { ruleKeyMapping } = buildCmlModel(ruleDefs, productMap, 'UW', 'Test');

    expect(ruleKeyMapping).to.have.length(1);
    expect(ruleKeyMapping[0].ruleKey).to.equal('UW__autoSilver__DraftToApproved__UWRule1');
  });

  it('avoids constraint-name collisions when two rules share apiName under the same product', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'A', 'p1'),
        ruleDef: makeRuleDef('A', 'SharedApi', 'p1', undefined, { fromStage: 'Draft', toStage: 'InReview' }),
      },
      {
        record: makeRecord('r2', 'B', 'p1'),
        ruleDef: makeRuleDef('B', 'SharedApi', 'p1', undefined, { fromStage: 'InReview', toStage: 'Approved' }),
      },
    ];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'UW', 'Test');
    const names = cmlModel.getType('autoSilver')!.constraints.map((c) => c.name);
    expect(names).to.deep.equal(['SharedApi_DraftToInReview', 'SharedApi_InReviewToApproved']);
    expect(new Set(names).size).to.equal(2);
  });

  it('scopes attributes per product type', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'Rule1', 'p1'),
        ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] }],
          },
        ]),
      },
      {
        record: makeRecord('r2', 'Rule2', 'p2'),
        ruleDef: makeRuleDef('Rule2', 'Rule2', 'p2', [
          {
            rootObjectId: 'p2',
            conditions: [
              { attributeName: 'Deductible', operator: 'GreaterThan', dataType: 'Number', values: ['1000'] },
            ],
          },
        ]),
      },
    ];
    const productMap = new Map([
      ['p1', 'Auto'],
      ['p2', 'Health'],
    ]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'UW', 'Test');

    const autoType = cmlModel.getType('Auto');
    const healthType = cmlModel.getType('Health');
    expect(autoType?.attributes.map((a) => a.name)).to.deep.equal(['Model']);
    expect(healthType?.attributes.map((a) => a.name)).to.deep.equal(['Deductible']);
  });

  // H4 — attributes must be declared with their real CML type so that relational comparisons
  // (which emit a bare numeric RHS, e.g. `Age < 60`) type-check on import. Declaring everything
  // as `string` produces `string Age; ... Age < 60`, which the CML compiler rejects.
  //
  // `decimal`, not `int`: a Salesforce Number attribute may carry decimal places, and the
  // safe-literal guard already admits `500.5` for it. PcmGenerator declares the same attribute
  // `decimal` in the same model, so declaring `int` here would put two disagreeing declarations
  // of one attribute into one model.
  it('declares a numeric attribute with its real CML type, not string (H4)', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'Rule1', 'p1'),
        ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Number', values: ['60'] }],
          },
        ]),
      },
    ];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'UW', 'Test');
    const ageAttr = cmlModel.getType('autoSilver')?.attributes.find((a) => a.name === 'Age');
    expect(ageAttr?.type).to.equal('decimal');
  });

  it('declares a Boolean attribute as boolean and a string attribute as string (H4)', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'Rule1', 'p1'),
        ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [
              { attributeName: 'IsActive', operator: 'Equals', dataType: 'Boolean', values: ['true'] },
              { attributeName: 'Model', operator: 'Equals', dataType: 'String', values: ['SUV'] },
            ],
          },
        ]),
      },
    ];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'UW', 'Test');
    const attrs = cmlModel.getType('autoSilver')?.attributes ?? [];
    expect(attrs.find((a) => a.name === 'IsActive')?.type).to.equal('boolean');
    expect(attrs.find((a) => a.name === 'Model')?.type).to.equal('string');
  });

  it('falls back to string when an attribute appears with conflicting dataTypes (H4)', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'Rule1', 'p1'),
        ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Score', operator: 'GreaterThan', dataType: 'Number', values: ['10'] }],
          },
        ]),
      },
      {
        record: makeRecord('r2', 'Rule2', 'p1'),
        ruleDef: makeRuleDef('Rule2', 'Rule2', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Score', operator: 'Equals', dataType: 'String', values: ['high'] }],
          },
        ]),
      },
    ];
    const { cmlModel } = buildCmlModel(ruleDefs, new Map([['p1', 'autoSilver']]), 'UW', 'Test');
    const scoreAttr = cmlModel.getType('autoSilver')?.attributes.find((a) => a.name === 'Score');
    expect(scoreAttr?.type).to.equal('string');
  });

  // Build mode has no merge to skip out of, so the refusal happens here: the rule contributes no
  // constraint and no ruleKeyMapping entry (so its record is never flipped to the constraint
  // engine), and the reason is handed back for the command to warn with.
  it('withholds a rule carrying a value CML cannot represent, and says which', () => {
    const timestamped = (id: string, name: string): { record: RuleRecord; ruleDef: ParsedRuleDefinition } => ({
      record: makeRecord(id, name, 'p1'),
      ruleDef: makeRuleDef(name, name, 'p1', [
        {
          rootObjectId: 'p1',
          conditions: [
            {
              attributeName: 'Policy_Start',
              operator: 'Equals',
              dataType: 'Datetime',
              values: ['2026-01-01T10:00:00Z'],
            },
          ],
        },
      ]),
    });
    const ruleDefs = [
      timestamped('r1', 'TimestampRule'),
      {
        record: makeRecord('r2', 'PlainRule', 'p1'),
        ruleDef: makeRuleDef('PlainRule', 'PlainRule', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Number', values: ['60'] }],
          },
        ]),
      },
    ];
    const { cmlModel, ruleKeyMapping, skipped } = buildCmlModel(
      ruleDefs,
      new Map([['p1', 'autoSilver']]),
      'UW',
      'Test'
    );

    expect(skipped.map((s) => s.name)).to.deep.equal(['TimestampRule']);
    expect(skipped[0].recordId).to.equal('r1');
    expect(skipped[0].reason).to.match(/Policy_Start/);
    expect(ruleKeyMapping.map((m) => m.recordId)).to.deep.equal(['r2']);

    const cml = cmlModel.generateCml();
    expect(cml).to.not.include('TimestampRule');
    expect(cml).to.not.include('Policy_Start');
    expect(cml).to.include('constraint PlainRule');
  });

  it('falls back to product ID when code is not in map', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', '01tXXX'), ruleDef: makeRuleDef('Rule1', 'Rule1', '01tXXX') },
    ];
    const productMap = new Map<string, string>();
    const { cmlModel, ruleKeyMapping } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');

    expect(cmlModel.types[0].name).to.equal('01tXXX');
    expect(ruleKeyMapping[0].ruleKey).to.equal('SC__01tXXX__Rule1');
  });

  it('groups rules by the trimmed root product id (whitespace does not split a product)', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', ' p1/child1'), ruleDef: makeRuleDef('Rule1', 'Rule1', ' p1/child1') },
      { record: makeRecord('r2', 'Rule2', 'p1/child2'), ruleDef: makeRuleDef('Rule2', 'Rule2', 'p1/child2') },
    ];
    const productMap = new Map([['p1', 'ProductA']]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');
    // Both rules collapse into the single ProductA type instead of ' p1' + 'p1'.
    expect(cmlModel.types).to.have.length(1);
    expect(cmlModel.getType('ProductA')?.constraints).to.have.length(2);
  });

  it('skips records whose ProductPath is empty', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', ''), ruleDef: makeRuleDef('Rule1', 'Rule1', '') },
      { record: makeRecord('r2', 'Rule2', 'p2'), ruleDef: makeRuleDef('Rule2', 'Rule2', 'p2') },
    ];
    const productMap = new Map([['p2', 'ProductB']]);
    const { cmlModel, ruleKeyMapping } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');
    expect(cmlModel.types.map((t) => t.name)).to.deep.equal(['ProductB']);
    expect(ruleKeyMapping.map((m) => m.recordId)).to.deep.equal(['r2']);
  });

  it('generates CML output with correct type structure', () => {
    const ruleDefs = [
      {
        record: makeRecord('r1', 'Rule1', 'p1'),
        ruleDef: makeRuleDef('Rule1', 'Rule1', 'p1', [
          {
            rootObjectId: 'p1',
            conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Number', values: ['60'] }],
          },
        ]),
      },
    ];
    const productMap = new Map([['p1', 'autoSilver']]);
    const { cmlModel } = buildCmlModel(ruleDefs, productMap, 'UW', 'Test');

    const cml = cmlModel.generateCml();
    expect(cml).to.include('type autoSilver');
    expect(cml).to.include('constraint Rule1');
    expect(cml).to.include('Age < 60');
    expect(cml).to.not.include('type LineItem');
  });
});

describe('quoteSoqlIdList', () => {
  it('quotes well-formed Salesforce ids', () => {
    expect(quoteSoqlIdList(['01tSB000004V4KKYA0', '01tSB000004V4KNYA0'])).to.equal(
      "'01tSB000004V4KKYA0','01tSB000004V4KNYA0'"
    );
  });

  it('drops values that are not valid Salesforce ids (SOQL-injection safe)', () => {
    const ids = ["01tSB000004V4KKYA0') OR Name != null --", "'; DROP", '01tSB000004V4KNYA0'];
    expect(quoteSoqlIdList(ids)).to.equal("'01tSB000004V4KNYA0'");
  });

  it('returns an empty string when no ids are valid', () => {
    expect(quoteSoqlIdList(["') OR Id != null", 'not-an-id'])).to.equal('');
  });
});

describe('discoverCmlApiByProducts', () => {
  it('returns ApiName when existing CML is found', async () => {
    const conn = mockConnection({
      ExpressionSetConstraintObj: { records: [{ ExpressionSetId: '0RB000000000001AAA' }] },
      ExpressionSet: { records: [{ ApiName: 'AutoTest' }] },
    });
    const result = await discoverCmlApiByProducts(conn, new Set(['01tSB000004V4KKYA0']));
    expect(result).to.equal('AutoTest');
  });

  it('returns undefined when no associations exist', async () => {
    const conn = mockConnection({
      ExpressionSetConstraintObj: { records: [] },
    });
    const result = await discoverCmlApiByProducts(conn, new Set(['01tSB000004V4KKYA0']));
    expect(result).to.be.undefined;
  });

  it('returns undefined when ExpressionSet not found', async () => {
    const conn = mockConnection({
      ExpressionSetConstraintObj: { records: [{ ExpressionSetId: '0RB000000000001AAA' }] },
    });
    const result = await discoverCmlApiByProducts(conn, new Set(['01tSB000004V4KKYA0']));
    expect(result).to.be.undefined;
  });

  it('returns undefined for empty product set', async () => {
    const conn = mockConnection({});
    const result = await discoverCmlApiByProducts(conn, new Set());
    expect(result).to.be.undefined;
  });
});

describe('isSafeAssociationReferenceValue', () => {
  it('accepts ordinary product names, including spaces', () => {
    expect(isSafeAssociationReferenceValue('Auto Silver')).to.equal(true);
    expect(isSafeAssociationReferenceValue('autoSilver')).to.equal(true);
    expect(isSafeAssociationReferenceValue('Health Plan 2026')).to.equal(true);
  });

  // The reference value is written into a naive comma-joined CSV column AND, downstream, into the
  // importer's single-quoted SOQL `WHERE Name IN ('<value>')`. A comma shifts the CSV column; a
  // single/double quote, backslash, or newline breaks out of the CSV cell or the SOQL literal.
  it('rejects a comma (would shift the CSV column)', () => {
    expect(isSafeAssociationReferenceValue('Auto, Silver')).to.equal(false);
  });

  it('rejects quotes, backslash, and newlines (CSV / SOQL break-out)', () => {
    expect(isSafeAssociationReferenceValue("O'Brien")).to.equal(false);
    expect(isSafeAssociationReferenceValue('a"b')).to.equal(false);
    expect(isSafeAssociationReferenceValue('a\\b')).to.equal(false);
    expect(isSafeAssociationReferenceValue('a\nb')).to.equal(false);
    expect(isSafeAssociationReferenceValue('a\rb')).to.equal(false);
  });

  it('rejects an empty / whitespace-only value', () => {
    expect(isSafeAssociationReferenceValue('')).to.equal(false);
    expect(isSafeAssociationReferenceValue('   ')).to.equal(false);
  });
});

describe('fetchProductCodes', () => {
  it('returns map of product ID to ProductCode', async () => {
    const conn = mockConnection({
      Product2: {
        records: [
          { Id: '01tSB000004V4KKYA0', ProductCode: 'autoSilver', Name: 'Auto Silver' },
          { Id: '01tSB000004V4KNYA0', ProductCode: 'health', Name: 'Health Plan' },
        ],
      },
    });
    const result = await fetchProductCodes(conn, new Set(['01tSB000004V4KKYA0', '01tSB000004V4KNYA0']));
    expect(result.get('01tSB000004V4KKYA0')).to.equal('autoSilver');
    expect(result.get('01tSB000004V4KNYA0')).to.equal('health');
  });

  it('falls back to Name when ProductCode is null', async () => {
    const conn = mockConnection({
      Product2: { records: [{ Id: '01tSB000004V4KKYA0', ProductCode: null, Name: 'FallbackName' }] },
    });
    const result = await fetchProductCodes(conn, new Set(['01tSB000004V4KKYA0']));
    expect(result.get('01tSB000004V4KKYA0')).to.equal('FallbackName');
  });

  it('returns empty map for empty product set', async () => {
    const conn = mockConnection({});
    const result = await fetchProductCodes(conn, new Set());
    expect(result.size).to.equal(0);
  });
});

describe('condition data type resolution', () => {
  const DEDUCTIBLE_ID = '0tjfiw000000CMBAA2';
  const LIMIT_ID = '0tjfiw000000CM9AAM';

  // Shaped after a live ProductSurcharge.RuleDefinition: the conditions declare dataType
  // 'Picklist' and carry the AttributeDefinition id, but nothing about the comparable type.
  const picklistRule = (): { ruleCriteria: RuleCriteria[] } => ({
    ruleCriteria: [
      {
        rootObjectId: '01tfiw000000bKaAAI',
        criteriaIndex: 1,
        conditions: [
          {
            contextTagName: 'SalesTransactionItemAttribute',
            attributeName: 'Deductible',
            attributeId: DEDUCTIBLE_ID,
            attributePicklistValueId: '0v6fiw000000GJSAA2',
            operator: 'Equals',
            dataType: 'Picklist',
            values: ['500'],
          },
          {
            contextTagName: 'SalesTransactionItemAttribute',
            attributeName: 'Limit',
            attributeId: LIMIT_ID,
            attributePicklistValueId: '0v6fiw000000GJTAA2',
            operator: 'NotEquals',
            dataType: 'Picklist',
            values: ['2000'],
          },
        ],
      },
    ] as RuleCriteria[],
  });

  const currencyPicklists = (): Map<string, string> =>
    new Map([
      [DEDUCTIBLE_ID, 'Currency'],
      [LIMIT_ID, 'Currency'],
    ]);

  const oneCondition = (dataType: string, values: string[], operator = 'Equals'): { ruleCriteria: RuleCriteria[] } => ({
    ruleCriteria: [
      {
        rootObjectId: '01t',
        conditions: [{ attributeName: 'Attr', operator, dataType, values }],
      },
    ] as RuleCriteria[],
  });

  // A Picklist declares no comparable type of its own — the type lives on the AttributePicklist
  // behind it. Unresolved, a numeric picklist value reaches the curated model quoted, so a decimal
  // attribute is compared against a string literal and the rule never fires.
  it('emits numeric picklist values unquoted when the picklist resolves to Currency', () => {
    expect(buildConstraintDeclaration(picklistRule(), currencyPicklists())).to.equal(
      'Deductible == 500 && Limit != 2000'
    );
  });

  it('keeps text picklist values quoted', () => {
    const resolved = new Map([
      [DEDUCTIBLE_ID, 'Text'],
      [LIMIT_ID, 'Text'],
    ]);
    expect(buildConstraintDeclaration(picklistRule(), resolved)).to.equal('Deductible == "500" && Limit != "2000"');
  });

  // No resolution available (attribute deleted, or not queryable) must stay on the safe quoted
  // path rather than guessing a numeric comparison.
  it('quotes picklist values when the picklist type cannot be resolved', () => {
    expect(buildConstraintDeclaration(picklistRule())).to.equal('Deductible == "500" && Limit != "2000"');
  });

  it('declares a resolved numeric picklist attribute as decimal, matching the emitted literal', () => {
    const ruleDefs = [
      {
        record: { Id: 'r1', Name: 'Rule1', ProductPath: 'p1' } as RuleRecord,
        ruleDef: { name: 'Rule1', apiName: 'Rule1', productPath: 'p1', ...picklistRule() } as ParsedRuleDefinition,
      },
    ];
    const { cmlModel } = buildCmlModel(
      ruleDefs,
      new Map([['p1', 'autoSilver']]),
      'SC',
      'Test',
      'InsuranceSurchargeRule',
      undefined,
      currencyPicklists()
    );

    const type = cmlModel.getType('autoSilver');
    expect(type?.getAttribute('Deductible')?.type).to.equal('decimal');
    expect(type?.getAttribute('Limit')?.type).to.equal('decimal');
  });

  // An empty dataType used to resolve to '' — neither a known type nor STRING — which took the
  // unquoted path, failed the safe-literal guard, dropped every condition and collapsed the
  // declaration to `true`. A surcharge rule then applies unconditionally.
  it('treats an empty dataType as string instead of dropping the condition', () => {
    expect(buildConstraintDeclaration(oneCondition('', ['SUV']))).to.equal('Attr == "SUV"');
  });

  it('does not collapse a rule to true when a dataType is empty', () => {
    expect(buildConstraintDeclaration(oneCondition('', ['SUV']))).to.not.equal('true');
  });

  it('resolves dataType case-insensitively', () => {
    expect(buildConstraintDeclaration(oneCondition('number', ['2020']))).to.equal('Attr == 2020');
    expect(buildConstraintDeclaration(oneCondition('CURRENCY', ['10.5']))).to.equal('Attr == 10.5');
  });

  // Real payloads spell it 'Datetime'; the map only had 'DateTime'.
  it('resolves the Datetime spelling used by real payloads', () => {
    expect(buildConstraintDeclaration(oneCondition('Datetime', ['2026-03-01']))).to.equal('Attr == "2026-03-01"');
  });

  // Quoting a date is load-bearing, not cosmetic: verified against a live model, the unquoted form
  // is read as arithmetic and fails the DEPLOY, taking every rule in the model down with it. The
  // relational case is the one the shared emitter would otherwise leave bare.
  it('quotes a date literal on every operator, including relational', () => {
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01']))).to.equal('Attr == "2026-03-01"');
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01'], 'GreaterThan'))).to.equal(
      'Attr > "2026-03-01"'
    );
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01'], 'LessThanOrEquals'))).to.equal(
      'Attr <= "2026-03-01"'
    );
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01'], 'NotEquals'))).to.equal(
      'Attr != "2026-03-01"'
    );
  });

  // In/NotIn reach a different branch of the shared emitter than the comparison operators do, so
  // they are pinned separately: the quoting here comes from this path's own pre-quoting, and a
  // refactor that moved it could fix the comparisons while leaving list membership bare.
  it('quotes a date literal in an In / NotIn list too', () => {
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01', '2026-09-01'], 'In'))).to.equal(
      '(Attr == "2026-03-01" || Attr == "2026-09-01")'
    );
    expect(buildConstraintDeclaration(oneCondition('Date', ['2026-03-01'], 'NotIn'))).to.equal(
      '!(Attr == "2026-03-01")'
    );
  });

  // A valueless operator must not acquire an empty quoted literal from the date path.
  it('leaves a valueless date operator alone', () => {
    expect(buildConstraintDeclaration(oneCondition('Date', [], 'IsNull'))).to.equal('Attr == null');
  });

  // The quotes make the compiler accept any text, so the bare-date shape check has to survive the
  // move to the quoted path — otherwise this deploys cleanly and silently never fires.
  it('still refuses a date value that is not a bare date, rather than quoting it through', () => {
    expect(buildConstraintDeclaration(oneCondition('Date', ['next tuesday']))).to.equal('true');
    expect(buildConstraintDeclaration(oneCondition('Date', ['2020-01-01) || x(']))).to.equal('true');
  });

  // Numeric and boolean stay bare — the date exception must not leak into the types the live
  // staircase exercised unquoted.
  it('leaves numeric and boolean literals unquoted', () => {
    expect(buildConstraintDeclaration(oneCondition('Number', ['2020'], 'GreaterThan'))).to.equal('Attr > 2020');
    expect(buildConstraintDeclaration(oneCondition('Boolean', ['true']))).to.equal('Attr == true');
  });

  // CML's `date` cannot hold a time, so a value carrying one is not convertible at all — see
  // findUnconvertibleConditions, which withholds the whole rule rather than let it reach here and
  // lose a condition. A bare date is unaffected.
  it('reports a rule as unconvertible when a date-typed condition carries a time component', () => {
    const reasons = findUnconvertibleConditions(oneCondition('Datetime', ['2026-01-01T10:00:00Z']));
    expect(reasons).to.have.length(1);
    expect(reasons[0]).to.match(/Attr/);
    expect(reasons[0]).to.match(/2026-01-01T10:00:00Z/);
  });

  it('reports nothing unconvertible for a bare date', () => {
    expect(findUnconvertibleConditions(oneCondition('Datetime', ['2026-03-01']))).to.deep.equal([]);
    expect(findUnconvertibleConditions(oneCondition('Date', ['2026-03-01'], 'GreaterThan'))).to.deep.equal([]);
  });

  // A timestamp compared as text is a plain quoted string comparison — odd, but faithfully
  // representable, so it is not this guard's business.
  it('reports nothing unconvertible for a timestamp on a text attribute', () => {
    expect(findUnconvertibleConditions(oneCondition('Text', ['2026-01-01T10:00:00Z']))).to.deep.equal([]);
  });

  // strcontain() is a string function, and a substring test against an attribute the model declares
  // decimal/boolean/date has no faithful CML form: quoting the value type-mismatches the attribute
  // (the never-fires shape), and unquoting it is not even a substring test. Same treatment as the
  // timestamp — withhold the rule and name it, rather than emit something that silently does
  // nothing.
  it('reports a rule as unconvertible when Contains is applied to a non-string attribute', () => {
    const reasons = findUnconvertibleConditions(oneCondition('Currency', ['500'], 'Contains'));
    expect(reasons).to.have.length(1);
    expect(reasons[0]).to.match(/Attr/);
    expect(reasons[0]).to.match(/Contains/);
    expect(reasons[0]).to.match(/decimal/);
  });

  it('reports DoesNotContain on a non-string attribute as unconvertible too', () => {
    expect(findUnconvertibleConditions(oneCondition('Checkbox', ['true'], 'DoesNotContain'))).to.have.length(1);
    expect(findUnconvertibleConditions(oneCondition('Date', ['2026-03-01'], 'DoesNotContain'))).to.have.length(1);
  });

  // The reference org's only use of these four operators is a Contains on a String attribute. It is
  // faithfully representable and must keep converting exactly as it does today.
  it('reports nothing unconvertible for a substring test on a string attribute', () => {
    expect(findUnconvertibleConditions(oneCondition('Text', ['Severe'], 'Contains'))).to.deep.equal([]);
    expect(findUnconvertibleConditions(oneCondition('String', ['Severe'], 'DoesNotContain'))).to.deep.equal([]);
  });

  it('still emits strcontain for a substring test on a string attribute', () => {
    expect(buildConstraintDeclaration(oneCondition('Text', ['Severe'], 'Contains'))).to.equal(
      'strcontain(Attr, "Severe")'
    );
    expect(buildConstraintDeclaration(oneCondition('String', ['Severe'], 'DoesNotContain'))).to.equal(
      '!strcontain(Attr, "Severe")'
    );
  });

  // An unresolvable type already falls back to string, which is a representable substring test —
  // the guard must not turn that fallback into a refusal.
  it('reports nothing unconvertible for a substring test on an unresolved type', () => {
    expect(findUnconvertibleConditions(oneCondition('Lookup', ['500'], 'Contains'))).to.deep.equal([]);
    expect(findUnconvertibleConditions(oneCondition('', ['500'], 'Contains'))).to.deep.equal([]);
  });

  // In/NotIn expand into `==` chains, so a quoted value on a non-string attribute is the same
  // never-fires mismatch the Picklist resolution above fixes — `Deductible == "500"` against the
  // `decimal Deductible` the model declares.
  it('emits In values unquoted when the type is not string', () => {
    expect(buildConstraintDeclaration(oneCondition('Currency', ['500', '1000'], 'In'))).to.equal(
      '(Attr == 500 || Attr == 1000)'
    );
    expect(buildConstraintDeclaration(oneCondition('Checkbox', ['true', 'false'], 'In'))).to.equal(
      '(Attr == true || Attr == false)'
    );
  });

  it('emits NotIn values unquoted when the type is not string', () => {
    expect(buildConstraintDeclaration(oneCondition('Number', ['500', '1000'], 'NotIn'))).to.equal(
      '!(Attr == 500 || Attr == 1000)'
    );
  });

  it('keeps In and NotIn values quoted on a string type', () => {
    expect(buildConstraintDeclaration(oneCondition('Text', ['SUV', 'Sedan'], 'In'))).to.equal(
      '(Attr == "SUV" || Attr == "Sedan")'
    );
    expect(buildConstraintDeclaration(oneCondition('Text', ['SUV'], 'NotIn'))).to.equal('!(Attr == "SUV")');
  });

  // Unresolvable type stays on the quoted path, the same conservative direction Equals takes.
  it('quotes In values when the type cannot be resolved', () => {
    expect(buildConstraintDeclaration(oneCondition('Lookup', ['500'], 'In'))).to.equal('(Attr == "500")');
  });

  // The end-to-end case: a Deductible behind a Currency picklist, declared `decimal`, compared with
  // In. Resolution and emission have to agree or the rule imports cleanly and never fires.
  it('emits In values unquoted for a picklist that resolves to Currency', () => {
    const rule = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Deductible',
              attributeId: DEDUCTIBLE_ID,
              operator: 'In',
              dataType: 'Picklist',
              values: ['500', '1000'],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(rule, currencyPicklists())).to.equal('(Deductible == 500 || Deductible == 1000)');
    expect(collectAttributeTypes([{ ruleDef: rule }], currencyPicklists()).get('Deductible')).to.equal('decimal');
  });

  it('emits Decimal and Double values unquoted', () => {
    expect(buildConstraintDeclaration(oneCondition('Decimal', ['12.5']))).to.equal('Attr == 12.5');
    expect(buildConstraintDeclaration(oneCondition('Double', ['12.5']))).to.equal('Attr == 12.5');
  });

  it('still quotes genuinely unknown data types', () => {
    expect(buildConstraintDeclaration(oneCondition('Lookup', ['01tfiw000000bKaAAI']))).to.equal(
      'Attr == "01tfiw000000bKaAAI"'
    );
  });

  it('derives attribute types from the resolved picklist type', () => {
    const types = collectAttributeTypes([{ ruleDef: picklistRule() }], currencyPicklists());
    expect(types.get('Deductible')).to.equal('decimal');
  });

  // 'Checkbox' is what AttributeDefinition.DataType calls a boolean attribute, and what
  // fetchAttributeDataTypes hands back verbatim for one. Unmapped it fell to STRING and emitted
  // `Has_Anti_Theft == "true"` against the `boolean Has_Anti_Theft;` PcmGenerator declares — the
  // same never-fires mismatch the Picklist resolution above fixes. Note the trap this hid behind:
  // 'Boolean' (the spelling AttributePicklist.DataType uses) WAS mapped, so a Boolean-backed
  // picklist worked while a raw Checkbox silently did not.
  it('emits a Checkbox condition value unquoted, matching the boolean attribute it compares against', () => {
    expect(buildConstraintDeclaration(oneCondition('Checkbox', ['true']))).to.equal('Attr == true');
    expect(buildConstraintDeclaration(oneCondition('Checkbox', ['false'], 'NotEquals'))).to.equal('Attr != false');
  });

  it('declares a Checkbox attribute as boolean, the same type PcmGenerator declares it', () => {
    const types = collectAttributeTypes([{ ruleDef: oneCondition('Checkbox', ['true']) }]);
    expect(types.get('Attr')).to.equal('boolean');
  });

  // Both maps declare attributes into the SAME model, so a source type they disagree about
  // produces two contradictory declarations of one attribute. Number was the disagreement:
  // insurance said `int`, PcmGenerator said `decimal`. A Salesforce Number attribute can carry
  // decimal places and the safe-literal guard already admits `500.5` for one, so `decimal` is the
  // correct side of the disagreement to keep.
  it('declares Number the same way PcmGenerator does', () => {
    const types = collectAttributeTypes([{ ruleDef: oneCondition('Number', ['500.5']) }]);
    expect(types.get('Attr')).to.equal(PcmGenerator.dataTypeNameToCmlDataType('Number'));
    expect(types.get('Attr')).to.equal('decimal');
  });

  // Aligning the declaration must not disturb how values are emitted: the safe-literal guard
  // treats int and decimal identically, and the shared emitter quotes only for `string`.
  it('emits Number values exactly as before, whole or fractional', () => {
    expect(buildConstraintDeclaration(oneCondition('Number', ['2020']))).to.equal('Attr == 2020');
    expect(buildConstraintDeclaration(oneCondition('Number', ['500.5']))).to.equal('Attr == 500.5');
    expect(buildConstraintDeclaration(oneCondition('Number', ['60'], 'LessThan'))).to.equal('Attr < 60');
    expect(buildConstraintDeclaration(oneCondition('Number', ['not-a-number']))).to.equal('true');
  });

  // fetchAttributeDataTypes records a non-picklist attribute's own DataType verbatim, so the
  // org-resolved path hands the mapping the literal string 'Checkbox'.
  it('emits a Checkbox value unquoted when the type came from the org rather than the condition', () => {
    const rule = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            {
              attributeName: 'Has_Anti_Theft',
              attributeId: '0tjfiw000000CMBAA2',
              operator: 'Equals',
              dataType: 'Picklist',
              values: ['true'],
            },
          ],
        },
      ] as RuleCriteria[],
    };
    const resolved = new Map([['0tjfiw000000CMBAA2', 'Checkbox']]);
    expect(buildConstraintDeclaration(rule, resolved)).to.equal('Has_Anti_Theft == true');
  });
});

/**
 * `buildConstraintDeclaration` answers `true` in two situations that mean opposite things.
 *
 * A rule with no criteria genuinely applies always, and curated models carry such lines — that
 * `true` is correct and must not change.
 *
 * A rule whose criteria existed but lost every condition to a safety guard (unknown operator,
 * missing values, a value the safe-literal or quotable-string guard refused) is a conversion
 * FAILURE reported as success: the rule is placed as `rule(true, ...)` and matches every quote.
 * For a surcharge that charges every customer; for underwriting it is an always-true constraint.
 * That rule is withheld and named instead, through the same `findUnconvertibleConditions` channel
 * the datetime and substring refusals use.
 */
describe('a rule whose every condition was dropped in conversion', () => {
  const DEDUCTIBLE_ID = '0tjfiw000000CMBAA2';

  const criteriaWith = (conditions: RuleCondition[]): RuleCriteria[] => [{ rootObjectId: '01t', conditions }];

  const ruleWith = (conditions: RuleCondition[]): ParsedRuleDefinition => ({
    name: 'Deductible Fee',
    apiName: 'DeductibleFee',
    productPath: 'p1',
    ruleCriteria: criteriaWith(conditions),
  });

  // Fails isSafeUnquotedLiteral on the decimal path, so the only condition drops.
  const unsafeNumeric = (): RuleCondition[] => [
    { attributeName: 'Deductible', operator: 'Equals', dataType: 'Number', values: ['not-a-number'] },
  ];

  it('is reported as unconvertible rather than silently collapsing to true', () => {
    const reasons = findUnconvertibleConditions(ruleWith(unsafeNumeric()));
    expect(reasons).to.have.length(1);
    // Names the rule, says the conditions could not be converted, and says where the rule was left.
    expect(reasons[0]).to.match(/DeductibleFee/);
    expect(reasons[0]).to.match(/could not be converted/);
    expect(reasons[0]).to.match(/left on the rule engine/);
  });

  // The measured case that motivated this: a Deductible behind a Currency picklist compared with
  // In against a mixed list. The numeric path refuses 'Premium', the condition drops, and the rule
  // used to arrive as `true` — matching every quote instead of the two deductibles it names.
  it('covers an In list mixing a number with a value the numeric guard refuses', () => {
    const rule = ruleWith([
      {
        attributeName: 'Deductible',
        attributeId: DEDUCTIBLE_ID,
        operator: 'In',
        dataType: 'Picklist',
        values: ['500', 'Premium'],
      },
    ]);
    const currencyPicklist = new Map([[DEDUCTIBLE_ID, 'Currency']]);

    expect(buildConstraintDeclaration(rule, currencyPicklist)).to.equal('true');
    expect(findUnconvertibleConditions(rule, currencyPicklist)).to.have.length(1);
  });

  // The case that must NOT change: no criteria at all is a rule that really does always apply.
  it('leaves a rule with no criteria alone, which genuinely applies always', () => {
    expect(findUnconvertibleConditions({})).to.deep.equal([]);
    expect(findUnconvertibleConditions({ ruleCriteria: [] })).to.deep.equal([]);
    expect(buildConstraintDeclaration({ ruleCriteria: [] })).to.equal('true');
  });

  // A criteria carrying no conditions dropped nothing either — there was never anything to convert,
  // so it is the always-applies case in a different spelling, not a failure.
  it('leaves a criteria with no conditions alone', () => {
    expect(findUnconvertibleConditions({ ruleCriteria: criteriaWith([]) })).to.deep.equal([]);
  });

  // Out of scope here (see the partial-drop note): one condition of several dropping still emits.
  it('says nothing about a rule that kept at least one condition', () => {
    const rule = ruleWith([
      ...unsafeNumeric(),
      { attributeName: 'Model', operator: 'Equals', dataType: 'Text', values: ['SUV'] },
    ]);
    expect(findUnconvertibleConditions(rule)).to.deep.equal([]);
    expect(buildConstraintDeclaration(rule)).to.equal('Model == "SUV"');
  });

  // A condition-specific refusal already explains itself; the generic collapse reason would only
  // repeat it less usefully.
  it('does not add a second reason when a named refusal already explains the collapse', () => {
    const rule = ruleWith([
      { attributeName: 'Policy_Start', operator: 'Equals', dataType: 'Datetime', values: ['2026-01-01T10:00:00Z'] },
    ]);
    const reasons = findUnconvertibleConditions(rule);
    expect(reasons).to.have.length(1);
    expect(reasons[0]).to.match(/timestamp/);
  });

  describe('build mode', () => {
    const entry = (ruleDef: ParsedRuleDefinition): { record: RuleRecord; ruleDef: ParsedRuleDefinition } => ({
      record: { Id: 'r1', Name: 'Deductible Fee', ProductPath: 'p1' },
      ruleDef,
    });
    const codes = (): Map<string, string> => new Map([['p1', 'autoSilver']]);

    // Surcharge form: `rule(decl, "InsuranceSurchargeRule", ...)`.
    it('withholds the rule from the surcharge form instead of emitting rule(true, ...)', () => {
      const { cmlModel, ruleKeyMapping, skipped } = buildCmlModel(
        [entry(ruleWith(unsafeNumeric()))],
        codes(),
        'SC',
        'Surcharge eligibility',
        'InsuranceSurchargeRule'
      );

      expect(skipped).to.have.length(1);
      expect(skipped[0].name).to.equal('Deductible Fee');
      expect(skipped[0].reason).to.match(/DeductibleFee/);
      // No mapping entry, so the record is never flipped to the constraint engine.
      expect(ruleKeyMapping).to.have.length(0);
      expect(cmlModel.getType('autoSilver')).to.be.undefined;
    });

    // Underwriting form: `constraint <name> = (decl, "label");`. An always-true constraint is the
    // same hazard as an always-firing surcharge rule.
    it('withholds the rule from the underwriting constraint form too', () => {
      const { cmlModel, ruleKeyMapping, skipped } = buildCmlModel(
        [entry(ruleWith(unsafeNumeric()))],
        codes(),
        'UW',
        'Underwriting eligibility'
      );

      expect(skipped).to.have.length(1);
      expect(ruleKeyMapping).to.have.length(0);
      expect(cmlModel.getType('autoSilver')).to.be.undefined;
    });

    it('still emits an unconditional rule for a rule that genuinely has no criteria', () => {
      const noCriteria: ParsedRuleDefinition = { name: 'Flat Fee', apiName: 'FlatFee', productPath: 'p1' };
      const { cmlModel, ruleKeyMapping, skipped } = buildCmlModel(
        [entry(noCriteria)],
        codes(),
        'SC',
        'Surcharge eligibility',
        'InsuranceSurchargeRule'
      );

      expect(skipped).to.have.length(0);
      expect(ruleKeyMapping).to.have.length(1);
      const constraints = cmlModel.getType('autoSilver')?.constraints ?? [];
      expect(constraints).to.have.length(1);
      expect(constraints[0].generateCml()).to.include('rule(true,');
    });
  });
});

/**
 * The complete platform surface of source data types, pinned type by type.
 *
 * These two lists are the ONLY things that reach the type map: `fetchAttributeDataTypes` records a
 * non-picklist attribute's own `AttributeDefinition.DataType` verbatim, and resolves a Picklist one
 * to its `AttributePicklist.DataType`. Both lists are the allowed values of those two fields, read
 * from `sf sobject describe --sobject AttributeDefinition` and
 * `sf sobject describe --sobject AttributePicklist` (the `DataType` field's picklistValues,
 * captured 2026-08-12; re-run both describes to re-check them). An unmapped type does not
 * fail loudly on its own — it silently takes the STRING fallback and emits a quoted value, which
 * against a non-string attribute is a rule that imports cleanly and never fires. That is how
 * Checkbox went unnoticed. So the surface is asserted exhaustively here instead.
 */
const ATTRIBUTE_DEFINITION_DATA_TYPES: Readonly<Record<string, string>> = {
  Checkbox: CML_DATA_TYPES.BOOLEAN,
  Date: CML_DATA_TYPES.DATE,
  // `date` is the closest CML has; a value carrying a time is separately refused outright — see
  // the findUnconvertibleConditions cases above and the cross-check at the end of this suite.
  Datetime: CML_DATA_TYPES.DATE,
  Number: CML_DATA_TYPES.DECIMAL,
  Text: CML_DATA_TYPES.STRING,
  Currency: CML_DATA_TYPES.DECIMAL,
  Percent: CML_DATA_TYPES.DECIMAL,
  // Deliberately the fallback: a picklist carries no comparable type of its own, and
  // fetchAttributeDataTypes replaces it with the AttributePicklist type below whenever that is
  // resolvable. Reaching here means it was not, and quoting is the safe direction.
  Picklist: CML_DATA_TYPES.STRING,
};

const ATTRIBUTE_PICKLIST_DATA_TYPES: Readonly<Record<string, string>> = {
  // AttributePicklist's spelling of what AttributeDefinition calls Checkbox.
  Boolean: CML_DATA_TYPES.BOOLEAN,
  Date: CML_DATA_TYPES.DATE,
  Datetime: CML_DATA_TYPES.DATE,
  Number: CML_DATA_TYPES.DECIMAL,
  Text: CML_DATA_TYPES.STRING,
  Currency: CML_DATA_TYPES.DECIMAL,
  Percent: CML_DATA_TYPES.DECIMAL,
};

const guidance = (sobject: string, source: string, expected: string): string =>
  `${sobject}.DataType '${source}' must resolve to CML '${expected}'.\n` +
  `  If the platform added '${source}': add it to SOURCE_DATA_TYPE_TO_CML in ` +
  'src/shared/insurance/insurance-rule-generator.ts AND to dataTypeToCmlType in ' +
  'src/shared/pcm-generator.ts — both declare these attributes into the same model, so a type they ' +
  'disagree about gets two contradictory declarations. Leaving it unmapped is not neutral: it takes ' +
  'the string fallback, quotes the value, and yields a rule that never fires against a non-string ' +
  'attribute. If CML has no faithful representation for it, refuse it in ' +
  'findUnconvertibleConditions instead of approximating.\n' +
  `  If this list is what changed: confirm '${source}' against ` +
  `\`sf sobject describe --sobject ${sobject}\` before editing the expectation.`;

describe('every platform data type resolves to an intended CML type', () => {
  const resolve = (dataType: string): string | undefined => {
    const ruleDef = {
      ruleCriteria: [
        { rootObjectId: '01t', conditions: [{ attributeName: 'Attr', operator: 'Equals', dataType, values: ['x'] }] },
      ] as RuleCriteria[],
    };
    return collectAttributeTypes([{ ruleDef }]).get('Attr');
  };

  for (const [source, expected] of Object.entries(ATTRIBUTE_DEFINITION_DATA_TYPES)) {
    it(`AttributeDefinition.DataType '${source}' -> ${expected}`, () => {
      expect(resolve(source), guidance('AttributeDefinition', source, expected)).to.equal(expected);
    });
  }

  for (const [source, expected] of Object.entries(ATTRIBUTE_PICKLIST_DATA_TYPES)) {
    it(`AttributePicklist.DataType '${source}' -> ${expected}`, () => {
      expect(resolve(source), guidance('AttributePicklist', source, expected)).to.equal(expected);
    });
  }

  // Guards the table itself: an expectation naming a type CML does not have would otherwise pin a
  // model that cannot compile.
  it('expects only real CML primitives', () => {
    const primitives = new Set(Object.values(CML_DATA_TYPES));
    for (const expected of [
      ...Object.values(ATTRIBUTE_DEFINITION_DATA_TYPES),
      ...Object.values(ATTRIBUTE_PICKLIST_DATA_TYPES),
    ]) {
      expect(primitives.has(expected), `'${expected}' is not one of CML_DATA_TYPES`).to.equal(true);
    }
  });

  // Datetime maps to `date` only because that is the nearest slot; it is NOT a licence to emit a
  // timestamp into it. Pinned together so removing the refusal cannot leave the mapping looking
  // like an endorsement.
  it('does not let the Datetime -> date mapping stand in for datetime support', () => {
    const withTime = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Attr', operator: 'Equals', dataType: 'Datetime', values: ['2026-01-01T10:00:00Z'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(findUnconvertibleConditions(withTime)).to.have.length(1);
  });

  // The fallback is the deliberate answer for a genuinely unknown type and must stay; the point of
  // the table above is that no KNOWN type relies on it.
  it('still falls back to string for a type outside both lists', () => {
    expect(resolve('SomeFutureType')).to.equal(CML_DATA_TYPES.STRING);
  });
});

describe('fetchAttributeDataTypes', () => {
  it('resolves a picklist attribute to the picklist data type', async () => {
    const conn = mockConnection({
      AttributeDefinition: {
        records: [
          { Id: '0tjfiw000000CMBAA2', DataType: 'Picklist', Picklist: { DataType: 'Currency' } },
          { Id: '0tjfiw000000CM9AAM', DataType: 'Picklist', Picklist: { DataType: 'Currency' } },
        ],
      },
    });
    const result = await fetchAttributeDataTypes(conn, new Set(['0tjfiw000000CMBAA2', '0tjfiw000000CM9AAM']));
    expect(result.get('0tjfiw000000CMBAA2')).to.equal('Currency');
    expect(result.get('0tjfiw000000CM9AAM')).to.equal('Currency');
  });

  it('resolves a non-picklist attribute to its own data type', async () => {
    const conn = mockConnection({
      AttributeDefinition: {
        records: [{ Id: '0tjfiw000000CMBAA2', DataType: 'Number', Picklist: null }],
      },
    });
    const result = await fetchAttributeDataTypes(conn, new Set(['0tjfiw000000CMBAA2']));
    expect(result.get('0tjfiw000000CMBAA2')).to.equal('Number');
  });

  // Leaving the entry out (rather than recording 'Picklist') keeps the caller on the safe quoted
  // path instead of asking it to interpret a type that carries no comparable type.
  it('omits a picklist whose picklist type is unavailable', async () => {
    const conn = mockConnection({
      AttributeDefinition: {
        records: [{ Id: '0tjfiw000000CMBAA2', DataType: 'Picklist', Picklist: null }],
      },
    });
    const result = await fetchAttributeDataTypes(conn, new Set(['0tjfiw000000CMBAA2']));
    expect(result.has('0tjfiw000000CMBAA2')).to.equal(false);
  });

  it('returns an empty map without querying for an empty id set', async () => {
    let queried = false;
    const conn = {
      query: () => {
        queried = true;
        return Promise.resolve({ records: [] });
      },
    } as unknown as Connection;
    const result = await fetchAttributeDataTypes(conn, new Set());
    expect(result.size).to.equal(0);
    expect(queried).to.equal(false);
  });
});
