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
import { RecordUpdate, RecordUpdatePlan } from '../../../src/shared/insurance/models.js';
import {
  IdentityProblem,
  PlannedRecordChange,
  applyRecordUpdates,
  planRecordUpdates,
  verifySurchargeUpdates,
} from '../../../src/shared/insurance/record-update-apply.js';

const SURCHARGE_ID = 'a0p000000000001';
const GROUP_ID = '0RG000000000001AAA';
const RULE_ID = '0UR000000000001AAA';
const PRODUCT_ROOT = '01tROOT00000000001';
const PRODUCT_LEAF = '01tCOLL00000000001';

type UpdateCall = { sobject: string; payloads: Array<Record<string, string>> };

type MockOpts = {
  /** Keyed by SOQL substring match; the first matching entry wins. */
  query?: (soql: string) => unknown[];
  /** Per-record save results, in payload order. Defaults to all-success. */
  saveResults?: (sobject: string, payloads: Array<Record<string, string>>) => unknown[];
  /** When set, `update` rejects with this error instead of returning results. */
  updateThrows?: Error;
};

/** Records every write so tests can assert that read-only paths issue none. */
function mockConnection(opts: MockOpts, calls: UpdateCall[] = []): Connection {
  return {
    query: (soql: string) => Promise.resolve({ records: opts.query ? opts.query(soql) : [] }),
    sobject: (sobject: string) => ({
      update: (payloads: Array<Record<string, string>>) => {
        calls.push({ sobject, payloads });
        if (opts.updateThrows) return Promise.reject(opts.updateThrows);
        return Promise.resolve(
          opts.saveResults?.(sobject, payloads) ?? payloads.map(() => ({ success: true, errors: [] }))
        );
      },
    }),
  } as unknown as Connection;
}

const surchargeUpdate = (overrides: Partial<RecordUpdate> = {}): RecordUpdate => ({
  sobject: 'ProductSurcharge',
  id: SURCHARGE_ID,
  name: 'Collision Fee',
  fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
  ...overrides,
});

const underwritingRuleUpdate = (overrides: Partial<RecordUpdate> = {}): RecordUpdate => ({
  sobject: 'UnderwritingRule',
  id: RULE_ID,
  name: 'Min Driver Age',
  apiName: 'MinDriverAge',
  fields: [{ field: 'DynamicRuleDefinition', value: '{"apiName":"MinDriverAge","ruleKey":"UW_001"}' }],
  ...overrides,
});

/** A distinct, well-formed 15-char ProductSurcharge id for volume tests. */
const surchargeId = (i: number): string => `a0p${String(i).padStart(12, '0')}`;

const bigSurchargeChanges = (count: number): PlannedRecordChange[] =>
  Array.from({ length: count }, (_, i) => ({
    update: surchargeUpdate({ id: surchargeId(i), name: `Surcharge ${i}` }),
    field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
    currentValue: 'BusinessRuleEngine',
    alreadyCurrent: false,
  }));

/** The problem messages, joined for matching. Each problem also carries the kind it belongs to. */
const messagesOf = (problems: IdentityProblem[]): string => problems.map((p) => p.message).join('\n');

const planOf = (updates: RecordUpdate[], kind: RecordUpdatePlan['kind'] = 'surcharge-update'): RecordUpdatePlan => ({
  schemaVersion: 1,
  kind,
  cmlApi: 'SC_AUTO',
  generatedAt: '2026-06-28T12:00:00.000Z',
  updates,
});

