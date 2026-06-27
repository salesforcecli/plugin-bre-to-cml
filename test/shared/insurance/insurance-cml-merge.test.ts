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
  buildPathedRuleKey,
  buildPathedSurchargeRules,
  buildSurchargeRuleStatement,
  fetchExistingConstraintModel,
  fetchProductTypeTags,
  mergeSurchargeRules,
  splitProductPath,
  SURCHARGE_RULE_ACTION,
} from '../../../src/shared/insurance/insurance-cml-merge.js';
import { ParsedRuleDefinition, RuleRecord } from '../../../src/shared/insurance/models.js';

/**
 * Minimal curated "Gold Standard"-shaped model used as the merge fixture. Mirrors the real org
 * model's nesting: a root bundle (AutoSilver), a classification (Auto), a derived bundle
 * (Vehicle : Auto), and two leaf coverages (Collision, Comprehensive). Collision already carries a
 * surcharge rule so the replace-in-place path has something to match.
 */
const GOLD_CML = `
type AutoSilver {
    relation auto : Vehicle { maxAutoValue = max(Auto_Value); }
    decimal(2) totalPrice;
}

type Auto {
    decimal(2) Auto_Value;
    int Year = [1980..2026];
}

type Vehicle : Auto {
    relation collision : Collision[0..1];
    boolean constraint2 = Year > 2023;
}

type Collision {
    int Limit = [1000, 2000, 5000];
    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__CMLCodeAmount1", "True");
}

type Comprehensive {
    int Deductible = [0, 50, 100];
}
`;

function mockConnection(opts: {
  apiVersion?: string;
  findOne?: (sobject: string) => unknown;
  request?: (url: string) => unknown;
  query?: (soql: string) => { records: unknown[] };
}): Connection {
  return {
    getApiVersion: () => opts.apiVersion ?? '68.0',
    sobject: (name: string) => ({
      findOne: () => Promise.resolve(opts.findOne ? opts.findOne(name) : null),
    }),
    request: (url: string) => Promise.resolve(opts.request ? opts.request(url) : ''),
    query: (soql: string) => Promise.resolve(opts.query ? opts.query(soql) : { records: [] }),
  } as unknown as Connection;
}

describe('buildPathedRuleKey', () => {
  it('joins prefix, every path-segment code, and the apiName with __', () => {
    expect(buildPathedRuleKey('SC', ['autoSilver', 'auto', 'collision'], 'CMLCodeAmount1')).to.equal(
      'SC__autoSilver__auto__collision__CMLCodeAmount1'
    );
  });

  it('handles a single (root-only) segment', () => {
    expect(buildPathedRuleKey('SC', ['autoSilver'], 'CML_E2E_FEE')).to.equal('SC__autoSilver__CML_E2E_FEE');
  });

  it('sanitizes each segment and the apiName', () => {
    expect(buildPathedRuleKey('SC', ['auto Silver', 'my-product'], 'Fee.One')).to.equal(
      'SC__auto_Silver__my_product__Fee_One'
    );
  });

  it('inserts a stage transition before the apiName when provided', () => {
    expect(buildPathedRuleKey('UW', ['autoSilver'], 'Root', 'DraftToApproved')).to.equal(
      'UW__autoSilver__DraftToApproved__Root'
    );
  });
});

describe('splitProductPath', () => {
  it('splits a slash-separated path into ordered ids', () => {
    expect(splitProductPath('p1/p2/p3')).to.deep.equal(['p1', 'p2', 'p3']);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(splitProductPath(' p1 / / p2 /')).to.deep.equal(['p1', 'p2']);
  });

  it('returns a single-element array for a path with no slash', () => {
    expect(splitProductPath('p1')).to.deep.equal(['p1']);
  });

  it('returns an empty array for an empty string', () => {
    expect(splitProductPath('')).to.deep.equal([]);
  });
});

