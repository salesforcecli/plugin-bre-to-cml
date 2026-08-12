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
  dynamicRuleDefinitionApiName,
  dynamicRuleDefinitionSignature,
  isAlreadyCurrent,
  parseRecordUpdatePlan,
} from '../../../src/shared/insurance/record-update-plan.js';

const SURCHARGE_ID = 'a0p000000000001';
const RULE_ID = '0UR000000000001AAA';

const surchargePlan = (updates: unknown[]): string =>
  JSON.stringify({
    schemaVersion: 1,
    kind: 'surcharge-update',
    cmlApi: 'SC_AUTO',
    generatedAt: '2026-06-28T12:00:00.000Z',
    updates,
  });

const surchargeUpdate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sobject: 'ProductSurcharge',
  id: SURCHARGE_ID,
  name: 'Collision Fee',
  fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
  ...overrides,
});

const parseFails = (raw: string, match: RegExp): void => {
  let error: Error | undefined;
  try {
    parseRecordUpdatePlan(raw, 'plan.json');
  } catch (e) {
    error = e as Error;
  }
  expect(error, `expected parse to reject: ${raw}`).to.be.an('error');
  expect(error?.message).to.match(match);
  // Every rejection names the offending file so the operator knows what to fix.
  expect(error?.message).to.include('plan.json');
};