describe('record-update-apply planRecordUpdates', () => {
  it('joins each update to the org’s current value without issuing any write', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection(
      {
        query: () => [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
      calls
    );

    const { changes, identityErrors, advisories } = await planRecordUpdates(conn, planOf([surchargeUpdate()]));

    expect(identityErrors).to.deep.equal([]);
    expect(advisories).to.deep.equal([]);
    expect(changes).to.have.length(1);
    expect(changes[0].currentValue).to.equal('BusinessRuleEngine');
    expect(changes[0].alreadyCurrent).to.equal(false);
    // The read phase must be strictly read-only — it runs before the confirmation prompt.
    expect(calls).to.deep.equal([]);
  });

  it('marks a record whose org value already matches as already-current', async () => {
    const conn = mockConnection({
      query: () => [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'ConstraintEngine' }],
    });

    const { changes } = await planRecordUpdates(conn, planOf([surchargeUpdate()]));

    expect(changes[0].alreadyCurrent).to.equal(true);
  });

  it('reports an identity error when the org Name disagrees with the file', async () => {
    const conn = mockConnection({
      query: () => [{ Id: SURCHARGE_ID, Name: 'Some Other Surcharge', RuleEngineType: 'BusinessRuleEngine' }],
    });

    const { changes, identityErrors } = await planRecordUpdates(conn, planOf([surchargeUpdate()]));

    expect(changes).to.deep.equal([]);
    expect(messagesOf(identityErrors)).to.match(
      /is named 'Some Other Surcharge' in the org but the file expected 'Collision Fee'/
    );
    // A Name disagreement is a genuine identity mismatch, so it keeps the mismatch remediation.
    expect(identityErrors.map((e) => e.kind)).to.deep.equal(['recordIdentityMismatch']);
  });

  it('reports an identity error when the record no longer exists', async () => {
    const conn = mockConnection({ query: () => [] });

    const { identityErrors } = await planRecordUpdates(conn, planOf([surchargeUpdate()]));

    expect(messagesOf(identityErrors)).to.match(/was not found in the org/);
  });

  it('reports an identity error when an underwriting rule’s blob apiName disagrees with the file', async () => {
    const conn = mockConnection({
      query: () => [
        {
          Id: RULE_ID,
          Name: 'Min Driver Age',
          DynamicRuleDefinition: '{"apiName":"SomeOtherRule"}',
        },
      ],
    });

    const { identityErrors } = await planRecordUpdates(
      conn,
      planOf(
        [
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            apiName: 'MinDriverAge',
            fields: [{ field: 'DynamicRuleDefinition', value: '{"apiName":"MinDriverAge","ruleKey":"UW_001"}' }],
          },
        ],
        'underwriting-update'
      )
    );

    expect(messagesOf(identityErrors)).to.match(
      /has apiName 'SomeOtherRule' in the org but the file expected 'MinDriverAge'/
    );
  });

  it('catches an apiName mismatch even when the org stored the blob HTML-entity-encoded', async () => {
    const conn = mockConnection({
      query: () => [
        {
          Id: RULE_ID,
          Name: 'Min Driver Age',
          DynamicRuleDefinition: '{&quot;apiName&quot;:&quot;SomeOtherRule&quot;}',
        },
      ],
    });

    const { identityErrors } = await planRecordUpdates(conn, planOf([underwritingRuleUpdate()], 'underwriting-update'));

    expect(messagesOf(identityErrors)).to.match(
      /has apiName 'SomeOtherRule' in the org but the file expected 'MinDriverAge'/
    );
  });

  it('refuses to write when the org blob cannot be parsed, rather than passing the guard', async () => {
    const conn = mockConnection({
      query: () => [{ Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: 'not json at all' }],
    });

    const { identityErrors, changes } = await planRecordUpdates(
      conn,
      planOf([underwritingRuleUpdate()], 'underwriting-update')
    );

    expect(messagesOf(identityErrors)).to.match(/not readable JSON, so the apiName identity check could not run/);
    // The kind is what routes this to remediation an operator can follow. Reported as a mismatch it
    // would be sent to "correct the mismatched record ids", and there is no mismatched id here —
    // the blob is broken in the org, where regenerating the file cannot reach it.
    expect(identityErrors.map((e) => e.kind)).to.deep.equal(['unreadableOrgBlob']);
    expect(changes, 'a guard that cannot run must block, not wave the record through').to.deep.equal([]);
  });

  it('refuses to write when the re-read did not return the blob field at all', async () => {
    // The shape a SELECT-list regression produces: Name resolves, the blob simply is not there.
    const conn = mockConnection({ query: () => [{ Id: RULE_ID, Name: 'Min Driver Age' }] });

    const { identityErrors, changes } = await planRecordUpdates(
      conn,
      planOf([underwritingRuleUpdate()], 'underwriting-update')
    );

    expect(messagesOf(identityErrors)).to.match(/did not return DynamicRuleDefinition/);
    // A plugin defect, not a file defect: nothing the operator can edit changes the SELECT list.
    expect(identityErrors.map((e) => e.kind)).to.deep.equal(['identityCheckUnavailable']);
    expect(changes).to.deep.equal([]);
  });

  it('proceeds with an advisory when the org blob is readable but carries no apiName', async () => {
    const conn = mockConnection({
      query: () => [{ Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: '{"ruleKey":"OLD"}' }],
    });

    const { identityErrors, advisories, changes } = await planRecordUpdates(
      conn,
      planOf([underwritingRuleUpdate()], 'underwriting-update')
    );

    expect(identityErrors).to.deep.equal([]);
    expect(advisories.join('\n')).to.match(/carries no apiName, so only the record Name could be verified/);
    expect(changes).to.have.length(1);
  });

  it('recognizes an HTML-entity-encoded org blob as already current, instead of rewriting it every run', async () => {
    const desired = '{"apiName":"MinDriverAge","ruleKey":"UW_001"}';
    const conn = mockConnection({
      query: () => [
        {
          Id: RULE_ID,
          Name: 'Min Driver Age',
          DynamicRuleDefinition:
            '{&quot;apiName&quot;:&quot;MinDriverAge&quot;,&quot;ruleKey&quot;:&quot;UW_001&quot;}',
        },
      ],
    });

    const { changes, identityErrors } = await planRecordUpdates(
      conn,
      planOf(
        [underwritingRuleUpdate({ fields: [{ field: 'DynamicRuleDefinition', value: desired }] })],
        'underwriting-update'
      )
    );

    expect(identityErrors).to.deep.equal([]);
    expect(changes[0].alreadyCurrent, 'an encoded blob must not force a rewrite on every run').to.equal(true);
  });

  it('flags ProductCode drift as an advisory, never as a blocking error', async () => {
    const conn = mockConnection({
      query: (soql) => {
        if (soql.includes('FROM Product2')) {
          return [
            { Id: PRODUCT_ROOT, ProductCode: 'autoGold', Name: 'Auto Gold' },
            { Id: PRODUCT_LEAF, ProductCode: 'collision', Name: 'Collision' },
          ];
        }
        return [
          {
            Id: SURCHARGE_ID,
            Name: 'Collision Fee',
            RuleEngineType: 'BusinessRuleEngine',
            ProductPath: `${PRODUCT_ROOT}/${PRODUCT_LEAF}`,
          },
        ];
      },
    });

    const { identityErrors, advisories, changes } = await planRecordUpdates(
      conn,
      // Convert saw 'autoSilver' at T0; the org now resolves 'autoGold'.
      planOf([surchargeUpdate({ productCodes: ['autoSilver', 'collision'] })])
    );

    expect(identityErrors).to.deep.equal([]);
    expect(changes).to.have.length(1);
    expect(advisories.join('\n')).to.match(/ProductCodes drifted since convert/);
    expect(advisories.join('\n')).to.include('autoSilver/collision');
    expect(advisories.join('\n')).to.include('autoGold/collision');
  });

  it('says so when a ProductCode had to be derived from Name, since the drift check then means little', async () => {
    const conn = mockConnection({
      query: (soql) =>
        soql.includes('FROM Product2')
          ? [
              { Id: PRODUCT_ROOT, ProductCode: null, Name: 'autoSilver' },
              { Id: PRODUCT_LEAF, ProductCode: 'collision', Name: 'Collision' },
            ]
          : [
              {
                Id: SURCHARGE_ID,
                Name: 'Collision Fee',
                RuleEngineType: 'BusinessRuleEngine',
                ProductPath: `${PRODUCT_ROOT}/${PRODUCT_LEAF}`,
              },
            ],
    });

    const { advisories } = await planRecordUpdates(
      conn,
      // The Name fallback happens to equal the file's code, so the drift check stays silent —
      // and would say nothing at all about a key that cannot match the platform's.
      planOf([surchargeUpdate({ productCodes: ['autoSilver', 'collision'] })])
    );

    expect(advisories.join('\n')).to.match(new RegExp(`products ${PRODUCT_ROOT} have no ProductCode`));
    expect(advisories.join('\n')).to.match(/cannot be relied on/);
  });

  it('raises no advisory when the org ProductCodes still match the file', async () => {
    const conn = mockConnection({
      query: (soql) =>
        soql.includes('FROM Product2')
          ? [
              { Id: PRODUCT_ROOT, ProductCode: 'autoSilver', Name: 'Auto Silver' },
              { Id: PRODUCT_LEAF, ProductCode: 'collision', Name: 'Collision' },
            ]
          : [
              {
                Id: SURCHARGE_ID,
                Name: 'Collision Fee',
                RuleEngineType: 'BusinessRuleEngine',
                ProductPath: `${PRODUCT_ROOT}/${PRODUCT_LEAF}`,
              },
            ],
    });

    const { advisories } = await planRecordUpdates(
      conn,
      planOf([surchargeUpdate({ productCodes: ['autoSilver', 'collision'] })])
    );

    expect(advisories).to.deep.equal([]);
  });

  it('chunks the re-read so a large plan stays inside the SOQL statement limit', async () => {
    const soqls: string[] = [];
    const conn = mockConnection({
      query: (soql) => {
        soqls.push(soql);
        // Only answer for the ids this particular query actually asked about.
        return [...soql.matchAll(/'([a-zA-Z0-9]{15,18})'/g)].map((m) => ({
          Id: m[1],
          Name: `Surcharge ${Number(m[1].slice(3))}`,
          RuleEngineType: 'BusinessRuleEngine',
        }));
      },
    });
    const updates = Array.from({ length: 1200 }, (_, i) =>
      surchargeUpdate({ id: surchargeId(i), name: `Surcharge ${i}` })
    );

    const { changes, identityErrors } = await planRecordUpdates(conn, planOf(updates));

    expect(soqls).to.have.length(3);
    // Every record must still be resolved — chunking must not drop the tail of the plan.
    expect(identityErrors).to.deep.equal([]);
    expect(changes).to.have.length(1200);
  });

  it('only interpolates well-formed ids into the re-read SOQL', async () => {
    const soqls: string[] = [];
    const conn = mockConnection({
      query: (soql) => {
        soqls.push(soql);
        return [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }];
      },
    });

    await planRecordUpdates(conn, planOf([surchargeUpdate()]));

    expect(soqls[0]).to.include(`WHERE Id IN ('${SURCHARGE_ID}')`);
    expect(soqls[0]).to.not.include('Collision Fee');
  });
});