describe('buildSurchargeRuleStatement', () => {
  it('emits a rule(...) statement tagged with the surcharge action and "True"', () => {
    expect(buildSurchargeRuleStatement('true', 'SC__autoSilver__MyRule')).to.equal(
      'rule(true, "InsuranceSurchargeRule", "SC__autoSilver__MyRule", "True");'
    );
  });

  it('preserves a non-trivial declaration', () => {
    expect(buildSurchargeRuleStatement('Limit > 5000', 'SC__autoSilver__auto__collision__PCT5')).to.equal(
      'rule(Limit > 5000, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__PCT5", "True");'
    );
  });
});

describe('buildPathedSurchargeRules', () => {
  const makeRecord = (id: string, name: string, productPath: string): RuleRecord => ({
    Id: id,
    Name: name,
    ProductPath: productPath,
  });
  const makeRuleDef = (apiName: string, productPath: string): ParsedRuleDefinition => ({
    name: apiName,
    apiName,
    productPath,
  });

  it('builds the pathed key from every segment code and resolves the leaf type', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'Surcharge1', 'p1/p2/p3'), ruleDef: makeRuleDef('CMLCodeAmount1', 'p1/p2/p3') },
    ];
    const codes = new Map([
      ['p1', 'autoSilver'],
      ['p2', 'auto'],
      ['p3', 'collision'],
    ]);
    const types = new Map([['p3', 'Collision']]);

    const [rule] = buildPathedSurchargeRules('SC', ruleDefs, codes, types);
    expect(rule.ruleKey).to.equal('SC__autoSilver__auto__collision__CMLCodeAmount1');
    expect(rule.typeName).to.equal('Collision');
    expect(rule.statement).to.equal(
      'rule(true, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__CMLCodeAmount1", "True");'
    );
  });

  it('falls back to the product id when a segment code is unknown', () => {
    const ruleDefs = [
      { record: makeRecord('r1', 'S1', 'p1/01tUNKNOWN'), ruleDef: makeRuleDef('Fee', 'p1/01tUNKNOWN') },
    ];
    const codes = new Map([['p1', 'autoSilver']]);
    const [rule] = buildPathedSurchargeRules('SC', ruleDefs, codes, new Map());
    expect(rule.ruleKey).to.equal('SC__autoSilver__01tUNKNOWN__Fee');
  });

  it('leaves typeName undefined when the leaf product has no type tag', () => {
    const ruleDefs = [{ record: makeRecord('r1', 'S1', 'p1/p2'), ruleDef: makeRuleDef('Fee', 'p1/p2') }];
    const codes = new Map([
      ['p1', 'autoSilver'],
      ['p2', 'auto'],
    ]);
    const [rule] = buildPathedSurchargeRules('SC', ruleDefs, codes, new Map());
    expect(rule.typeName).to.be.undefined;
  });

  it('uses the record Name as apiName when the parsed apiName is absent', () => {
    const record = makeRecord('r1', 'RecordName', 'p1');
    const ruleDef = { name: 'RecordName', productPath: 'p1' } as ParsedRuleDefinition;
    const [rule] = buildPathedSurchargeRules('SC', [{ record, ruleDef }], new Map([['p1', 'autoSilver']]), new Map());
    expect(rule.ruleKey).to.equal('SC__autoSilver__RecordName');
  });
});

