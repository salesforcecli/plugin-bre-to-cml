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
  buildUnderwritingConstraintRules,
  fetchExistingConstraintModel,
  fetchProductTypeTags,
  mergeSurchargeRules,
  mergeUnderwritingConstraints,
  splitProductPath,
  SURCHARGE_RULE_ACTION,
} from '../../../src/shared/insurance/insurance-cml-merge.js';
import { ParsedRuleDefinition, RuleCondition, RuleRecord } from '../../../src/shared/insurance/models.js';

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

  // ProductPath is nullable in the org even on records that carry a rule. Throwing here aborted the
  // entire conversion run before any record could reach the empty-ProductPath skip.
  it('returns an empty array for a null or undefined path', () => {
    expect(splitProductPath(null)).to.deep.equal([]);
    expect(splitProductPath(undefined)).to.deep.equal([]);
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

  // Records can carry a rule with ProductPath null in the org. Building must yield an empty path so
  // the record reaches the empty-ProductPath skip, rather than throwing and aborting the whole run.
  it('yields empty pathProductCodes for a null ProductPath instead of throwing', () => {
    const ruleDefs = [
      { record: { Id: 'r1', Name: 'Auto_HighRiskTax', ProductPath: null }, ruleDef: makeRuleDef('Fee', '') },
    ];

    const build = (): ReturnType<typeof buildPathedSurchargeRules> =>
      buildPathedSurchargeRules('SC', ruleDefs, new Map(), new Map());
    expect(build).to.not.throw();

    const [rule] = build();
    expect(rule.pathProductCodes).to.deep.equal([]);

    // And the merge then reports it as a skip rather than placing it.
    const { placements, skips } = mergeSurchargeRules(GOLD_CML, [rule]);
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/empty ProductPath|non-pathed/i);
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

  it('uses the parent Surcharge.Code (not the apiName) as the key leaf when resolvable', () => {
    const record = makeRecord('r1', 'Basic_Tax', 'p1');
    const ruleDef = { name: 'Basic_Tax', apiName: 'Basic_Tax', productPath: 'p1', surchargeId: 'sc1' };
    const [rule] = buildPathedSurchargeRules(
      'SC',
      [{ record, ruleDef }],
      new Map([['p1', 'commProperty']]),
      new Map(),
      {
        surchargeIdToCode: new Map([['sc1', 'basictaxcode']]),
      }
    );
    // Matches the platform-generated ProductSurcharge.RuleKey (Surcharge.Code leaf), not SC__commProperty__Basic_Tax.
    expect(rule.ruleKey).to.equal('SC__commProperty__basictaxcode');
    expect(rule.statement).to.include('"SC__commProperty__basictaxcode"');
  });

  it('falls back to apiName and fires onSurchargeCodeFallback when the Surcharge.Code is unresolved', () => {
    const record = makeRecord('r1', 'Basic_Tax', 'p1');
    const ruleDef = { name: 'Basic_Tax', apiName: 'Basic_Tax', productPath: 'p1', surchargeId: 'scMissing' };
    const missed: string[] = [];
    const [rule] = buildPathedSurchargeRules(
      'SC',
      [{ record, ruleDef }],
      new Map([['p1', 'commProperty']]),
      new Map(),
      {
        surchargeIdToCode: new Map(),
        onSurchargeCodeFallback: (name) => missed.push(name),
      }
    );
    expect(rule.ruleKey).to.equal('SC__commProperty__Basic_Tax');
    expect(missed).to.deep.equal(['Basic_Tax']);
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
    // Default to a non-empty pathProductCodes so the empty-path guard does not fire in existing
    // tests. A test that exercises Fix #3 overrides this to [] explicitly.
    pathProductCodes: ['autoSilver'],
    typeName,
    statement: buildSurchargeRuleStatement(declaration, ruleKey),
    referencedAttributes: [],
    // No context tags by default: these fixtures exercise placement, not binding. The
    // context-tag suite below builds rules that carry declarations explicitly.
    contextTagDeclarations: [],
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

  // ---- Fix #3: an empty / whitespace-only ProductPath surcharge must be skipped, NEVER reach the
  // destructive replace path — even if its degenerate `SC__<apiName>` key coincidentally appears in a
  // curated line.
  it('Fix #3: skips a surcharge with empty pathProductCodes and never replaces a coincidentally-keyed curated line', () => {
    // Curated model carries a single-segment-keyed rule that, with an empty ProductPath, the rule key
    // would degenerate to: `SC__FEE`. A naive replace would clobber this curated line.
    const model = `
type Collision {
    int Limit = [1000];
    rule(true, "InsuranceSurchargeRule", "SC__FEE", "True");
}
`;
    const r = {
      ...rule('SC__FEE', 'Collision', 'Limit > 9999'),
      pathProductCodes: [], // <-- the malformed input under test
    };
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    // The surcharge is reported as a skip; no placement was emitted.
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/empty ProductPath|non-pathed/i);

    // CRITICAL: the curated line was NOT clobbered — its original `rule(true, ...)` body survives
    // verbatim, proving the empty-path guard runs BEFORE findSurchargeStatement.
    expect(mergedCml).to.include('rule(true, "InsuranceSurchargeRule", "SC__FEE", "True");');
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

  // The solver rejects the whole model at deploy when a reference does not resolve, taking every
  // other rule in the ExpressionSet down with it, so an unresolvable rule must never be emitted.
  it('withholds a rule whose declaration references an attribute absent from the model', () => {
    // Mirror real buildPathedSurchargeRules output: the referenced attribute is embedded in the
    // statement declaration. The rule must still be withheld because the attribute is absent from
    // the ORIGINAL curated model — proving the check runs against the baseline, not the post-insert
    // text (which always contains the attribute inside the rule's own statement).
    const r = {
      ...rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'NonExistentAttribute > 5'),
      referencedAttributes: ['NonExistentAttribute'],
    };
    const { mergedCml, placements, skips, attributeWarnings } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/undeclared attribute/);
    expect(skips[0].reason).to.match(/NonExistentAttribute/);
    expect(attributeWarnings).to.have.length(1);
    expect(attributeWarnings[0]).to.match(/NonExistentAttribute/);
    // The model is left exactly as found.
    expect(mergedCml).to.equal(GOLD_CML);
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

  // ---- C2: replace must anchor on a real surcharge rule statement carrying THIS key, never on a
  // bare quoted-key substring that appears inside an unrelated rule / comment / longer key.
  it('C2: does not clobber an unrelated curated rule that merely quotes this key as a value', () => {
    // A curated rule whose VALUE slot quotes the incoming key, plus a different action+key. The naive
    // indexOf('"'+key+'"') matches the value occurrence and overwrites this whole curated line.
    const model = `
type Collision {
    int Limit = [1000, 2000, 5000];
    rule(label == "SC__autoSilver__auto__collision__FEE", "InsuranceSurchargeRule", "SC__OTHER_KEY", "True");
}
`;
    const r = rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'Limit > 1000');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    // The unrelated curated rule survives untouched.
    expect(mergedCml).to.include('"SC__OTHER_KEY"');
    expect(mergedCml).to.include('label == "SC__autoSilver__auto__collision__FEE"');
    // Our key is treated as not-present → inserted as a real statement (not a destructive replace).
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');
  });

  it('C2: does not treat a longer key containing this key as a substring as a replace', () => {
    // Existing statement carries a LONGER key whose text contains our key as a substring. The replace
    // path must NOT latch onto it; our (shorter) key is genuinely absent → insert.
    const model = `
type Collision {
    int Limit = [1000, 2000, 5000];
    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__FEE_EXTENDED", "True");
}
`;
    const r = rule('SC__autoSilver__auto__collision__FEE', 'Collision');
    const { mergedCml, placements } = mergeSurchargeRules(model, [r]);
    // The longer pre-existing rule is intact.
    expect(mergedCml).to.include('"SC__autoSilver__auto__collision__FEE_EXTENDED"');
    expect(placements[0].status).to.equal('inserted');
    // Exactly one statement now carries the exact key in the action slot.
    expect(mergedCml).to.include('"InsuranceSurchargeRule", "SC__autoSilver__auto__collision__FEE", "True"');
  });

  it('C2: replaces the real surcharge statement for this key when one genuinely exists', () => {
    const r = rule('SC__autoSilver__auto__collision__CMLCodeAmount1', 'Collision', 'Limit > 9999');
    const { mergedCml, placements } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(placements[0].status).to.equal('replaced');
    expect(mergedCml).to.include('rule(Limit > 9999, "InsuranceSurchargeRule"');
    // Key still appears exactly once (no duplicate).
    expect(mergedCml.split(r.ruleKey)).to.have.length(2);
  });

  // ---- H1: two rules in ONE run resolving to the same key → one placed, the other a reported skip.
  it('H1: flags an intra-run duplicate key as a collision skip rather than silently replacing', () => {
    const dupKey = 'SC__autoSilver__auto__comprehensive__DUP';
    const first = { ...rule(dupKey, 'Comprehensive', 'true'), recordName: 'FirstSurcharge' };
    const second = { ...rule(dupKey, 'Comprehensive', 'Deductible > 50'), recordName: 'SecondSurcharge' };
    const { placements, skips, mergedCml } = mergeSurchargeRules(GOLD_CML, [first, second]);

    // Only the first is placed; the second is reported (not silently overwriting the first).
    expect(placements).to.have.length(1);
    expect(placements[0].rule.recordName).to.equal('FirstSurcharge');
    expect(skips).to.have.length(1);
    expect(skips[0].rule.recordName).to.equal('SecondSurcharge');
    expect(skips[0].reason).to.match(/duplicate/i);
    // The first record's statement is the one that landed; it was NOT replaced by the second's.
    expect(mergedCml).to.include('rule(true, "InsuranceSurchargeRule", "' + dupKey + '"');
    expect(mergedCml).to.not.include('Deductible > 50');
    expect(mergedCml.split(dupKey)).to.have.length(2);
  });

  // ---- H2: brace scanner must be comment-aware (a `}` inside // or /* */ must not close the block).
  it('H2: a commented-out `}` inside the block body does not end the block early', () => {
    const model = `
type Collision {
    int Limit = [1000, 2000, 5000];
    // a curly here should be ignored }
    /* and a block comment } too */
    int Floor = [0];
}
`;
    const r = rule('SC__autoSilver__auto__collision__NEW', 'Collision');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);
    expect(skips).to.have.length(0);
    expect(placements[0].status).to.equal('inserted');
    // The rule lands AFTER the real last member (Floor), i.e. before the structural close — not
    // spliced in right after the commented brace. (Before the fix the scanner counted a comment `}`
    // as the close and inserted right after `int Limit`, ahead of Floor.)
    const floorIdx = mergedCml.indexOf('int Floor = [0];');
    const ruleIdx = mergedCml.indexOf(r.ruleKey);
    expect(ruleIdx).to.be.greaterThan(floorIdx);
  });

  it('H2: a `}` inside a comment in a sibling block does not corrupt placement', () => {
    const model = `
type Comprehensive {
    // closing brace in comment }
    int Deductible = [0, 50, 100];
}

type Collision {
    int Limit = [1000, 2000, 5000];
}
`;
    const r = rule('SC__autoSilver__auto__collision__NEW', 'Collision');
    const { mergedCml, placements } = mergeSurchargeRules(model, [r]);
    expect(placements[0].status).to.equal('inserted');
    const collisionIdx = mergedCml.indexOf('type Collision {');
    const ruleIdx = mergedCml.indexOf(r.ruleKey);
    // The rule lands inside the real Collision block (after its header). Before the fix the sibling
    // Comprehensive comment `}` mis-balanced depth and the Collision block resolved off-target.
    expect(ruleIdx).to.be.greaterThan(collisionIdx);
    const limitIdx = mergedCml.indexOf('int Limit = [1000, 2000, 5000];');
    expect(ruleIdx).to.be.greaterThan(limitIdx);
  });

  // ---- Fix #1: findTypeBlock must run its anchor regex against the comment-blanked SCAN view, so a
  // commented-out `type X { ... }` header is not double-counted as a real second declaration that
  // would otherwise trigger an ambiguity skip.
  it('Fix #1: a block-commented duplicate type header does not make the real same-named type ambiguous', () => {
    const model = `
/* historical:
   type Collision {
       int OldLimit = [500];
   }
*/

type Collision {
    int Limit = [1000];
}
`;
    const r = rule('SC__autoSilver__auto__collision__FEE', 'Collision');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    // The block-commented header is ignored: the real Collision block resolves unambiguously and the
    // rule is inserted into it. Before Fix #1 the regex on raw cml matched twice → ambiguity skip.
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');

    // The historical comment survives verbatim.
    expect(mergedCml).to.include('/* historical:');
    expect(mergedCml).to.include('int OldLimit = [500];');
    // The new rule landed inside the real Collision block (after `int Limit`).
    const limitIdx = mergedCml.indexOf('int Limit = [1000];');
    const newIdx = mergedCml.indexOf(r.ruleKey);
    expect(newIdx).to.be.greaterThan(limitIdx);
  });

  // ---- M1 + M5: duplicate leaf type name. Prefer an unambiguous resolution; if ambiguous, skip.
  it('M5: skips with a clear reason when more than one block shares the leaf type name', () => {
    const model = `
type Collision {
    int Limit = [1000];
}

type Collision {
    int Other = [2000];
}
`;
    const r = rule('SC__autoSilver__auto__collision__NEW', 'Collision');
    const { placements, skips } = mergeSurchargeRules(model, [r]);
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/ambiguous|multiple|duplicate/i);
  });

  // ---- H5 + M3: attribute presence check must be scoped to the leaf type block (+ ancestry),
  // ignoring comments and string literals and unrelated sibling blocks.
  it('H5: warns when the attribute is present only inside a comment', () => {
    const model = `
type Collision {
    // mentions GhostAttr in a comment only
    int Limit = [1000];
}
`;
    const r = {
      ...rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'GhostAttr > 5'),
      referencedAttributes: ['GhostAttr'],
    };
    const { attributeWarnings } = mergeSurchargeRules(model, [r]);
    expect(attributeWarnings).to.have.length(1);
    expect(attributeWarnings[0]).to.match(/GhostAttr/);
  });

  it('M3: warns when the attribute appears only inside a string literal', () => {
    const model = `
type Collision {
    rule(label == "SiblingAttr", "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__OTHER", "True");
    int Limit = [1000];
}
`;
    const r = {
      ...rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'SiblingAttr > 5'),
      referencedAttributes: ['SiblingAttr'],
    };
    const { attributeWarnings } = mergeSurchargeRules(model, [r]);
    expect(attributeWarnings).to.have.length(1);
    expect(attributeWarnings[0]).to.match(/SiblingAttr/);
  });

  it('H5: does NOT warn when the attribute is declared inside the leaf block or its `: Parent` ancestry', () => {
    // Leaf Vehicle declares constraint2 directly; Year is declared in its ancestor Auto
    // (`type Vehicle : Auto`). Both must resolve via the scoped leaf-plus-ancestry check.
    const r = {
      ...rule('SC__autoSilver__auto__vehicle__FEE', 'Vehicle', 'Year > 2000'),
      referencedAttributes: ['constraint2', 'Year'],
    };
    const { attributeWarnings } = mergeSurchargeRules(GOLD_CML, [r]);
    expect(attributeWarnings).to.have.length(0);
  });

  // ---- M4: a comment that merely mentions the key must NOT trigger a destructive replace.
  it('M4: a comment mentioning the key does not trigger a replace of the comment line', () => {
    const model = `
type Collision {
    // historical note: "SC__autoSilver__auto__collision__FEE" was removed
    int Limit = [1000];
}
`;
    const r = rule('SC__autoSilver__auto__collision__FEE', 'Collision');
    const { mergedCml, placements } = mergeSurchargeRules(model, [r]);
    expect(placements[0].status).to.equal('inserted');
    // The comment is preserved verbatim.
    expect(mergedCml).to.include('// historical note: "SC__autoSilver__auto__collision__FEE" was removed');
  });

  // ---- C2 (block-comment facet): a single-line /* */ block comment that documents the rule shape
  // with this key in the action-scope slot must NOT be mistaken for a real statement and clobbered.
  it('C2: a single-line block comment documenting the rule shape does not trigger a replace', () => {
    const model = `
type Collision {
    int Limit = [1000, 2000, 5000];
    /* example: rule(label == "x", "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__FEE", "True"); */
    int Deductible = [100, 250];
}
`;
    const r = rule('SC__autoSilver__auto__collision__FEE', 'Collision', 'Limit > 1000');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    // There is NO real rule statement for this key (only a block-comment mention) → INSERT, not replace.
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');
    // The documenting block comment survives verbatim.
    expect(mergedCml).to.include(
      '/* example: rule(label == "x", "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__FEE", "True"); */'
    );
    // The real inserted statement is present (and is the only action-scope occurrence of the key).
    expect(mergedCml).to.include(
      'rule(Limit > 1000, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__FEE", "True");'
    );
  });

  // ---- H5 (unresolvable-leaf facet): an ambiguous leaf type block means we cannot prove what a
  // reference resolves to, so the rule is withheld — and, critically, withheld BEFORE the replace
  // path, so a key match alone can never rewrite a curated statement in a model we cannot reason
  // about. The reason names the ambiguity rather than blaming the attribute, because "declare
  // SneakyAttr" is not the fix when the type block itself is duplicated.
  it('H5: an ambiguous leaf type withholds the rule without clobbering the existing statement', () => {
    // Duplicate `type Collision` → collectTypeScopeText returns undefined (ambiguous). An existing
    // surcharge statement for the key forces the REPLACE path (which runs before type-block resolution).
    // SneakyAttr is declared ONLY on the unrelated sibling type Helper — never on any Collision block.
    const model = `
type Helper { int SneakyAttr = [1]; }
type Collision {
    int Limit = [1000];
    rule(SneakyAttr > 5, "InsuranceSurchargeRule", "SC__x__collision__FEE", "True");
}
type Collision { int Other = [2]; }
`;
    const r = {
      ...rule('SC__x__collision__FEE', 'Collision', 'SneakyAttr > 5'),
      referencedAttributes: ['SneakyAttr'],
    };
    const { mergedCml, placements, skips, attributeWarnings } = mergeSurchargeRules(model, [r]);

    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/is ambiguous/);
    // The attribute gate never runs, so SneakyAttr is not blamed for a type-block problem.
    expect(attributeWarnings).to.have.length(0);
    // CRITICAL: the rule matched an existing statement, so the withholding must happen BEFORE the
    // replace splice — otherwise we would clobber the curated line on the way to skipping the rule.
    expect(mergedCml).to.equal(model);
  });

  // ---- L1: replace happens within the correct block.
  it('L1: replace targets the statement inside the rule type block, not a same-key mention elsewhere', () => {
    const model = `
type Comprehensive {
    // "SC__autoSilver__auto__collision__CMLCodeAmount1" referenced in a comment here
    int Deductible = [0];
}

type Collision {
    int Limit = [1000];
    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__CMLCodeAmount1", "True");
}
`;
    const r = rule('SC__autoSilver__auto__collision__CMLCodeAmount1', 'Collision', 'Limit > 1000');
    const { mergedCml, placements } = mergeSurchargeRules(model, [r]);
    expect(placements[0].status).to.equal('replaced');
    // The Comprehensive comment is untouched; the replace happened in the Collision block.
    expect(mergedCml).to.include('referenced in a comment here');
    expect(mergedCml).to.include('rule(Limit > 1000, "InsuranceSurchargeRule"');
  });

  // ---- A statement carrying the rule's key but sitting in a DIFFERENT type block than the one the
  // rule resolves to. Observed live in the autosilver org, where a medPay-keyed surcharge sits in
  // `type Collision`. Rewriting it where it stands cements the misplacement, and — more seriously —
  // the attribute gate proved visibility against the RESOLVED block, so the reference may not
  // resolve where the statement actually lives, which is what takes the whole model down at deploy.
  it('withholds a rule whose existing statement sits outside its resolved type block', () => {
    const model = `
type Collision {
    int Deductible = [500];
    int Limit = [1000];
    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__medPay__Amount1", "True");
}

type MedicalPayments {
    int Deductible = [500];
    int Limit = [1000];
}
`;
    const r = rule('SC__autoSilver__medPay__Amount1', 'MedicalPayments', 'Deductible == 500');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/misplaced statement/);
    expect(skips[0].reason).to.match(/MedicalPayments/);
    // The curated statement is left exactly where the modeller put it.
    expect(mergedCml).to.equal(model);
  });

  it('still replaces in place when the existing statement is inside the resolved type block', () => {
    const model = `
type MedicalPayments {
    int Deductible = [500];
    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__medPay__Amount1", "True");
}
`;
    const r = rule('SC__autoSilver__medPay__Amount1', 'MedicalPayments', 'Deductible == 500');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('replaced');
    expect(mergedCml).to.include('rule(Deductible == 500, "InsuranceSurchargeRule"');
  });

  // ---- Fix #2: replace must splice ONLY the precise matched statement span (`rule(...);`), not the
  // entire physical line, so a curated line carrying TWO `rule(...);` statements keeps the unrelated
  // statement intact.
  it('Fix #2: replacing one rule on a line with two `rule(...);` statements leaves the other intact', () => {
    const otherKey = 'SC__autoSilver__auto__collision__OTHER';
    const targetKey = 'SC__autoSilver__auto__collision__TARGET';
    const model = `
type Collision {
    int Limit = [1000];
    rule(true, "InsuranceSurchargeRule", "${otherKey}", "True"); rule(true, "InsuranceSurchargeRule", "${targetKey}", "True");
}
`;
    const r = rule(targetKey, 'Collision', 'Limit > 9999');
    const { mergedCml, placements, skips } = mergeSurchargeRules(model, [r]);

    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('replaced');

    // The OTHER statement on the same line is preserved verbatim.
    expect(mergedCml).to.include(`rule(true, "InsuranceSurchargeRule", "${otherKey}", "True");`);
    // The target statement now carries the new declaration.
    expect(mergedCml).to.include(`rule(Limit > 9999, "InsuranceSurchargeRule", "${targetKey}", "True");`);
    // The OTHER key still appears exactly once (not duplicated).
    expect(mergedCml.split(otherKey)).to.have.length(2);
    // The target key still appears exactly once (replaced, not duplicated).
    expect(mergedCml.split(targetKey)).to.have.length(2);
    // Brace balance preserved.
    expect((mergedCml.match(/{/g) ?? []).length).to.equal((mergedCml.match(/}/g) ?? []).length);
  });

  // ---- Fix #4: the INSERT path must splice in the model's dominant line ending (CRLF on a
  // CRLF-curated model), not a hardcoded `\n` that would mix bare LFs into a CRLF file.
  it('Fix #4: inserting into a CRLF model uses CRLF for the splice -- output stays byte-clean', () => {
    const crlfModel = ['', 'type Collision {', '    int Limit = [1000];', '}', ''].join('\r\n');
    const r = rule('SC__autoSilver__auto__collision__NEW', 'Collision');
    const { mergedCml, placements, skips } = mergeSurchargeRules(crlfModel, [r]);

    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(placements[0].status).to.equal('inserted');

    // No bare LF was introduced anywhere -- every LF in the output is preceded by CR.
    const bareLf = /(^|[^\r])\n/.exec(mergedCml);
    expect(bareLf, 'output should not contain a bare LF').to.equal(null);
    // The newly inserted statement is present.
    expect(mergedCml).to.include(r.statement);
  });

  // ---- M4/L2: CRLF preservation on a replaced line.
  it('L2: preserves CRLF line endings when replacing a statement line', () => {
    const crlfModel = [
      '',
      'type Collision {',
      '    int Limit = [1000, 2000, 5000];',
      '    rule(true, "InsuranceSurchargeRule", "SC__autoSilver__auto__collision__CMLCodeAmount1", "True");',
      '}',
      '',
    ].join('\r\n');
    const r = rule('SC__autoSilver__auto__collision__CMLCodeAmount1', 'Collision', 'Limit > 1000');
    const { mergedCml, placements } = mergeSurchargeRules(crlfModel, [r]);
    expect(placements[0].status).to.equal('replaced');
    // No bare LF was introduced on the replaced line: every LF in the output is preceded by CR.
    const bareLf = /(^|[^\r])\n/.exec(mergedCml);
    expect(bareLf, 'output should not contain a bare LF').to.equal(null);
    expect(mergedCml).to.include('rule(Limit > 1000, "InsuranceSurchargeRule"');
  });
});