describe('record-update-apply applyRecordUpdates', () => {
  it('writes only the fields that are not already current', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection({}, calls);

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
      {
        update: surchargeUpdate({ id: 'a0p000000000002', name: 'Theft Fee' }),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'ConstraintEngine',
        alreadyCurrent: true,
      },
    ]);

    expect(result.applied).to.equal(1);
    expect(result.failures).to.deep.equal([]);
    expect(calls).to.have.length(1);
    expect(calls[0].payloads).to.deep.equal([{ Id: SURCHARGE_ID, RuleEngineType: 'ConstraintEngine' }]);
  });

  it('issues no write at all when every change is already current', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection({}, calls);

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'ConstraintEngine',
        alreadyCurrent: true,
      },
    ]);

    expect(result.applied).to.equal(0);
    expect(calls).to.deep.equal([]);
  });

  it('updates UnderwritingRuleGroup before UnderwritingRule', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection({}, calls);

    await applyRecordUpdates(conn, [
      // Deliberately supplied rule-first; the apply must still order group-first.
      {
        update: {
          sobject: 'UnderwritingRule',
          id: RULE_ID,
          name: 'Min Driver Age',
          fields: [{ field: 'DynamicRuleDefinition', value: '{"ruleKey":"UW_001"}' }],
        },
        field: { field: 'DynamicRuleDefinition', value: '{"ruleKey":"UW_001"}' },
        currentValue: '{"ruleKey":null}',
        alreadyCurrent: false,
      },
      {
        update: {
          sobject: 'UnderwritingRuleGroup',
          id: GROUP_ID,
          name: 'Auto Eligibility Group',
          fields: [{ field: 'RuleEngineType', value: 'ConstraintEngine' }],
        },
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
    ]);

    expect(calls.map((c) => c.sobject)).to.deep.equal(['UnderwritingRuleGroup', 'UnderwritingRule']);
  });

  it('collects per-record failures instead of aborting the batch', async () => {
    const conn = mockConnection({
      saveResults: () => [
        { success: true, errors: [] },
        { success: false, errors: [{ message: 'INSUFFICIENT_ACCESS' }] },
      ],
    });

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
      {
        update: surchargeUpdate({ id: 'a0p000000000002', name: 'Theft Fee' }),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
    ]);

    expect(result.applied).to.equal(1);
    expect(result.failures).to.deep.equal([
      { id: 'a0p000000000002', name: 'Theft Fee', errors: ['INSUFFICIENT_ACCESS'], outcomeUnknown: false },
    ]);
  });

  it('chunks the write at 200 records, so a large plan is not rejected wholesale', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection({}, calls);
    const changes = bigSurchargeChanges(250);

    const result = await applyRecordUpdates(conn, changes);

    // Salesforce rejects a single /composite/sobjects PATCH above 200, and jsforce does not split
    // it for us: unchunked, all 250 go in one request and every record is reported as failed.
    expect(calls.map((c) => c.payloads.length)).to.deep.equal([200, 50]);
    expect(result.applied).to.equal(250);
    expect(result.failures).to.deep.equal([]);
    // Every record is written exactly once, in plan order.
    expect(calls.flatMap((c) => c.payloads.map((p) => p.Id))).to.deep.equal(changes.map((c) => c.update.id));
  });

  it('keeps an earlier successful chunk when a later chunk is rejected outright', async () => {
    const calls: UpdateCall[] = [];
    const conn = mockConnection(
      {
        saveResults: (_sobject, payloads) => {
          if (calls.length === 2) throw new Error('Request timed out');
          return payloads.map(() => ({ success: true, errors: [] }));
        },
      },
      calls
    );

    const result = await applyRecordUpdates(conn, bigSurchargeChanges(250));

    expect(result.applied, 'the first chunk really was written').to.equal(200);
    expect(result.failures).to.have.length(50);
    expect(result.failures[0].id).to.equal(surchargeId(200));
  });

  it('attributes a thrown request error to every record in the batch, as an unknown outcome', async () => {
    const conn = mockConnection({ updateThrows: new Error('expired access token') });

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
    ]);

    expect(result.applied).to.equal(0);
    expect(result.failures[0].errors).to.deep.equal(['expired access token']);
    // A timeout or a 500 can arrive after the server committed, so "it was not written" is a
    // claim this code cannot make.
    expect(result.failures[0].outcomeUnknown).to.equal(true);
  });

  it('marks a rejected record as a known failure, not an unknown outcome', async () => {
    const conn = mockConnection({
      saveResults: () => [{ success: false, errors: [{ message: 'FIELD_INTEGRITY_EXCEPTION' }] }],
    });

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
    ]);

    expect(result.failures).to.deep.equal([
      { id: SURCHARGE_ID, name: 'Collision Fee', errors: ['FIELD_INTEGRITY_EXCEPTION'], outcomeUnknown: false },
    ]);
  });

  it('normalizes the bare result a single-record update returns', async () => {
    // jsforce returns the object itself, not a one-element array, for a single record.
    const conn = mockConnection({ saveResults: () => ({ success: true, errors: [] } as unknown as unknown[]) });

    const result = await applyRecordUpdates(conn, [
      {
        update: surchargeUpdate(),
        field: { field: 'RuleEngineType', value: 'ConstraintEngine' },
        currentValue: 'BusinessRuleEngine',
        alreadyCurrent: false,
      },
    ]);

    expect(result.applied).to.equal(1);
    expect(result.failures).to.deep.equal([]);
  });

  it('does not throw when the org returns more results than records were sent', async () => {
    const conn = mockConnection({
      saveResults: () => [
        { success: true, errors: [] },
        { success: true, errors: [] },
        { success: false, errors: [{ message: 'PHANTOM' }] },
      ],
    });

    // Indexing the results array reads updates[2] and throws a TypeError — after the writes had
    // already landed, which is the one moment the operator most needs the report.
    const result = await applyRecordUpdates(conn, bigSurchargeChanges(2));

    expect(result.applied, 'a phantom third result must not inflate the applied count').to.equal(2);
    expect(result.failures).to.deep.equal([]);
  });

  it('reports an unknown outcome for a record the org returned no result for', async () => {
    const conn = mockConnection({ saveResults: () => [{ success: true, errors: [] }] });

    const result = await applyRecordUpdates(conn, bigSurchargeChanges(3));

    expect(result.applied, 'a missing result must not be silently counted as applied').to.equal(1);
    expect(result.failures.map((f) => f.id)).to.deep.equal([surchargeId(1), surchargeId(2)]);
    expect(result.failures.every((f) => f.outcomeUnknown)).to.equal(true);
    expect(result.failures[0].errors.join()).to.match(/no result for this record/);
  });
});