describe('mergeSurchargeRules', () => {
  const rule = (
    ruleKey: string,
    typeName: string | undefined,
    declaration = 'true'
  ): Parameters<typeof mergeSurchargeRules>[1][number] => ({
    recordId: 'r1',
    recordName: ruleKey,
    apiName: ruleKey,
    ruleKey,
    typeName,
    statement: buildSurchargeRuleStatement(declaration, ruleKey),
    referencedAttributes: [],
  });

  it('inserts a new rule before the closing brace of the leaf type block', () => {
    const r = rule('SC__autoSilver__auto__comprehensive__NEW_FEE', 'Comprehensive');
    const { mergedCml, placements, skips } = mergeSurchargeRules(GOLD_CML, [r]);

    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');

    // The new rule lands inside the Comprehensive block, not Collision.
    const compIdx = mergedCml.indexOf('type Comprehensive');
    const ruleIdx = mergedCml.indexOf(r.ruleKey);
    const nextTypeIdx = mergedCml.indexOf('type ', compIdx + 1);
    expect(ruleIdx).to.be.greaterThan(compIdx);
    expect(nextTypeIdx === -1 || ruleIdx < nextTypeIdx).to.equal(true);
  });

  it('replaces an existing rule with the same key in place (idempotent)', () => {
    const r = rule('SC__autoSilver__auto__collision__CMLCodeAmount1', 'Collision', 'Limit > 1000');
    const { mergedCml, placements } = mergeSurchargeRules(GOLD_CML, [r]);

    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('replaced');
    // The declaration was updated, and the key still appears exactly once (no duplicate inserted).
    expect(mergedCml).to.include('rule(Limit > 1000, "InsuranceSurchargeRule"');
    expect(mergedCml.split(r.ruleKey)).to.have.length(2);
  });

  it('skips a rule whose leaf type tag could not be resolved', () => {
    const r = rule('SC__autoSilver__orphan__FEE', undefined);
    const { placements, skips } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/no CML type tag/);
  });

  it('skips a rule whose resolved type block is absent from the model', () => {
    const r = rule('SC__autoSilver__ghost__FEE', 'GhostType');
    const { placements, skips } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/not found/);
  });

  it('does not match a prefix type name (Auto must not match AutoSilver)', () => {
    const r = rule('SC__autoSilver__auto__FEE', 'Auto');
    const { mergedCml } = mergeSurchargeRules(GOLD_CML, [r]);

    // The rule must land inside `type Auto { ... }`, not the earlier `type AutoSilver { ... }`.
    const autoBlockStart = mergedCml.indexOf('type Auto {');
    const autoSilverStart = mergedCml.indexOf('type AutoSilver {');
    const ruleIdx = mergedCml.indexOf(r.ruleKey);
    const autoSilverEnd = mergedCml.indexOf('}', autoSilverStart);
    expect(ruleIdx).to.be.greaterThan(autoBlockStart);
    expect(ruleIdx).to.be.greaterThan(autoSilverEnd);
  });

  it('keeps brace balance after inserting multiple rules', () => {
    const rules = [
      rule('SC__autoSilver__auto__collision__INS_PCT1', 'Collision'),
      rule('SC__autoSilver__auto__comprehensive__INS_PCT2', 'Comprehensive'),
    ];
    const { mergedCml, placements } = mergeSurchargeRules(GOLD_CML, rules);
    expect(placements.every((p) => p.status === 'inserted')).to.equal(true);
    expect((mergedCml.match(/{/g) ?? []).length).to.equal((mergedCml.match(/}/g) ?? []).length);
  });

  it('warns (without skipping) when a declaration references an attribute absent from the model', () => {
    // Mirror real buildPathedSurchargeRules output: the referenced attribute is embedded in the
    // statement declaration. The warning must still fire because the attribute is absent from the
    // ORIGINAL curated model — proving the check runs against the baseline, not the post-insert text.
    const r = {
      ...rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'NonExistentAttribute > 5'),
      referencedAttributes: ['NonExistentAttribute'],
    };
    const { placements, attributeWarnings } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(placements).to.have.length(1);
    expect(attributeWarnings).to.have.length(1);
    expect(attributeWarnings[0]).to.match(/NonExistentAttribute/);
  });

  it('does not warn when the referenced attribute is present in the model', () => {
    const r = {
      ...rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'Limit > 1000'),
      referencedAttributes: ['Limit'],
    };
    const { attributeWarnings } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(attributeWarnings).to.have.length(0);
  });

  it('inserts at the correct offset when an existing statement contains a brace inside a string', () => {
    // A pre-existing rule whose declaration carries a literal `}` inside a quoted string value. The
    // brace scanner must skip the in-string brace; otherwise the new rule is spliced into the middle
    // of the existing statement, corrupting the model and unbalancing braces.
    const modelWithBraceString = `
type Collision {
    int Limit = [1000, 2000, 5000];
    rule(make == "weird}brace", "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__EXISTING", "True");
}
`;
    const r = rule('SC__autoSilver__auto__collision__NEW_FEE', 'Collision');
    const { mergedCml, placements, skips } = mergeSurchargeRules(modelWithBraceString, [r]);

    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');
    // The existing statement is left fully intact (NOT split apart by an insertion at a too-early
    // offset). Before the fix, the scanner counted the in-string `}` as the block close and spliced
    // the new rule between `"weird` and `}brace"`, corrupting this string literal.
    expect(mergedCml).to.include('rule(make == "weird}brace", "InsuranceSurchargeRule"');
    // The new rule lands AFTER the existing one and is itself a single intact statement, still inside
    // the Collision block (before its real closing brace).
    const existingIdx = mergedCml.indexOf('SC__autoSilver__auto__collision__EXISTING');
    const newIdx = mergedCml.indexOf(r.ruleKey);
    expect(newIdx).to.be.greaterThan(existingIdx);
    expect(mergedCml).to.include(r.statement);
    // The new statement sits before the block's real closing brace (the last `}` in the model).
    expect(newIdx).to.be.lessThan(mergedCml.lastIndexOf('}'));
  });
});