describe('buildPathedSurchargeRules (referencedAttributes scoping — M7)', () => {
  const makeRecord = (id: string, name: string, productPath: string): RuleRecord => ({
    Id: id,
    Name: name,
    ProductPath: productPath,
  });

  it('M7: excludes attributes whose condition was dropped (unknown operator) from referencedAttributes', () => {
    // One condition is emittable (Limit relational with a safe literal); the other uses an unknown
    // operator and is dropped by buildConditionExpression. Its attribute must NOT be reported as
    // referenced (otherwise it produces a spurious absent-attribute warning downstream).
    const ruleDef: ParsedRuleDefinition = {
      name: 'Fee',
      apiName: 'Fee',
      productPath: 'p1',
      ruleCriteria: [
        {
          rootObjectId: 'root',
          conditions: [
            { operator: 'GreaterThan', attributeName: 'Limit', dataType: 'Number', values: ['1000'] },
            { operator: 'NoSuchOperator', attributeName: 'DroppedAttr', dataType: 'Number', values: ['5'] },
          ],
        },
      ],
    };
    const record = makeRecord('r1', 'Fee', 'p1');
    const [rule] = buildPathedSurchargeRules(
      'SC',
      [{ record, ruleDef }],
      new Map([['p1', 'autoSilver']]),
      new Map([['p1', 'AutoSilver']])
    );
    expect(rule.referencedAttributes).to.include('Limit');
    expect(rule.referencedAttributes).to.not.include('DroppedAttr');
  });

  it('M7: excludes attributes from a hostile-value condition the safe-literal guard dropped', () => {
    const ruleDef: ParsedRuleDefinition = {
      name: 'Fee',
      apiName: 'Fee',
      productPath: 'p1',
      ruleCriteria: [
        {
          rootObjectId: 'root',
          conditions: [
            { operator: 'GreaterThan', attributeName: 'Limit', dataType: 'Number', values: ['1000'] },
            // Hostile unquoted RHS → buildConditionExpression returns null → attribute dropped.
            { operator: 'Equals', attributeName: 'Hijacked', dataType: 'Number', values: ['2020) || evil('] },
          ],
        },
      ],
    };
    const record = makeRecord('r1', 'Fee', 'p1');
    const [rule] = buildPathedSurchargeRules(
      'SC',
      [{ record, ruleDef }],
      new Map([['p1', 'autoSilver']]),
      new Map([['p1', 'AutoSilver']])
    );
    expect(rule.referencedAttributes).to.include('Limit');
    expect(rule.referencedAttributes).to.not.include('Hijacked');
  });
});

