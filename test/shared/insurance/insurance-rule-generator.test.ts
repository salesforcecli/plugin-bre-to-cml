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
  collectEmittedAttributes,
  decodeHtmlEntities,
  generateRuleKey,
  isSafeAssociationReferenceValue,
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

  // isSafeNumericLiteral is `/^-?\d+(\.\d+)?$/` — a LEADING PLUS is not part of the grammar, so a
  // `+123` relational RHS must be rejected (it would emit `Year > +123`, which the CML compiler
  // rejects, and more importantly proves the guard does not silently widen the numeric shape).
  it('drops a relational condition whose numeric value carries a leading plus sign', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Year', operator: 'GreaterThan', dataType: 'Number', values: ['+123'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  // isSafeDateLiteral accepts an ISO-8601 datetime component, so a clean Date Equals with a time
  // suffix survives the unquoted-emission guard and lands bare.
  it('allows a clean ISO datetime literal through a Date-typed Equals', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [
            { attributeName: 'EffDate', operator: 'Equals', dataType: 'Date', values: ['2026-01-31T23:59:59Z'] },
          ],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('EffDate == 2026-01-31T23:59:59Z');
  });

  // The date guard is FORMAT-only (it does not range-check calendar components): a syntactically
  // well-formed but calendar-invalid date like 2020-13-45 passes because it cannot break out of the
  // unquoted slot. This test pins that documented limitation so a future "tighten the regex" change
  // is a conscious decision, not an accidental behavior shift.
  it('admits a format-valid but calendar-invalid date (guard is shape-only, not a calendar check)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'EffDate', operator: 'Equals', dataType: 'Date', values: ['2020-13-45'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('EffDate == 2020-13-45');
  });

  // Multi-value In runs every value through the string-quotable guard (`values.every(...)`). A single
  // backslash-bearing value in the list poisons the whole condition — it is dropped wholesale, never
  // partially emitted, so a hostile value smuggled into one slot of a multi-value In cannot survive.
  it('drops a multi-value In condition when any single value is not safely quotable', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'In', dataType: 'String', values: ['SUV', 'Tru\\ck", "x'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('true');
  });

  it('expands a clean multi-value In into an OR of equality checks (regression guard)', () => {
    const ruleDef = {
      ruleCriteria: [
        {
          rootObjectId: '01t',
          conditions: [{ attributeName: 'Model', operator: 'In', dataType: 'String', values: ['SUV', 'Truck'] }],
        },
      ] as RuleCriteria[],
    };
    expect(buildConstraintDeclaration(ruleDef)).to.equal('(Model == "SUV" || Model == "Truck")');
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

// collectEmittedAttributes is the merge-mode companion to collectAttributes: it returns only the
// (sanitized) attributes that actually reach the emitted CML — i.e. those on conditions whose
// buildConditionExpression survived. It is what gates the absent-attribute warnings, so a condition
// the safe-literal / unknown-operator filter dropped must NOT contribute its attribute.
describe('collectEmittedAttributes', () => {
  it('returns an empty set when there are no criteria', () => {
    expect(collectEmittedAttributes([{ ruleDef: {} }]).size).to.equal(0);
  });

  it('returns sanitized names (matching how they appear in the emitted declaration)', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Auto Value', operator: 'Equals', dataType: 'String', values: ['x'] }],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    // collectAttributes keeps the raw name; collectEmittedAttributes sanitizes it.
    expect(collectAttributes(ruleDefs)).to.deep.equal(new Set(['Auto Value']));
    expect(collectEmittedAttributes(ruleDefs)).to.deep.equal(new Set(['Auto_Value']));
  });

  it('excludes the attribute of a condition dropped by an unknown operator', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [
                { attributeName: 'Kept', operator: 'Equals', dataType: 'String', values: ['x'] },
                { attributeName: 'Dropped', operator: 'NoSuchOp', dataType: 'String', values: ['y'] },
              ],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    expect(collectEmittedAttributes(ruleDefs)).to.deep.equal(new Set(['Kept']));
  });

  it('excludes the attribute of a condition the safe-literal guard dropped (hostile unquoted RHS)', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [
                { attributeName: 'Limit', operator: 'GreaterThan', dataType: 'Number', values: ['1000'] },
                { attributeName: 'Hijacked', operator: 'Equals', dataType: 'Number', values: ['2020) || evil('] },
              ],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    // collectAttributes still sees the hostile attribute; collectEmittedAttributes does not.
    expect(collectAttributes(ruleDefs)).to.deep.equal(new Set(['Limit', 'Hijacked']));
    expect(collectEmittedAttributes(ruleDefs)).to.deep.equal(new Set(['Limit']));
  });

  it('uses contextTagName (sanitized) when attributeName is missing', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ contextTagName: 'Tag A', operator: 'Equals', dataType: 'String', values: ['x'] }],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    expect(collectEmittedAttributes(ruleDefs)).to.deep.equal(new Set(['Tag_A']));
  });
});