describe('record-update-plan parseRecordUpdatePlan', () => {
  it('parses a well-formed surcharge plan, carrying the advisory fields through', () => {
    const plan = parseRecordUpdatePlan(
      surchargePlan([
        surchargeUpdate({ expectedRuleKey: 'SC__auto__collision__fee', productCodes: ['auto', 'collision'] }),
      ]),
      'plan.json'
    );

    expect(plan.kind).to.equal('surcharge-update');
    expect(plan.cmlApi).to.equal('SC_AUTO');
    expect(plan.updates).to.have.length(1);
    expect(plan.updates[0].expectedRuleKey).to.equal('SC__auto__collision__fee');
    expect(plan.updates[0].productCodes).to.deep.equal(['auto', 'collision']);
  });

  it('parses an underwriting plan with both sObject types', () => {
    const plan = parseRecordUpdatePlan(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        generatedAt: '2026-06-28T12:00:00.000Z',
        updates: [
          {
            sobject: 'UnderwritingRuleGroup',
            id: '0RG000000000001AAA',
            name: 'Auto Eligibility Group',
            fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
          },
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            apiName: 'MinDriverAge',
            fields: [{ field: 'DynamicRuleDefinition', value: '{"apiName":"MinDriverAge","ruleKey":"UW_001"}' }],
          },
        ],
      }),
      'plan.json'
    );

    expect(plan.updates.map((u) => u.sobject)).to.deep.equal(['UnderwritingRuleGroup', 'UnderwritingRule']);
    expect(plan.updates[1].apiName).to.equal('MinDriverAge');
  });

  it('accepts an empty updates array (a valid "nothing to do" plan)', () => {
    expect(parseRecordUpdatePlan(surchargePlan([]), 'plan.json').updates).to.deep.equal([]);
  });

  it('rejects a file that is not JSON', () => {
    parseFails('not json at all', /not valid JSON/);
  });

  it('rejects an unsupported schemaVersion', () => {
    parseFails(
      JSON.stringify({ schemaVersion: 2, kind: 'surcharge-update', cmlApi: 'x', updates: [] }),
      /schemaVersion/
    );
  });

  it('rejects an unknown kind, naming the kinds it does support', () => {
    const raw = JSON.stringify({ schemaVersion: 1, kind: 'product-update', cmlApi: 'x', updates: [] });
    parseFails(raw, /unsupported kind/);
    parseFails(raw, /underwriting-update, surcharge-update/);
  });

  it('rejects a non-array updates', () => {
    parseFails(
      JSON.stringify({ schemaVersion: 1, kind: 'surcharge-update', cmlApi: 'x', updates: {} }),
      /must be an array/
    );
  });

  it('rejects an sObject outside the allow-list', () => {
    parseFails(surchargePlan([surchargeUpdate({ sobject: 'Account' })]), /unsupported sobject/);
  });

  it('rejects a mislabelled file whose sobject does not belong to its kind', () => {
    // The command dispatches the post-flip RuleKey readback on `kind` alone, so a surcharge update
    // smuggled into an underwriting-update file would be flipped with zero verification.
    parseFails(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        updates: [surchargeUpdate()],
      }),
      /sobject ProductSurcharge, which a 'underwriting-update' file cannot contain/
    );
    parseFails(
      surchargePlan([
        {
          sobject: 'UnderwritingRuleGroup',
          id: '0RG000000000001AAA',
          name: 'Auto Eligibility Group',
          fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
        },
      ]),
      /which a 'surcharge-update' file cannot contain/
    );
  });

  it('rejects a malformed Salesforce id (an edited file must not reach the org)', () => {
    parseFails(surchargePlan([surchargeUpdate({ id: 'not-an-id' })]), /malformed Salesforce id/);
  });

  it('rejects a missing name, since name is the apply-time identity key', () => {
    parseFails(surchargePlan([surchargeUpdate({ name: '' })]), /missing a non-empty name/);
  });

  it('rejects an empty fields array', () => {
    parseFails(surchargePlan([surchargeUpdate({ fields: [] })]), /at least one field/);
  });

  it('rejects a field that is not allowed for the sObject', () => {
    parseFails(
      surchargePlan([surchargeUpdate({ fields: [{ field: 'Name', value: 'Renamed' }] })]),
      /sets "Name" on ProductSurcharge/
    );
  });

  it('rejects a non-string field value', () => {
    parseFails(
      surchargePlan([surchargeUpdate({ fields: [{ field: 'RuleEngineType', value: 42 }] })]),
      /must have a string value/
    );
  });

  it('rejects duplicate entries for the same field rather than silently keeping the last', () => {
    // Two rows would be previewed with two different target values; only one write would happen.
    parseFails(
      surchargePlan([
        surchargeUpdate({
          fields: [
            { field: 'RuleEngineType', value: 'ConstraintEngine' },
            { field: 'RuleEngineType', value: 'BusinessRuleEngine' },
          ],
        }),
      ]),
      /sets RuleEngineType more than once/
    );
  });

  it('rejects two entries for the same record id, the record-level twin of the duplicate-field check', () => {
    // One record, two entries, conflicting values. Without this check the preview shows the same
    // record and field twice with contradictory operations, the counts report the one record as
    // both an update and an already-current skip, and — when both values need writing — two
    // payloads carrying the same Id go into a single /composite/sobjects PATCH.
    parseFails(
      surchargePlan([
        surchargeUpdate(),
        surchargeUpdate({ fields: [{ field: 'RuleEngineType', value: 'BusinessRuleEngine' }] }),
      ]),
      /repeats record id a0p000000000001/
    );
    // Both offending entries are named, so the operator knows which two rows to reconcile.
    parseFails(surchargePlan([surchargeUpdate(), surchargeUpdate()]), /updates\[1\].*updates\[0\]/);
  });

  it('rejects a repeated id across sObject types, not just within one', () => {
    // A Salesforce id identifies exactly one record of exactly one type, so the same id under two
    // sObjects is a hand-edit gone wrong. Checking per-sObject would let it through, and `applied`
    // counts distinct plan entries — so one record would still be counted twice.
    parseFails(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        updates: [
          {
            sobject: 'UnderwritingRuleGroup',
            id: RULE_ID,
            name: 'Auto Eligibility Group',
            fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
          },
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            fields: [{ field: 'DynamicRuleDefinition', value: '{"ruleKey":"UW_001"}' }],
          },
        ],
      }),
      /repeats record id 0UR000000000001AAA/
    );
  });

  it('rejects a repeat spelled as the 18-character form of the same 15-character id', () => {
    // The 18-character id is the 15-character id plus a case-safety checksum, so these two entries
    // target one record and produce every symptom a byte-identical repeat does. Comparing the raw
    // strings would miss it.
    parseFails(
      surchargePlan([surchargeUpdate(), surchargeUpdate({ id: `${SURCHARGE_ID}AAA` })]),
      /repeats record id a0p000000000001AAA/
    );
  });

  it('accepts distinct record ids in one file', () => {
    // The guard against an over-broad duplicate check: two different records must still parse.
    const plan = parseRecordUpdatePlan(
      surchargePlan([surchargeUpdate(), surchargeUpdate({ id: 'a0p000000000002', name: 'Theft Fee' })]),
      'plan.json'
    );
    expect(plan.updates).to.have.length(2);
  });

  it('rejects an empty field value, which would blank the field in the org', () => {
    parseFails(
      surchargePlan([surchargeUpdate({ fields: [{ field: 'RuleEngineType', value: '' }] })]),
      /has an empty value/
    );
    parseFails(
      surchargePlan([surchargeUpdate({ fields: [{ field: 'RuleEngineType', value: '   ' }] })]),
      /has an empty value/
    );
  });

  it('warns (but does not reject) when a DynamicRuleDefinition value is not parseable JSON', () => {
    const warnings: string[] = [];
    const plan = parseRecordUpdatePlan(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        generatedAt: '',
        updates: [
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            fields: [{ field: 'DynamicRuleDefinition', value: '{broken' }],
          },
        ],
      }),
      'plan.json',
      { onWarn: (m) => warnings.push(m) }
    );

    // The value is still carried through verbatim — a reviewer's hand-correction is honored.
    expect(plan.updates[0].fields[0].value).to.equal('{broken');
    expect(warnings.join('\n')).to.match(/not valid JSON/);
  });
});