/**
 * CML has no datetime primitive — `date` is the closest slot, and it has no room for a time.
 * Emitting the timestamp anyway relies on unverified platform behavior; dropping just the offending
 * condition is worse, because nothing downstream withholds a rule whose declaration collapsed to
 * `true` (the first test below pins that), so the rule would arrive matching everything. Both merge
 * paths therefore withhold the whole rule and say why, the way they already do for a rule they
 * cannot place.
 */
describe('a rule carrying a datetime value CML cannot represent', () => {
  const record: RuleRecord = { Id: 'r1', Name: 'StartRule', ProductPath: 'p1' };

  const ruleWith = (dataType: string, values: string[], operator = 'Equals'): ParsedRuleDefinition => ({
    name: 'StartRule',
    apiName: 'StartRule',
    productPath: 'p1',
    ruleCriteria: [
      { rootObjectId: 'root', conditions: [{ operator, attributeName: 'Policy_Start', dataType, values }] },
    ],
  });

  const CURATED = 'type Driver {\n    date Policy_Start;\n}\n';
  const codes = (): Map<string, string> => new Map([['p1', 'autoSilver']]);
  const tags = (): Map<string, string> => new Map([['p1', 'Driver']]);

  const surcharge = (ruleDef: ParsedRuleDefinition): ReturnType<typeof mergeSurchargeRules> =>
    mergeSurchargeRules(CURATED, buildPathedSurchargeRules('SC', [{ record, ruleDef }], codes(), tags(), {}));

  const underwriting = (ruleDef: ParsedRuleDefinition): ReturnType<typeof mergeUnderwritingConstraints> =>
    mergeUnderwritingConstraints(
      CURATED,
      buildUnderwritingConstraintRules('UW', 'Underwriting eligibility', [{ record, ruleDef }], codes(), tags())
    );

  // The reason the withhold has to happen before the declaration is built: once
  // buildConstraintDeclaration has answered, a rule that lost every condition is indistinguishable
  // from one that never had any — both are `true`. That collapse used to be placed as an
  // unconditional rule (the empty-dataType defect's mechanism, pinned here as the justification);
  // it is now refused through this same channel, so the justification is asserted as the behavior.
  it('is why: a rule whose conditions all drop is withheld rather than placed as `true`', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith('Number', ['not-a-number']));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/could not be converted/);
    expect(mergedCml).to.not.include('rule(');
  });

  it('is withheld from the surcharge merge instead of placed', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith('Datetime', ['2026-01-01T10:00:00Z']));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/Policy_Start/);
    expect(skips[0].reason).to.match(/2026-01-01T10:00:00Z/);
    expect(mergedCml).to.not.include('rule(');
  });

  it('is withheld from the underwriting merge instead of placed', () => {
    const { mergedCml, placements, skips } = underwriting(ruleWith('Datetime', ['2026-01-01T10:00:00Z']));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/Policy_Start/);
    expect(mergedCml).to.not.include('constraint StartRule');
  });

  // The whole rule goes, not just the offending condition: dropping one condition of a multi-part
  // rule widens what the rule matches, which is the failure mode being avoided.
  it('takes the whole rule with it, rather than merging the conditions that did convert', () => {
    const ruleDef: ParsedRuleDefinition = {
      name: 'StartRule',
      apiName: 'StartRule',
      productPath: 'p1',
      ruleCriteria: [
        {
          rootObjectId: 'root',
          conditions: [
            { operator: 'Equals', attributeName: 'Model', dataType: 'Text', values: ['SUV'] },
            {
              operator: 'Equals',
              attributeName: 'Policy_Start',
              dataType: 'Datetime',
              values: ['2026-01-01T10:00:00Z'],
            },
          ],
        },
      ],
    };
    const { mergedCml, skips } = surcharge(ruleDef);
    expect(skips).to.have.length(1);
    expect(mergedCml).to.not.include('Model == "SUV"');
  });

  // A Date attribute is just as unable to hold a time, so the same guard applies to it.
  it('applies to a Date attribute handed a timestamp, not only to a Datetime one', () => {
    expect(surcharge(ruleWith('Date', ['2026-01-01T10:00:00Z'])).skips).to.have.length(1);
  });

  // Unchanged: a value with no time component has always converted cleanly and still must.
  it('leaves a bare date alone', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith('Datetime', ['2026-03-01']));
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('rule(Policy_Start == 2026-03-01,');
  });

  it('leaves a bare date alone on a relational comparison too', () => {
    const { mergedCml } = surcharge(ruleWith('Date', ['2026-03-01'], 'GreaterThan'));
    expect(mergedCml).to.include('rule(Policy_Start > 2026-03-01,');
  });
});

