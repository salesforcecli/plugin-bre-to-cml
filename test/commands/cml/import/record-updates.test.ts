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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import { expect } from 'chai';
import { stubPrompter, stubSfCommandUx } from '@salesforce/sf-plugins-core';
import CmlImportRecordUpdates, {
  type CmlImportRecordUpdatesResult,
} from '../../../../src/commands/cml/import/record-updates.js';

const SURCHARGE_ID = 'a0p000000000001';
const SURCHARGE_ID_2 = 'a0p000000000002';
const GROUP_ID = '0RG000000000001AAA';
const RULE_ID = '0UR000000000001AAA';

type OrgRecord = Record<string, unknown>;
type UpdateCall = { sobject: string; payloads: Array<Record<string, string>> };

type MockOpts = {
  /** Records returned by the pre-apply re-read, keyed by sObject. */
  current?: Record<string, OrgRecord[]>;
  /** Records returned by the post-apply surcharge verification query. */
  verification?: OrgRecord[];
  /** Per-record save results, in payload order. Defaults to all-success. */
  saveResults?: (sobject: string, payloads: Array<Record<string, string>>) => unknown[];
};

const surchargePlanFile = (updates: unknown[]): string =>
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

describe('cml import record-updates', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let workspaceDir: string;
  let planFile: string;
  let updateCalls: UpdateCall[];
  let ttyRestores: Array<() => void>;
  /** Whether the preview had been rendered by the time the first write was issued. */
  let renderedBeforeFirstWrite: boolean | undefined;
  /** Every SOQL statement the command issued, so tests can assert what it actually asked for. */
  let soqls: string[];
  /** The statements the command itself issued, minus the auth layer's Organization lookup. */
  const planSoqls = (): string[] => soqls.filter((s) => !s.includes('FROM Organization'));

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'record-updates-test-'));
    planFile = path.join(workspaceDir, 'SC_AUTO_SurchargeUpdate.json');
    updateCalls = [];
    ttyRestores = [];
    renderedBeforeFirstWrite = undefined;
    soqls = [];
  });

  afterEach(async () => {
    $$.restore();
    for (const restore of ttyRestores) restore();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  /**
   * Routes the two things the command touches — the re-read/verification queries and the record
   * writes — to in-memory fakes. No live org, no network. Every write is recorded in `updateCalls`
   * so read-only paths (`--dry-run`, already-current) can assert that none happened.
   */
  const stubOrgConnection = (opts: MockOpts): void => {
    $$.SANDBOX.stub(Connection.prototype, 'getApiVersion').returns('68.0');
    $$.SANDBOX.stub(Connection.prototype, 'query').callsFake(((soql: string) => {
      soqls.push(soql);
      // Honour the WHERE clause. A fixture that answers regardless of which ids were asked for
      // cannot tell a correct re-read from one that queried the wrong records, or none.
      const requestedIds = new Set([...soql.matchAll(/'([a-zA-Z0-9]{15,18})'/g)].map((m) => m[1]));
      const matching = (records: OrgRecord[]): OrgRecord[] =>
        records.filter((r) => requestedIds.has(String(r.Id ?? '')));

      // The post-apply verification is the only query that selects RuleKey.
      if (soql.includes('RuleKey')) return Promise.resolve({ records: matching(opts.verification ?? []) });
      const sobject = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return Promise.resolve({ records: matching(opts.current?.[sobject] ?? []) });
    }) as never);
    $$.SANDBOX.stub(Connection.prototype, 'sobject').callsFake(
      (sobject: string) =>
        ({
          update: (payloads: Array<Record<string, string>>) => {
            // Snapshot the preview state at the moment of the write, so a test can prove the
            // operator saw the plan before anything was sent — not merely that both happened.
            renderedBeforeFirstWrite ??= sfCommandStubs.table.called && sfCommandStubs.styledHeader.called;
            updateCalls.push({ sobject, payloads });
            return Promise.resolve(
              opts.saveResults?.(sobject, payloads) ?? payloads.map(() => ({ success: true, errors: [] }))
            );
          },
        } as unknown as ReturnType<Connection['sobject']>)
    );
  };

  const writePlan = async (contents: string): Promise<void> => {
    await fs.writeFile(planFile, contents, 'utf8');
  };

  const runCommand = async (extraArgs: string[] = []): Promise<CmlImportRecordUpdatesResult> =>
    CmlImportRecordUpdates.run(['--file', planFile, '--target-org', testOrg.username, ...extraArgs]);

  const runExpectingError = async (extraArgs: string[] = []): Promise<Error> => {
    let error: Error | undefined;
    try {
      await runCommand(extraArgs);
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'command should have rejected').to.be.an('error');
    return error as Error;
  };

  const logOutput = (): string =>
    sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  const warnOutput = (): string =>
    sfCommandStubs.warn
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  /**
   * Makes the run look interactive so the command actually reaches `SfCommand.confirm`. Without
   * both TTY flags the gate short-circuits into the non-interactive fail-fast branch and the
   * prompt — the only thing standing between an operator and an unwanted write — never runs.
   */
  const stubInteractiveTerminal = (answer: boolean): ReturnType<typeof stubPrompter> => {
    // `isTTY` is absent (not false) on a non-TTY stream, so sinon cannot stub it.
    for (const stream of [process.stdout, process.stdin] as Array<{ isTTY?: boolean }>) {
      const had = 'isTTY' in stream;
      const previous = stream.isTTY;
      stream.isTTY = true;
      ttyRestores.push(() => {
        if (had) stream.isTTY = previous;
        else delete stream.isTTY;
      });
    }
    const prompter = stubPrompter($$.SANDBOX);
    prompter.confirm.resolves(answer);
    return prompter;
  };

  it('applies a surcharge flip and reports the verified RuleKey', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
      verification: [
        {
          Id: SURCHARGE_ID,
          Name: 'Collision Fee',
          RuleEngineType: 'ConstraintEngine',
          RuleKey: 'SC__auto__collision__fee',
          RuleApiName: 'CollisionFee',
        },
      ],
    });
    await writePlan(surchargePlanFile([surchargeUpdate({ expectedRuleKey: 'SC__auto__collision__fee' })]));

    const result = await runCommand(['--no-prompt']);

    expect(result.applied).to.equal(1);
    expect(result.skipped).to.deep.equal([]);
    expect(result.failed).to.deep.equal([]);
    expect(result.kind).to.equal('surcharge-update');
    expect(updateCalls).to.deep.equal([
      { sobject: 'ProductSurcharge', payloads: [{ Id: SURCHARGE_ID, RuleEngineType: 'ConstraintEngine' }] },
    ]);
    expect(logOutput()).to.include('Records: 1 updated, 0 skipped (already current), 0 failed.');
    // The platform-regenerated RuleKey is echoed so the operator can confirm the rule will fire.
    expect(logOutput()).to.include('RuleKey=SC__auto__collision__fee');
    expect(warnOutput()).to.not.match(/will not fire/);
  });

  it('applies an underwriting plan, writing the group before the rule', async () => {
    stubOrgConnection({
      current: {
        UnderwritingRuleGroup: [{ Id: GROUP_ID, Name: 'Auto Eligibility Group', RuleEngineType: 'BusinessRuleEngine' }],
        UnderwritingRule: [
          { Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: '{"apiName":"MinDriverAge"}' },
        ],
      },
    });
    await writePlan(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        generatedAt: '2026-06-28T12:00:00.000Z',
        updates: [
          {
            sobject: 'UnderwritingRuleGroup',
            id: GROUP_ID,
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
      })
    );

    const result = await runCommand(['--no-prompt']);

    expect(result.applied).to.equal(2);
    expect(updateCalls.map((c) => c.sobject)).to.deep.equal(['UnderwritingRuleGroup', 'UnderwritingRule']);
    expect(updateCalls[1].payloads[0].DynamicRuleDefinition).to.equal('{"apiName":"MinDriverAge","ruleKey":"UW_001"}');
  });

  it('renders the preview table, both warnings, and all of it before the write', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [
          { Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' },
          { Id: SURCHARGE_ID_2, Name: 'Theft Fee', RuleEngineType: 'ConstraintEngine' },
        ],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate(), surchargeUpdate({ id: SURCHARGE_ID_2, name: 'Theft Fee' })]));

    await runCommand(['--no-prompt']);

    expect(sfCommandStubs.styledHeader.getCall(0).args[0]).to.equal(
      `These changes will be applied to ${testOrg.username}`
    );
    // The operator's only view of what is about to happen: pin the rows, not just the call.
    const rows = (sfCommandStubs.table.getCall(0).args[0] as { data: Array<Record<string, unknown>> }).data;
    expect(rows).to.deep.equal([
      {
        Operation: 'Update',
        Object: 'ProductSurcharge',
        Id: SURCHARGE_ID,
        Name: 'Collision Fee',
        Field: 'RuleEngineType',
        Change: 'BusinessRuleEngine → ConstraintEngine',
      },
      {
        Operation: 'Skip (already current)',
        Object: 'ProductSurcharge',
        Id: SURCHARGE_ID_2,
        Name: 'Theft Fee',
        Field: 'RuleEngineType',
        Change: 'ConstraintEngine (unchanged)',
      },
    ]);
    expect(warnOutput()).to.include(`1 to update, 1 already current (will be skipped) in org ${testOrg.username}.`);
    // The non-transactional notice must reach the operator before they can consent, not after.
    expect(warnOutput()).to.include('are NOT rolled back');
    expect(sfCommandStubs.table.calledBefore(sfCommandStubs.warn), 'table renders before the warnings').to.equal(true);
    expect(sfCommandStubs.styledHeader.calledBefore(sfCommandStubs.table)).to.equal(true);
    expect(renderedBeforeFirstWrite, 'the preview must be rendered before the first write').to.equal(true);
  });

  it('summarizes the plan without contradicting itself about what is already current', async () => {
    // 3 still to write, 2 already applied — the shape a partially re-run migration produces. The
    // old sentence read "0 to create, 3 to update, 0 already current (reused), 2 to skip in org
    // ...": it told the operator nothing was already current and then, in the same breath, that 2
    // records would be skipped *because* they were. This is the last line read before authorizing
    // writes to a live org.
    const ids = ['a0p000000000001', 'a0p000000000002', 'a0p000000000003', 'a0p000000000004', 'a0p000000000005'];
    stubOrgConnection({
      current: {
        ProductSurcharge: ids.map((id, i) => ({
          Id: id,
          Name: `Fee ${i}`,
          RuleEngineType: i < 3 ? 'BusinessRuleEngine' : 'ConstraintEngine',
        })),
      },
    });
    await writePlan(surchargePlanFile(ids.map((id, i) => surchargeUpdate({ id, name: `Fee ${i}` }))));

    const result = await runCommand(['--dry-run']);

    const summary = warnOutput()
      .split('\n')
      .find((line) => line.includes('to update'));
    expect(summary).to.equal(`3 to update, 2 already current (will be skipped) in org ${testOrg.username}.`);
    // The contradiction itself: never claim zero already-current while also announcing skips.
    expect(summary, 'must not report 0 already current alongside a non-zero skip count').to.not.match(
      /\b0 already current\b/
    );
    // Every planned row must be accounted for by the numbers the operator was shown. A bucket the
    // sentence omits is a row that has silently vanished from the decision surface.
    const buckets = /^(\d+) to update, (\d+) already current/.exec(summary ?? '');
    expect(buckets, 'the summary must be the two-bucket sentence').to.not.equal(null);
    expect(result.plannedChanges).to.have.length(5);
    expect(Number(buckets?.[1]) + Number(buckets?.[2])).to.equal(result.plannedChanges.length);
  });

  it('previews a DynamicRuleDefinition change as a readable diff, and carries the full values in the result', async () => {
    // A realistic blob: identical for far more than the 60 rendered characters, so a raw
    // truncated `old → new` would show the operator the same string twice.
    const orgBlob = JSON.stringify({
      apiName: 'MinDriverAgeRule',
      description: 'Driver must be at least 21 years old to qualify for this policy tier',
      name: 'Min Driver Age',
      productPath: '01tROOT00000000001/01tAUTO00000000001',
      ruleKey: null,
      underwritingRuleGroup: { fromStage: 'Submitted', toStage: 'Quoted', ruleEngineType: 'BusinessRuleEngine' },
    });
    const newBlob = ((): string => {
      const defn = JSON.parse(orgBlob) as Record<string, unknown>;
      defn.ruleKey = 'UW__auto__minDriverAge';
      (defn.underwritingRuleGroup as Record<string, unknown>).ruleEngineType = 'ConstraintEngine';
      return JSON.stringify(defn);
    })();

    stubOrgConnection({
      current: { UnderwritingRule: [{ Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: orgBlob }] },
    });
    await writePlan(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        generatedAt: '2026-06-28T12:00:00.000Z',
        updates: [
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            apiName: 'MinDriverAgeRule',
            fields: [{ field: 'DynamicRuleDefinition', value: newBlob }],
          },
        ],
      })
    );

    const result = await runCommand(['--dry-run']);

    const [preview] = result.plannedChanges;
    const [before, after] = preview.change.split(' → ');
    expect(before, 'the two sides of the preview must not be the same string').to.not.equal(after);
    expect(preview.change).to.equal(
      'ruleKey: (none) → UW__auto__minDriverAge, ' +
        'underwritingRuleGroup.ruleEngineType: BusinessRuleEngine → ConstraintEngine'
    );
    // --json consumers get the real values, not the display string.
    expect(preview.currentValue).to.equal(orgBlob);
    expect(preview.newValue).to.equal(newBlob);
  });

  it('--dry-run renders the plan and writes nothing', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));

    const result = await runCommand(['--dry-run']);

    expect(result.dryRun).to.equal(true);
    expect(result.applied).to.equal(0);
    expect(result.plannedChanges).to.have.length(1);
    expect(result.plannedChanges[0].operation).to.equal('Update');
    expect(result.plannedChanges[0].change).to.equal('BusinessRuleEngine → ConstraintEngine');
    expect(updateCalls, 'dry run must not write to the org').to.deep.equal([]);
    expect(logOutput()).to.include('Dry run only');
  });

  it('exits 0 with no prompt and no writes when the plan is empty', async () => {
    stubOrgConnection({});
    await writePlan(surchargePlanFile([]));

    const result = await runCommand();

    expect(result.applied).to.equal(0);
    expect(result.plannedChanges).to.deep.equal([]);
    expect(updateCalls).to.deep.equal([]);
    expect(logOutput()).to.include('Nothing to apply');
  });

  it('skips a record the org already matches, without writing it', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'ConstraintEngine' }],
      },
      verification: [
        {
          Id: SURCHARGE_ID,
          Name: 'Collision Fee',
          RuleEngineType: 'ConstraintEngine',
          RuleKey: 'SC__auto__collision__fee',
          RuleApiName: 'CollisionFee',
        },
      ],
    });
    await writePlan(surchargePlanFile([surchargeUpdate({ expectedRuleKey: 'SC__auto__collision__fee' })]));

    const result = await runCommand(['--no-prompt']);

    expect(result.applied).to.equal(0);
    expect(result.skipped).to.deep.equal([
      { id: SURCHARGE_ID, field: 'RuleEngineType', reason: 'org already matches the requested value' },
    ]);
    expect(updateCalls, 're-running an applied plan must be a no-op').to.deep.equal([]);
    expect(result.plannedChanges[0].operation).to.equal('Skip (already current)');
    expect(logOutput()).to.include('Records: 0 updated, 1 skipped (already current), 0 failed.');
  });

  it('applies a hand-corrected blob whose ruleKey and ruleEngineType already match the org', async () => {
    // The reviewer corrected a threshold in ruleCriteria; the two fields convert rewrites were
    // already current. The blob is written verbatim, so treating this as "already current" would
    // silently discard the correction and exit 0.
    const orgBlob =
      '{"apiName":"MinDriverAge","ruleKey":"UW_001","underwritingRuleGroup":{"ruleEngineType":"ConstraintEngine"},"ruleCriteria":[{"values":["18"]}]}';
    const handCorrected = orgBlob.replace('"18"', '"21"');
    stubOrgConnection({
      current: { UnderwritingRule: [{ Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: orgBlob }] },
    });
    await writePlan(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'underwriting-update',
        cmlApi: 'UW_AUTO',
        generatedAt: '2026-06-28T12:00:00.000Z',
        updates: [
          {
            sobject: 'UnderwritingRule',
            id: RULE_ID,
            name: 'Min Driver Age',
            apiName: 'MinDriverAge',
            fields: [{ field: 'DynamicRuleDefinition', value: handCorrected }],
          },
        ],
      })
    );

    const result = await runCommand(['--no-prompt']);

    expect(result.plannedChanges[0].operation).to.equal('Update');
    expect(result.skipped, 'a substantive hand-correction is not "already current"').to.deep.equal([]);
    expect(updateCalls).to.deep.equal([
      { sobject: 'UnderwritingRule', payloads: [{ Id: RULE_ID, DynamicRuleDefinition: handCorrected }] },
    ]);
  });

  it('re-reads exactly the records and fields each identity check depends on', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [
          { Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine', ProductPath: '' },
        ],
      },
      verification: [
        {
          Id: SURCHARGE_ID,
          Name: 'Collision Fee',
          RuleEngineType: 'ConstraintEngine',
          RuleKey: 'SC__auto__collision__fee',
          RuleApiName: 'CollisionFee',
        },
      ],
    });
    await writePlan(surchargePlanFile([surchargeUpdate({ expectedRuleKey: 'SC__auto__collision__fee' })]));

    await runCommand(['--no-prompt']);

    const [reRead] = planSoqls();
    // ProductPath backs the drift advisory; dropping it from the SELECT would silence it.
    expect(reRead).to.equal(
      `SELECT Id, Name, RuleEngineType, ProductPath FROM ProductSurcharge WHERE Id IN ('${SURCHARGE_ID}')`
    );
  });

  it('selects DynamicRuleDefinition on the underwriting re-read, since the identity guard needs it', async () => {
    stubOrgConnection({
      current: {
        UnderwritingRule: [
          { Id: RULE_ID, Name: 'Min Driver Age', DynamicRuleDefinition: '{"apiName":"MinDriverAge"}' },
        ],
      },
    });
    await writePlan(
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
            apiName: 'MinDriverAge',
            fields: [{ field: 'DynamicRuleDefinition', value: '{"apiName":"MinDriverAge","ruleKey":"UW_001"}' }],
          },
        ],
      })
    );

    await runCommand(['--no-prompt']);

    expect(planSoqls()[0]).to.equal(
      `SELECT Id, Name, DynamicRuleDefinition FROM UnderwritingRule WHERE Id IN ('${RULE_ID}')`
    );
  });

  it('reports an unreadable file as an actionable error, not a raw Node error', async () => {
    stubOrgConnection({});
    // --file only checks that the path is an existing file; permissions are not its business, so
    // EACCES lands in the command and used to escape as a bare Node error with no actions.
    await writePlan(surchargePlanFile([surchargeUpdate()]));
    await fs.chmod(planFile, 0o000);

    const error = await runExpectingError(['--no-prompt']);

    expect(error.name, 'must be an SfError carrying remediation actions').to.equal('UnreadableFileError');
    expect(error.message).to.match(/Couldn't read the record-update file/);
    expect(updateCalls).to.deep.equal([]);
  });

  it('rejects a file whose kind is not a record-update kind', async () => {
    stubOrgConnection({});
    await writePlan(JSON.stringify({ schemaVersion: 1, kind: 'product-update', cmlApi: 'SC_AUTO', updates: [] }));

    const error = await runExpectingError(['--no-prompt']);

    expect(error.message).to.match(/unsupported kind/);
    expect(updateCalls).to.deep.equal([]);
  });

  it('rejects a file that sets a field outside the allow-list, before any write', async () => {
    stubOrgConnection({});
    await writePlan(surchargePlanFile([surchargeUpdate({ fields: [{ field: 'Name', value: 'Renamed' }] })]));

    const error = await runExpectingError(['--no-prompt']);

    expect(error.message).to.match(/sets "Name" on ProductSurcharge/);
    expect(updateCalls).to.deep.equal([]);
  });

  it('refuses to write when the org record’s Name disagrees with the file', async () => {
    // Two records on purpose: one is perfectly writable. If the identity throw ever moved to after
    // the apply, the first record would already have been written when the error was raised — a
    // single-record plan cannot detect that, because a mismatch leaves nothing to write at all.
    stubOrgConnection({
      current: {
        ProductSurcharge: [
          { Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' },
          { Id: SURCHARGE_ID_2, Name: 'A Different Surcharge', RuleEngineType: 'BusinessRuleEngine' },
        ],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate(), surchargeUpdate({ id: SURCHARGE_ID_2, name: 'Theft Fee' })]));

    const error = await runExpectingError(['--no-prompt']);

    expect(error.message).to.match(/possibly-wrong record/);
    expect(error.message).to.include(SURCHARGE_ID_2);
    expect(updateCalls, 'one bad record must block the whole file, before any write').to.deep.equal([]);
  });

  it('errors after a partial failure, naming the idempotent re-run', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [
          { Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' },
          { Id: SURCHARGE_ID_2, Name: 'Theft Fee', RuleEngineType: 'BusinessRuleEngine' },
        ],
      },
      saveResults: () => [
        { success: true, errors: [] },
        { success: false, errors: [{ message: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' }] },
      ],
    });
    await writePlan(surchargePlanFile([surchargeUpdate(), surchargeUpdate({ id: SURCHARGE_ID_2, name: 'Theft Fee' })]));

    const error = await runExpectingError(['--no-prompt']);

    expect(error.message).to.match(/1 of the record updates failed/);
    expect(error.message).to.match(/partially migrated/);
    expect(warnOutput()).to.include('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY');
    // The successful write still happened — the summary must reflect the partial state.
    expect(logOutput()).to.include('Records: 1 updated, 0 skipped (already current), 1 failed.');
    // The org is now partially migrated, so automation must be able to see which record is where.
    const data = (error as SfError).data as CmlImportRecordUpdatesResult;
    expect(data.applied).to.equal(1);
    expect(data.failed).to.deep.equal([
      { id: SURCHARGE_ID_2, errors: ['INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'], outcomeUnknown: false },
    ]);
    expect(data.plannedChanges.map((c) => c.id)).to.deep.equal([SURCHARGE_ID, SURCHARGE_ID_2]);
  });

  it('says the outcome is unknown when the request itself failed after being sent', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
      saveResults: () => {
        throw new Error('socket hang up');
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));

    const error = await runExpectingError(['--no-prompt']);

    expect(error.message).to.match(/1 of the record updates failed/);
    // Claiming "not written" would be exactly wrong for a timeout after the server committed.
    expect(warnOutput()).to.match(/OUTCOME UNKNOWN Collision Fee/);
    expect(warnOutput()).to.match(/may or may not hold this change/);
  });

  it('warns (without failing) when the regenerated RuleKey does not match the converted key', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
      verification: [
        {
          Id: SURCHARGE_ID,
          Name: 'Collision Fee',
          RuleEngineType: 'ConstraintEngine',
          RuleKey: 'SC__autoGold__collision__fee',
          RuleApiName: 'CollisionFee',
        },
      ],
    });
    await writePlan(surchargePlanFile([surchargeUpdate({ expectedRuleKey: 'SC__autoSilver__collision__fee' })]));

    const result = await runCommand(['--no-prompt']);

    expect(result.applied).to.equal(1);
    expect(warnOutput()).to.match(/does not match the converted CML rule key/);
    expect(warnOutput()).to.match(/will not fire/);
  });

  it('aborts without writing anything when the operator declines the prompt', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));
    const prompter = stubInteractiveTerminal(false);

    const error = await runExpectingError();

    expect(prompter.confirm.callCount, 'the operator must actually be asked').to.equal(1);
    expect(prompter.confirm.firstCall.args[0]).to.deep.include({
      message: 'Apply these changes to the org',
      // An unanswered prompt must never be read as consent.
      defaultAnswer: false,
    });
    expect(error.message).to.match(/Aborted\. No changes were applied to the org\./);
    expect(updateCalls, 'declining the prompt must write nothing').to.deep.equal([]);
  });

  it('applies the plan when the operator confirms the prompt', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));
    const prompter = stubInteractiveTerminal(true);

    const result = await runCommand();

    expect(prompter.confirm.callCount).to.equal(1);
    expect(result.applied).to.equal(1);
    expect(updateCalls).to.deep.equal([
      { sobject: 'ProductSurcharge', payloads: [{ Id: SURCHARGE_ID, RuleEngineType: 'ConstraintEngine' }] },
    ]);
    // The preview is the whole point of the prompt, so it must precede it.
    expect(sfCommandStubs.table.calledBefore(prompter.confirm), 'the plan must be rendered before the prompt').to.equal(
      true
    );
  });

  it('never prompts under --no-prompt, and says so out loud', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));
    const prompter = stubInteractiveTerminal(false);

    const result = await runCommand(['--no-prompt']);

    expect(prompter.confirm.callCount, '--no-prompt must bypass the prompt, not answer it').to.equal(0);
    expect(result.applied).to.equal(1);
    expect(warnOutput()).to.match(/without confirmation/);
  });

  it('fails fast instead of prompting when the terminal is not interactive', async () => {
    stubOrgConnection({
      current: {
        ProductSurcharge: [{ Id: SURCHARGE_ID, Name: 'Collision Fee', RuleEngineType: 'BusinessRuleEngine' }],
      },
    });
    await writePlan(surchargePlanFile([surchargeUpdate()]));

    // The test process has no TTY, which is exactly the CI shape the gate must refuse.
    const error = await runExpectingError();

    expect(error.message).to.match(/Confirmation is required/);
    expect(updateCalls).to.deep.equal([]);
  });
});