describe('record-update-plan isAlreadyCurrent', () => {
  it('compares scalar fields raw', () => {
    expect(isAlreadyCurrent('RuleEngineType', 'ConstraintEngine', 'ConstraintEngine')).to.equal(true);
    expect(isAlreadyCurrent('RuleEngineType', 'BusinessRuleEngine', 'ConstraintEngine')).to.equal(false);
  });

  it('treats a null current value as not current', () => {
    expect(isAlreadyCurrent('RuleEngineType', null, 'ConstraintEngine')).to.equal(false);
  });

  it('compares DynamicRuleDefinition structurally, ignoring key order and whitespace', () => {
    // Same ruleKey + ruleEngineType, re-serialized by the org: a re-run must NOT rewrite it.
    const desired =
      '{"name":"Min Driver Age","ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"}}';
    const orgNormalized =
      '{\n  "underwritingRuleGroup": { "ruleEngineType": "ConstraintEngine" },\n  "ruleKey": "UW_001",\n  "name": "Min Driver Age"\n}';

    expect(isAlreadyCurrent('DynamicRuleDefinition', orgNormalized, desired)).to.equal(true);
  });

  it('does not drop a reviewer’s hand-correction elsewhere in the blob', () => {
    // ruleKey and the nested ruleEngineType already match the org, but the reviewer corrected a
    // threshold. The apply writes the file's blob verbatim, so calling this "already current"
    // silently discards the edit and exits 0 — the exact failure the reviewable file exists to
    // prevent.
    const org =
      '{"ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"},"ruleCriteria":[{"rootObjectId":"01t","conditions":[{"attributeName":"DriverAge","operator":"GreaterThanOrEqual","values":["18"]}]}]}';
    const handCorrected = org.replace('"18"', '"21"');

    expect(isAlreadyCurrent('DynamicRuleDefinition', org, handCorrected)).to.equal(false);
  });

  it('still treats a pure reformat or key reorder as a no-op', () => {
    const desired =
      '{"ruleKey":"UW_001","ruleCriteria":[{"rootObjectId":"01t","values":["18"]}],"underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"}}';
    const orgReserialized =
      '{\n  "underwritingRuleGroup": { "ruleEngineType": "ConstraintEngine" },\n  "ruleCriteria": [ { "values": ["18"], "rootObjectId": "01t" } ],\n  "ruleKey": "UW_001"\n}';

    expect(isAlreadyCurrent('DynamicRuleDefinition', orgReserialized, desired)).to.equal(true);
  });

  it('treats a reordered array as a real change, since array order is meaningful', () => {
    expect(
      isAlreadyCurrent('DynamicRuleDefinition', '{"ruleCriteria":["a","b"]}', '{"ruleCriteria":["b","a"]}')
    ).to.equal(false);
  });

  it('detects a field the file adds or removes relative to the org blob', () => {
    expect(
      isAlreadyCurrent('DynamicRuleDefinition', '{"ruleKey":"UW_001"}', '{"ruleKey":"UW_001","status":"Active"}')
    ).to.equal(false);
    expect(
      isAlreadyCurrent('DynamicRuleDefinition', '{"ruleKey":"UW_001","status":"Active"}', '{"ruleKey":"UW_001"}')
    ).to.equal(false);
  });

  it('detects a DynamicRuleDefinition whose ruleKey differs', () => {
    expect(isAlreadyCurrent('DynamicRuleDefinition', '{"ruleKey":"OLD_KEY"}', '{"ruleKey":"UW_001"}')).to.equal(false);
  });

  it('detects a DynamicRuleDefinition whose nested ruleEngineType has not been flipped', () => {
    expect(
      isAlreadyCurrent(
        'DynamicRuleDefinition',
        '{"ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"BusinessRuleEngine"}}',
        '{"ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"}}'
      )
    ).to.equal(false);
  });

  it('falls back to a raw compare when either blob is unparseable', () => {
    expect(isAlreadyCurrent('DynamicRuleDefinition', '{broken', '{broken')).to.equal(true);
    expect(isAlreadyCurrent('DynamicRuleDefinition', '{broken', '{"ruleKey":"UW_001"}')).to.equal(false);
  });
});