/**
 * `strcontain()` is a string function. Applied to an attribute the model declares decimal, boolean
 * or date, a substring test has no faithful CML form at all — the emitted `strcontain(Deductible,
 * "500")` compares a number as text and never fires. Reuses the same withhold-and-name machinery as
 * the datetime case above, for the same reason: a rule that quietly does nothing is worse than a
 * rule the operator is told to migrate by hand.
 */
describe('a rule applying a substring test to a non-string attribute', () => {
  const record: RuleRecord = { Id: 'r1', Name: 'DeductibleRule', ProductPath: 'p1' };

  const ruleWith = (dataType: string, operator: string, values = ['500']): ParsedRuleDefinition => ({
    name: 'DeductibleRule',
    apiName: 'DeductibleRule',
    productPath: 'p1',
    ruleCriteria: [{ rootObjectId: 'root', conditions: [{ operator, attributeName: 'Deductible', dataType, values }] }],
  });

  const CURATED = 'type Driver {\n    decimal Deductible;\n}\n';
  const codes = (): Map<string, string> => new Map([['p1', 'autoSilver']]);
  const tags = (): Map<string, string> => new Map([['p1', 'Driver']]);

  const surcharge = (ruleDef: ParsedRuleDefinition): ReturnType<typeof mergeSurchargeRules> =>
    mergeSurchargeRules(CURATED, buildPathedSurchargeRules('SC', [{ record, ruleDef }], codes(), tags(), {}));

  const underwriting = (ruleDef: ParsedRuleDefinition): ReturnType<typeof mergeUnderwritingConstraints> =>
    mergeUnderwritingConstraints(
      CURATED,
      buildUnderwritingConstraintRules('UW', 'Underwriting eligibility', [{ record, ruleDef }], codes(), tags())
    );

  it('is withheld from the surcharge merge instead of placed', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith('Currency', 'Contains'));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/Deductible/);
    expect(skips[0].reason).to.match(/Contains/);
    expect(mergedCml).to.not.include('strcontain');
    expect(mergedCml).to.not.include('rule(');
  });

  it('is withheld from the underwriting merge instead of placed', () => {
    const { mergedCml, placements, skips } = underwriting(ruleWith('Checkbox', 'DoesNotContain', ['true']));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/Deductible/);
    expect(mergedCml).to.not.include('constraint DeductibleRule');
  });

  // Unchanged, and the case the reference org actually has: a substring test on a String attribute
  // is representable and still converts.
  it('leaves a substring test on a string attribute alone', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith('Text', 'Contains', ['Severe']));
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('rule(strcontain(Deductible, "Severe"),');
  });
});