describe('record-update-apply verifySurchargeUpdates', () => {
  it('reads back the platform-regenerated RuleKey and warns when it does not match', async () => {
    const soqls: string[] = [];
    const conn = mockConnection({
      query: (soql) => {
        soqls.push(soql);
        return [
          {
            Id: SURCHARGE_ID,
            Name: 'Collision Fee',
            RuleEngineType: 'ConstraintEngine',
            RuleKey: 'SC__autoGold__collision__fee',
            RuleApiName: 'CollisionFee',
          },
        ];
      },
    });

    const { records, warnings } = await verifySurchargeUpdates(conn, [
      surchargeUpdate({ expectedRuleKey: 'SC__autoSilver__collision__fee' }),
    ]);

    expect(soqls[0]).to.equal(
      `SELECT Id, Name, RuleEngineType, RuleKey, RuleApiName FROM ProductSurcharge WHERE Id IN ('${SURCHARGE_ID}')`
    );
    expect(records).to.have.length(1);
    expect(warnings.join('\n')).to.match(/does not match the converted CML rule key/);
    expect(warnings.join('\n')).to.match(/will not fire/);
  });

  it('stays quiet when the regenerated RuleKey matches the converted key', async () => {
    const conn = mockConnection({
      query: () => [
        {
          Id: SURCHARGE_ID,
          Name: 'Collision Fee',
          RuleEngineType: 'ConstraintEngine',
          RuleKey: 'SC__autoSilver__collision__fee',
          RuleApiName: 'CollisionFee',
        },
      ],
    });

    const { warnings } = await verifySurchargeUpdates(conn, [
      surchargeUpdate({ expectedRuleKey: 'SC__autoSilver__collision__fee' }),
    ]);

    expect(warnings).to.deep.equal([]);
  });
});