describe('fetchExistingConstraintModel', () => {
  it('returns the raw CML text from the blob endpoint', async () => {
    const conn = mockConnection({
      apiVersion: '68.0',
      findOne: (sobject) => (sobject === 'ExpressionSetDefinition' ? { Id: 'def1' } : { Id: 'ver1' }),
      request: (url) => {
        expect(url).to.equal('/services/data/v68.0/sobjects/ExpressionSetDefinitionVersion/ver1/ConstraintModel');
        return 'type AutoSilver { }';
      },
    });
    const result = await fetchExistingConstraintModel(conn, 'Auto_Silver');
    expect(result?.versionId).to.equal('ver1');
    expect(result?.cmlText).to.equal('type AutoSilver { }');
  });

  it('returns undefined when the ExpressionSetDefinition does not exist', async () => {
    const conn = mockConnection({ findOne: () => null });
    expect(await fetchExistingConstraintModel(conn, 'Missing')).to.be.undefined;
  });

  it('returns undefined when no version exists for the definition', async () => {
    const conn = mockConnection({
      findOne: (sobject) => (sobject === 'ExpressionSetDefinition' ? { Id: 'def1' } : null),
    });
    expect(await fetchExistingConstraintModel(conn, 'Auto_Silver')).to.be.undefined;
  });

  it('coerces a non-string blob response to empty text', async () => {
    const conn = mockConnection({
      findOne: (sobject) => (sobject === 'ExpressionSetDefinition' ? { Id: 'def1' } : { Id: 'ver1' }),
      request: () => ({ unexpected: 'object' }),
    });
    const result = await fetchExistingConstraintModel(conn, 'Auto_Silver');
    expect(result?.cmlText).to.equal('');
  });
});

describe('fetchProductTypeTags', () => {
  it('maps Product2 id to ConstraintModelTag for Type rows', async () => {
    const conn = mockConnection({
      query: (soql) => {
        expect(soql).to.include("ConstraintModelTagType = 'Type'");
        return {
          records: [
            { ReferenceObjectId: '01tA', ConstraintModelTag: 'Collision' },
            { ReferenceObjectId: '01tB', ConstraintModelTag: 'Comprehensive' },
          ],
        };
      },
    });
    const result = await fetchProductTypeTags(conn, new Set(['01tSB000004V4KKYA0', '01tSB000004V4KNYA0']));
    expect(result.get('01tA')).to.equal('Collision');
    expect(result.get('01tB')).to.equal('Comprehensive');
  });

  it('returns an empty map when no product ids are valid', async () => {
    const conn = mockConnection({});
    const result = await fetchProductTypeTags(conn, new Set(['not-an-id']));
    expect(result.size).to.equal(0);
  });
});

describe('SURCHARGE_RULE_ACTION', () => {
  it('is the platform-recognized surcharge rule action name', () => {
    expect(SURCHARGE_RULE_ACTION).to.equal('InsuranceSurchargeRule');
  });
});