/**
 * A rule whose criteria existed but lost every condition to a safety guard is a conversion failure
 * reported as success: `buildConstraintDeclaration` answers `true`, and the merge places
 * `rule(true, ...)` — a surcharge that charges every customer, or an underwriting constraint that
 * is always satisfied. A rule with NO criteria answers `true` for the opposite reason: it genuinely
 * applies always, and curated models carry such lines. Only the first is withheld, through the same
 * channel as the datetime and substring refusals.
 */
describe('a rule whose every condition was dropped in conversion', () => {
  const DEDUCTIBLE_ID = '0tjfiw000000CMBAA2';
  const record: RuleRecord = { Id: 'r1', Name: 'Deductible Fee', ProductPath: 'p1' };

  const ruleWith = (conditions: RuleCondition[]): ParsedRuleDefinition => ({
    name: 'Deductible Fee',
    apiName: 'DeductibleFee',
    productPath: 'p1',
    ruleCriteria: [{ rootObjectId: 'root', conditions }],
  });

  // Refused by the numeric safe-literal guard, so the rule's only condition drops.
  const unsafeNumeric = (): RuleCondition[] => [
    { operator: 'Equals', attributeName: 'Deductible', dataType: 'Number', values: ['not-a-number'] },
  ];

  const CURATED = 'type Driver {\n    decimal Deductible;\n}\n';
  const codes = (): Map<string, string> => new Map([['p1', 'autoSilver']]);
  const tags = (): Map<string, string> => new Map([['p1', 'Driver']]);

  const surcharge = (
    ruleDef: ParsedRuleDefinition,
    attributeDataTypes?: Map<string, string>
  ): ReturnType<typeof mergeSurchargeRules> =>
    mergeSurchargeRules(
      CURATED,
      buildPathedSurchargeRules('SC', [{ record, ruleDef }], codes(), tags(), { attributeDataTypes })
    );

  const underwriting = (ruleDef: ParsedRuleDefinition): ReturnType<typeof mergeUnderwritingConstraints> =>
    mergeUnderwritingConstraints(
      CURATED,
      buildUnderwritingConstraintRules('UW', 'Underwriting eligibility', [{ record, ruleDef }], codes(), tags())
    );

  it('is withheld from the surcharge merge instead of placed as an unconditional rule', () => {
    const { mergedCml, placements, skips } = surcharge(ruleWith(unsafeNumeric()));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/DeductibleFee/);
    expect(skips[0].reason).to.match(/could not be converted/);
    expect(skips[0].reason).to.match(/left on the rule engine/);
    expect(mergedCml).to.not.include('rule(');
  });

  // An always-true constraint is the same hazard in the underwriting form.
  it('is withheld from the underwriting merge instead of placed as an always-true constraint', () => {
    const { mergedCml, placements, skips } = underwriting(ruleWith(unsafeNumeric()));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/DeductibleFee/);
    expect(mergedCml).to.not.include('constraint DeductibleFee');
    expect(mergedCml).to.not.include('true');
  });

  // The measured case: a Deductible behind a Currency picklist, compared with In against a list
  // mixing a number and a word. The numeric guard refuses 'Premium', the condition drops, and the
  // rule used to be placed as `rule(true, ...)` — every quote, not the deductibles it names.
  it('withholds an In list mixing a number with a value the numeric guard refuses', () => {
    const rule = ruleWith([
      {
        operator: 'In',
        attributeName: 'Deductible',
        attributeId: DEDUCTIBLE_ID,
        dataType: 'Picklist',
        values: ['500', 'Premium'],
      },
    ]);
    const { mergedCml, placements, skips } = surcharge(rule, new Map([[DEDUCTIBLE_ID, 'Currency']]));
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(mergedCml).to.not.include('rule(');
  });

  // The regression guard: a rule that genuinely has no criteria still converts to `true`, which is
  // the correct reading of it and is what curated models already contain.
  it('still places a rule that genuinely has no criteria as `true`', () => {
    const noCriteria: ParsedRuleDefinition = { name: 'Flat Fee', apiName: 'FlatFee', productPath: 'p1' };
    const { mergedCml, placements, skips } = surcharge(noCriteria);
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('rule(true,');
  });

  it('still places a no-criteria rule in the underwriting form too', () => {
    const noCriteria: ParsedRuleDefinition = { name: 'Flat Fee', apiName: 'FlatFee', productPath: 'p1' };
    const { mergedCml, placements, skips } = underwriting(noCriteria);
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('constraint FlatFee = (true,');
  });

  // Out of scope for this change, and asserted so the boundary is explicit: a rule that keeps one
  // of its conditions still merges, even though it now matches more than the source rule did.
  it('still places a rule that lost only some of its conditions', () => {
    const partial = ruleWith([
      ...unsafeNumeric(),
      { operator: 'Equals', attributeName: 'Deductible', dataType: 'Number', values: ['500'] },
    ]);
    const { mergedCml, placements, skips } = surcharge(partial);
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('rule(Deductible == 500,');
  });
});