// collectAttributeTypes derives each attribute's real CML type from its condition dataType, keyed by
// the RAW (un-sanitized) attribute name, and falls back to STRING on a type conflict or unknown type.
// buildCmlModel relies on it for H4 (declaring numeric attributes as int, not string).
describe('collectAttributeTypes', () => {
  it('maps each dataType to its CML type', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [
                { attributeName: 'Count', operator: 'Equals', dataType: 'Number', values: ['1'] },
                { attributeName: 'Rate', operator: 'Equals', dataType: 'Percent', values: ['1'] },
                { attributeName: 'Premium', operator: 'Equals', dataType: 'Currency', values: ['1'] },
                { attributeName: 'Active', operator: 'Equals', dataType: 'Boolean', values: ['true'] },
                { attributeName: 'Eff', operator: 'Equals', dataType: 'Date', values: ['2026-01-01'] },
                { attributeName: 'Label', operator: 'Equals', dataType: 'String', values: ['x'] },
              ],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    const types = collectAttributeTypes(ruleDefs);
    expect(types.get('Count')).to.equal('int');
    expect(types.get('Rate')).to.equal('decimal');
    expect(types.get('Premium')).to.equal('decimal');
    expect(types.get('Active')).to.equal('boolean');
    expect(types.get('Eff')).to.equal('date');
    expect(types.get('Label')).to.equal('string');
  });

  it('falls back to string for an unknown / missing dataType', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [
                { attributeName: 'Mystery', operator: 'Equals', dataType: 'Geolocation', values: ['x'] },
                { attributeName: 'NoType', operator: 'Equals', values: ['x'] },
              ],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    const types = collectAttributeTypes(ruleDefs);
    expect(types.get('Mystery')).to.equal('string');
    expect(types.get('NoType')).to.equal('string');
  });

  it('falls back to string when one attribute appears with conflicting dataTypes', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Score', operator: 'GreaterThan', dataType: 'Number', values: ['10'] }],
            },
          ],
        },
      },
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Score', operator: 'Equals', dataType: 'String', values: ['high'] }],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    expect(collectAttributeTypes(ruleDefs).get('Score')).to.equal('string');
  });

  it('keeps a consistent repeated dataType (no spurious conflict downgrade)', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Age', operator: 'GreaterThan', dataType: 'Number', values: ['18'] }],
            },
          ],
        },
      },
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Age', operator: 'LessThan', dataType: 'Integer', values: ['65'] }],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    // Number and Integer both map to `int`, so there is no conflict — stays int, not downgraded.
    expect(collectAttributeTypes(ruleDefs).get('Age')).to.equal('int');
  });

  it('keys by the raw attribute name (not sanitized)', () => {
    const ruleDefs = [
      {
        ruleDef: {
          ruleCriteria: [
            {
              rootObjectId: '01t',
              conditions: [{ attributeName: 'Auto Value', operator: 'GreaterThan', dataType: 'Number', values: ['1'] }],
            },
          ],
        },
      },
    ] as Array<{ ruleDef: { ruleCriteria?: RuleCriteria[] } }>;
    const types = collectAttributeTypes(ruleDefs);
    expect(types.get('Auto Value')).to.equal('int');
    expect(types.has('Auto_Value')).to.equal(false);
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
    expect(ageAttr?.type).to.equal('int');
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