describe('record-update-plan blob helpers', () => {
  it('extracts the mutated subset of a blob', () => {
    expect(
      dynamicRuleDefinitionSignature(
        '{"ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"}}'
      )
    ).to.deep.equal({ ruleKey: 'UW_001', ruleEngineType: 'ConstraintEngine' });
  });

  it('reports an absent underwritingRuleGroup as undefined rather than synthesizing one', () => {
    expect(dynamicRuleDefinitionSignature('{"ruleKey":"UW_001"}')).to.deep.equal({
      ruleKey: 'UW_001',
      ruleEngineType: undefined,
    });
  });

  it('returns undefined for an unparseable blob', () => {
    expect(dynamicRuleDefinitionSignature('{broken')).to.equal(undefined);
  });

  it('reads apiName out of a blob for the identity check, distinguishing why it could not', () => {
    expect(dynamicRuleDefinitionApiName('{"apiName":"MinDriverAge"}')).to.deep.equal({ apiName: 'MinDriverAge' });
    // 'absent' (the blob has no apiName) must stay distinguishable from 'unparseable' (the guard
    // could not run at all) — collapsing both to undefined is what let the guard fail open.
    expect(dynamicRuleDefinitionApiName('{"ruleKey":"UW_001"}')).to.deep.equal({ failure: 'absent' });
    expect(dynamicRuleDefinitionApiName('{broken')).to.deep.equal({ failure: 'unparseable' });
    expect(dynamicRuleDefinitionApiName(null)).to.deep.equal({ failure: 'absent' });
  });

  it('reads an HTML-entity-encoded blob, which is how the org stores these fields', () => {
    expect(dynamicRuleDefinitionApiName('{&quot;apiName&quot;:&quot;MinDriverAge&quot;}')).to.deep.equal({
      apiName: 'MinDriverAge',
    });
    expect(dynamicRuleDefinitionSignature('{&quot;ruleKey&quot;:&quot;UW_001&quot;}')).to.deep.equal({
      ruleKey: 'UW_001',
      ruleEngineType: undefined,
    });
  });

  it('does not entity-decode a blob that is already valid JSON', () => {
    // An `&amp;` inside a string value is data, not encoding: decoding a blob that parses cleanly
    // would silently rewrite the operator's content.
    expect(dynamicRuleDefinitionApiName('{"apiName":"A &amp; B"}')).to.deep.equal({ apiName: 'A &amp; B' });
  });
});