describe('mergeUnderwritingConstraints (attribute-presence probe is type-sensitive)', () => {
  const record: RuleRecord = { Id: 'r1', Name: 'AgeRule', ProductPath: 'p1' };
  const ruleDef: ParsedRuleDefinition = {
    name: 'AgeRule',
    apiName: 'AgeRule',
    productPath: 'p1',
    ruleCriteria: [
      {
        rootObjectId: 'root',
        conditions: [{ operator: 'LessThan', attributeName: 'Age', dataType: 'Number', values: ['60'] }],
      },
    ],
  };
  const rules = (): ReturnType<typeof buildUnderwritingConstraintRules> =>
    buildUnderwritingConstraintRules(
      'UW',
      'Underwriting eligibility',
      [{ record, ruleDef }],
      new Map([['p1', 'autoSilver']]),
      new Map([['p1', 'Driver']])
    );

  // The probe looks for `<cmlType> <attrName>` in the leaf type block, so it only recognizes a
  // declaration whose type matches the one this converter derived. PcmGenerator declares a Number
  // attribute `decimal`, so while insurance derived `int` the probe missed every curated Number
  // attribute and reported it absent — a false alarm on exactly the models this tool targets.
  it('finds a curated Number attribute PcmGenerator declared as decimal', () => {
    const curated = 'type Driver {\n    decimal Age;\n}\n';
    const { attributeWarnings } = mergeUnderwritingConstraints(curated, rules());
    expect(attributeWarnings).to.deep.equal([]);
  });

  // Withholding, not warning: an unresolvable reference makes the solver reject the whole model at
  // deploy, so placing the constraint would disable every OTHER rule in the same ExpressionSet.
  it('withholds a constraint whose attribute the curated model really is missing', () => {
    const curated = 'type Driver {\n    string Model;\n}\n';
    const { mergedCml, placements, skips, attributeWarnings } = mergeUnderwritingConstraints(curated, rules());
    expect(placements).to.have.length(0);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/^undeclared attribute 'Age'/);
    expect(attributeWarnings).to.have.length(1);
    expect(mergedCml).to.equal(curated);
  });

  // The gate is hierarchy-aware for the same reason CML attribute visibility is: an attribute on a
  // parent type IS referable from the child. Scoping the check to the leaf block body alone — as
  // this path did while it only warned — would withhold a perfectly valid constraint.
  it('places a constraint whose attribute is inherited from a parent type', () => {
    const curated = 'type Person {\n    decimal Age;\n}\n\ntype Driver : Person {\n}\n';
    const { placements, skips } = mergeUnderwritingConstraints(curated, rules());
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
  });

  it('places a constraint whose attribute is bound by a top-level extern', () => {
    const curated = 'extern decimal Age;\n\ntype Driver {\n}\n';
    const { placements, skips } = mergeUnderwritingConstraints(curated, rules());
    expect(skips).to.have.length(0);
    expect(placements).to.have.length(1);
  });

  // The baseline guard: a placed constraint names the attributes it references, so scanning the
  // MUTATED model would let the first rule vouch for the second's missing reference.
  it('does not let a placed constraint vouch for a later rule referencing the same absent attribute', () => {
    const curated = 'type Driver {\n    decimal Age;\n}\n\ntype Vehicle {\n}\n';
    const second: RuleRecord = { Id: 'r2', Name: 'AgeRule2', ProductPath: 'p2' };
    const built = buildUnderwritingConstraintRules(
      'UW',
      'Underwriting eligibility',
      [
        { record, ruleDef },
        { record: second, ruleDef: { ...ruleDef, name: 'AgeRule2', apiName: 'AgeRule2', productPath: 'p2' } },
      ],
      new Map([
        ['p1', 'autoSilver'],
        ['p2', 'autoSilver'],
      ]),
      new Map([
        ['p1', 'Driver'],
        ['p2', 'Vehicle'],
      ])
    );
    const { placements, skips } = mergeUnderwritingConstraints(curated, built);
    expect(placements.map((p) => p.rule.recordName)).to.deep.equal(['AgeRule']);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.match(/^undeclared attribute 'Age'/);
  });
});

