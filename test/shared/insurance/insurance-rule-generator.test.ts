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
  decodeHtmlEntities,
  generateRuleKey,
  sanitizeName,
} from '../../../src/shared/insurance/insurance-rule-generator.js';
import { ParsedRuleDefinition, RuleCriteria, RuleRecord } from '../../../src/shared/insurance/models.js';
import {
  discoverCmlApiByProducts,
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

  it('maps all operators correctly', () => {
    const ops = [
      { operator: 'Equals', expected: '==' },
      { operator: 'NotEquals', expected: '!=' },
      { operator: 'LessThan', expected: '<' },
      { operator: 'LessThanOrEquals', expected: '<=' },
      { operator: 'GreaterThan', expected: '>' },
      { operator: 'GreaterThanOrEquals', expected: '>=' },
    ];
    for (const { operator, expected } of ops) {
      const ruleDef = {
        ruleCriteria: [
          {
            rootObjectId: '01t',
            conditions: [{ attributeName: 'X', operator, dataType: 'Number', values: ['5'] }],
          },
        ] as RuleCriteria[],
      };
      expect(buildConstraintDeclaration(ruleDef)).to.equal(`X ${expected} 5`);
    }
  });

  it('Contains uses strcontain function', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Description', operator: 'Contains', dataType: 'String', values: ['SUV'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('strcontain(Description, "SUV")');
  });

  it('DoesNotContain negates strcontain', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Description', operator: 'DoesNotContain', dataType: 'String', values: ['SUV'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('!strcontain(Description, "SUV")');
  });

  it('In with multiple values produces || chain', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'Model', operator: 'In', dataType: 'String', values: ['SUV', 'Sedan', 'Truck'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('(Model == "SUV" || Model == "Sedan" || Model == "Truck")');
  });

  it('In with a single value still wraps in parentheses', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'In', dataType: 'String', values: ['SUV'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('(Model == "SUV")');
  });

  it('NotIn with multiple values negates || chain', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'NotIn', dataType: 'String', values: ['SUV', 'Sedan'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('!(Model == "SUV" || Model == "Sedan")');
  });

  it('IsNull does not require values', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'IsNull' }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model == null');
  });

  it('IsNotNull does not require values', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'IsNotNull' }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Model != null');
  });

  it('escapes single quotes inside string values', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Name', operator: 'Equals', dataType: 'String', values: ["O'Brien"] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Name == "O\\\'Brien"');
  });

  it('escapes double quotes inside string values', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Greeting', operator: 'Equals', dataType: 'String', values: ['He said "hi"'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('Greeting == "He said \\"hi\\""');
  });

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

  it('falls back to product ID when code is not in map', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Rule1', '01tXXX'), ruleDef: makeRuleDef('Rule1', 'Rule1', '01tXXX') },
    ];
    const productMap = new Map<string, string>();
    const { cmlModel, ruleKeyMapping } = buildCmlModel(ruleDefs, productMap, 'SC', 'Test');

    expect(cmlModel.types[0].name).to.equal('01tXXX');
    expect(ruleKeyMapping[0].ruleKey).to.equal('SC__01tXXX__Rule1');
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