describe('buildPathedSurchargeRules (stage transition — M6)', () => {
  it('M6: a ruleDef with an underwritingRuleGroup lands the stage transition in the key', () => {
    const record: RuleRecord = { Id: 'r1', Name: 'Root', ProductPath: 'p1' };
    const ruleDef: ParsedRuleDefinition = {
      name: 'Root',
      apiName: 'Root',
      productPath: 'p1',
      underwritingRuleGroup: { fromStage: 'Draft', toStage: 'Approved', stageTransitionName: 'DraftToApproved' },
    };
    const [rule] = buildPathedSurchargeRules('UW', [{ record, ruleDef }], new Map([['p1', 'autoSilver']]), new Map());
    expect(rule.ruleKey).to.include('__DraftToApproved__');
    expect(rule.ruleKey).to.equal('UW__autoSilver__DraftToApproved__Root');
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

/**
 * Curated model carrying a hand-written top-level `extern`, mirroring the real Auto_Silver model.
 * The extern lives OUTSIDE every type block yet is referenced from inside one, which is exactly the
 * visibility the absent-reference gate has to understand.
 */
const GOLD_WITH_EXTERN = `
@(contextPath = "SalesTransaction.UserProfile", attributeSource = "ST")
extern string UserProfile;

type AutoSilver {
    decimal(2) totalPrice;

    require(UserProfile == "Custom Standard User", medicalpayments[MedicalPayments]);
}

type MedicalPayments {
    int Limit = [1000, 2000];
}
`;

/** Builds one surcharge rule from a single condition, through the real descriptor builder. */
function tagRuleFor(
  condition: RuleCondition,
  bindings?: Map<string, { tag: string; cmlType: string; sourceDataType: string; scope: 'transaction' | 'item' }>,
  typeName = 'AutoSilver'
): ReturnType<typeof buildPathedSurchargeRules> {
  const record: RuleRecord = { Id: '1Xr000000000001', Name: 'AutoSilver_FeeMig', ProductPath: '01tRoot' };
  const ruleDef = {
    name: 'AutoSilver_FeeMig',
    apiName: 'AutoSilver_FeeMig',
    productPath: '01tRoot',
    ruleCriteria: [{ rootObjectId: '01tRoot', conditions: [condition] }],
  } as ParsedRuleDefinition;

  return buildPathedSurchargeRules(
    'SC',
    [{ record, ruleDef }],
    new Map([['01tRoot', 'autoSilver']]),
    new Map([['01tRoot', typeName]]),
    { contextTagBindings: bindings }
  );
}

const END_DATE_CONDITION: RuleCondition = {
  contextTagName: 'EndDate',
  operator: 'Equals',
  type: 'Tag',
  attributeId: undefined,
  dataType: 'Date',
  values: ['2026-12-31'],
};

const TRANSACTION_BINDING = new Map([
  ['EndDate', { tag: 'EndDate', cmlType: 'date', sourceDataType: 'date', scope: 'transaction' as const }],
]);

describe('mergeSurchargeRules context-tag declarations', () => {
  it('declares a transaction-level tag as a top-level extern and places the rule', () => {
    const rules = tagRuleFor(END_DATE_CONDITION, TRANSACTION_BINDING);
    const { mergedCml, placements, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, rules);

    expect(skips).to.deep.equal([]);
    expect(placements).to.have.length(1);
    expect(mergedCml).to.include('@(contextPath = "SalesTransaction.EndDate", attributeSource = "ST")');
    expect(mergedCml).to.include('extern date EndDate;');
    // The declaration is top level, not inside the type block that uses it.
    expect(mergedCml.indexOf('extern date EndDate;')).to.be.lessThan(mergedCml.indexOf('type AutoSilver'));
    // ...and the rule itself compares the tag unquoted, as a date rather than as a string literal.
    expect(mergedCml).to.include('rule(EndDate == 2026-12-31, "InsuranceSurchargeRule"');
  });

  it('declares an item-level tag inside the leaf type block, not as an extern', () => {
    const condition: RuleCondition = {
      contextTagName: 'ItemTotalPrice',
      operator: 'GreaterThan',
      type: 'Tag',
      dataType: 'Currency',
      values: ['10'],
    };
    const bindings = new Map([
      [
        'ItemTotalPrice',
        { tag: 'ItemTotalPrice', cmlType: 'decimal(2)', sourceDataType: 'currency', scope: 'item' as const },
      ],
    ]);
    const { mergedCml, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(condition, bindings));

    expect(skips).to.deep.equal([]);
    expect(mergedCml).to.include('@(tagName = "ItemTotalPrice")');
    expect(mergedCml).to.include('decimal(2) ItemTotalPrice;');
    expect(mergedCml).to.not.include('extern decimal(2) ItemTotalPrice');
    // Inside the AutoSilver block: after its opening brace and before its closing one.
    const blockStart = mergedCml.indexOf('type AutoSilver {');
    const blockEnd = mergedCml.indexOf('\n}', blockStart);
    const declAt = mergedCml.indexOf('decimal(2) ItemTotalPrice;');
    expect(declAt).to.be.greaterThan(blockStart);
    expect(declAt).to.be.lessThan(blockEnd);
  });

  it('still withholds a rule whose context tag could not be resolved', () => {
    // No bindings: resolution failed, so the reference would be a bare undeclared identifier — which
    // makes the solver reject the WHOLE model at deploy, not merely this one rule.
    const { mergedCml, placements, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(END_DATE_CONDITION));

    expect(placements).to.deep.equal([]);
    expect(skips).to.have.length(1);
    expect(skips[0].reason).to.include("undeclared attribute 'EndDate'");
    expect(mergedCml).to.equal(GOLD_WITH_EXTERN);
    expect(mergedCml).to.not.include('extern date EndDate');
  });

  it('is idempotent: a second merge of the same input reproduces the same model', () => {
    const first = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(END_DATE_CONDITION, TRANSACTION_BINDING));
    const second = mergeSurchargeRules(first.mergedCml, tagRuleFor(END_DATE_CONDITION, TRANSACTION_BINDING));

    expect(second.mergedCml).to.equal(first.mergedCml);
    expect(second.skips).to.deep.equal([]);
    // One declaration, not two.
    expect(second.mergedCml.match(/extern date EndDate;/g)).to.have.length(1);
    expect(second.mergedCml.match(/contextPath = "SalesTransaction\.EndDate"/g)).to.have.length(1);
  });

  it('is idempotent for the item form too', () => {
    const condition: RuleCondition = {
      contextTagName: 'ItemTotalPrice',
      operator: 'GreaterThan',
      type: 'Tag',
      dataType: 'Currency',
      values: ['10'],
    };
    const bindings = new Map([
      [
        'ItemTotalPrice',
        { tag: 'ItemTotalPrice', cmlType: 'decimal(2)', sourceDataType: 'currency', scope: 'item' as const },
      ],
    ]);
    const first = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(condition, bindings));
    const second = mergeSurchargeRules(first.mergedCml, tagRuleFor(condition, bindings));

    expect(second.mergedCml).to.equal(first.mergedCml);
    expect(second.mergedCml.match(/@\(tagName = "ItemTotalPrice"\)/g)).to.have.length(1);
  });

  it('sanitizes the CML identifier while the annotation carries the raw tag name', () => {
    const condition: RuleCondition = {
      contextTagName: 'Cause Of Loss',
      operator: 'Equals',
      type: 'Tag',
      dataType: 'Text',
      values: ['Hail'],
    };
    const bindings = new Map([
      ['Cause Of Loss', { tag: 'Cause Of Loss', cmlType: 'string', sourceDataType: 'string', scope: 'item' as const }],
    ]);
    const { mergedCml, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(condition, bindings));

    expect(skips).to.deep.equal([]);
    // The identifier is legal CML...
    expect(mergedCml).to.include('string Cause_Of_Loss;');
    expect(mergedCml).to.include('Cause_Of_Loss == "Hail"');
    // ...and the true name is not lost — the annotation is what actually binds the value.
    expect(mergedCml).to.include('@(tagName = "Cause Of Loss")');
  });

  it('does not auto-declare an Attribute condition, which is withheld as before', () => {
    // attributeId present: a product attribute, not a context tag. Its absence usually means the
    // rule targets a type in a different model, which auto-declaring would paper over.
    const condition: RuleCondition = {
      contextTagName: 'SalesTransactionItemAttribute',
      attributeName: 'Deductible',
      attributeId: '0tjfiw000000CMBAA2',
      operator: 'Equals',
      type: 'Attribute',
      dataType: 'Text',
      values: ['500'],
    };
    const bindings = new Map([
      ['Deductible', { tag: 'Deductible', cmlType: 'string', sourceDataType: 'string', scope: 'item' as const }],
    ]);
    const { mergedCml, placements, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(condition, bindings));

    expect(placements).to.deep.equal([]);
    expect(skips[0].reason).to.include("undeclared attribute 'Deductible'");
    expect(mergedCml).to.equal(GOLD_WITH_EXTERN);
  });

  it('accepts a tag the curated model already declares as a top-level extern', () => {
    // The gate is type-scoped, and a top-level extern lives outside every type block. Without
    // recognizing it, a rule referencing an already-correctly-bound tag would be withheld.
    const condition: RuleCondition = {
      contextTagName: 'UserProfile',
      operator: 'Equals',
      type: 'Tag',
      dataType: 'Text',
      values: ['Custom Standard User'],
    };
    const { mergedCml, placements, skips } = mergeSurchargeRules(GOLD_WITH_EXTERN, tagRuleFor(condition));

    expect(skips).to.deep.equal([]);
    expect(placements).to.have.length(1);
    // Unresolved, so nothing new is declared — the existing extern is what makes it resolvable.
    expect(mergedCml.match(/extern string UserProfile;/g)).to.have.length(1);
  });
});
