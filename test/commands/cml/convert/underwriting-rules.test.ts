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
import { Connection } from '@salesforce/core';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import CmlConvertUnderwritingRules, {
  type CmlConvertUnderwritingRulesResult,
} from '../../../../src/commands/cml/convert/underwriting-rules.js';
import { RecordUpdate, RecordUpdatePlan } from '../../../../src/shared/insurance/models.js';

/**
 * Curated model returned by the (mocked) ConstraintModel blob endpoint. `AutoSilver` and `Collision`
 * are well-formed leaf types; `TwiceDeclared` is declared twice so a rule resolving to it hits the
 * ambiguous-type-block skip. No `GhostType` block exists, so a tag pointing at it hits the
 * type-block-missing skip.
 */
const GOLD_CML = `
type AutoSilver {
    int DriverAge = [16, 99];
}

type Collision {
    int DriverAge = [16, 99];
}

type TwiceDeclared {
    int DriverAge = [16, 99];
}

type TwiceDeclared {
    int DriverAge = [16, 99];
}
`;

const CML_API = 'Auto_Silver';

const ROOT_ID = '01tROOT00000000001';
const AUTO_ID = '01tAUTO00000000001';
const COLL_ID = '01tCOLL00000000001';
const TWICE_ID = '01tTWICE0000000001';
const GHOST_ID = '01tGHOST0000000001';
const ORPHAN_ID = '01tORPHAN000000001';

/** An UnderwritingRule row as the command's SOQL selects it (also the --uw-file record shape). */
type UwFixture = {
  Id: string;
  Name: string;
  ApiName: string | null;
  ProductPath: string;
  RuleKey: string | null;
  DynamicRuleDefinition: string | null;
  UnderwritingRuleGroupId: string | null;
  UnderwritingRuleGroup: { Name: string | null } | null;
};

/**
 * A DynamicRuleDefinition blob: one DriverAge condition plus the stage transition, as the org stores
 * it. `groupExtras` seeds additional keys on the nested `underwritingRuleGroup` so a test can pin
 * what the org already had there (e.g. an existing `ruleEngineType`, or the always-null
 * `underwritingRuleGroupId` real orgs carry).
 */
const dynamicRuleDefinition = (
  apiName: string,
  fromStage = 'Draft',
  toStage = 'Submitted',
  groupExtras: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    name: apiName,
    apiName,
    underwritingRuleGroup: { fromStage, toStage, ...groupExtras },
    ruleCriteria: [
      {
        rootObjectId: 'root',
        conditions: [{ operator: 'GreaterThan', attributeName: 'DriverAge', dataType: 'Number', values: ['16'] }],
      },
    ],
  });

/**
 * One rule under one group. `leafId` is the last ProductPath segment (what resolves the CML type);
 * `apiName` drives the constraint name, so two rules sharing it under the same type collide.
 */
const uwRecord = (opts: {
  id: string;
  name: string;
  apiName?: string;
  groupId: string | null;
  groupName?: string | null;
  leafId?: string;
  productPath?: string;
  groupExtras?: Record<string, unknown>;
}): UwFixture => ({
  Id: opts.id,
  Name: opts.name,
  ApiName: opts.apiName ?? opts.name,
  ProductPath: opts.productPath ?? `${ROOT_ID}/${opts.leafId ?? AUTO_ID}`,
  RuleKey: null,
  DynamicRuleDefinition: dynamicRuleDefinition(opts.apiName ?? opts.name, 'Draft', 'Submitted', opts.groupExtras),
  UnderwritingRuleGroupId: opts.groupId,
  UnderwritingRuleGroup: { Name: opts.groupName === undefined ? `Group ${opts.groupId}` : opts.groupName },
});

type MockOpts = {
  existingCml?: string | undefined;
  productCodes?: Array<{ Id: string; ProductCode: string | null; Name: string | null }>;
  productTypeTags?: Array<{ ReferenceObjectId: string; ConstraintModelTag: string }>;
};

const ALL_PRODUCT_CODES: MockOpts['productCodes'] = [
  { Id: ROOT_ID, ProductCode: 'autoRoot', Name: 'Auto Root' },
  { Id: AUTO_ID, ProductCode: 'autoSilver', Name: 'Auto Silver' },
  { Id: COLL_ID, ProductCode: 'collision', Name: 'Collision' },
  { Id: TWICE_ID, ProductCode: 'twice', Name: 'Twice Declared' },
  { Id: GHOST_ID, ProductCode: 'ghost', Name: 'Ghost' },
  { Id: ORPHAN_ID, ProductCode: 'orphan', Name: 'Orphan' },
];

/** ORPHAN_ID deliberately has no tag (no-type-tag skip); GHOST_ID's tag names a type the model lacks. */
const ALL_TYPE_TAGS: MockOpts['productTypeTags'] = [
  { ReferenceObjectId: AUTO_ID, ConstraintModelTag: 'AutoSilver' },
  { ReferenceObjectId: COLL_ID, ConstraintModelTag: 'Collision' },
  { ReferenceObjectId: TWICE_ID, ConstraintModelTag: 'TwiceDeclared' },
  { ReferenceObjectId: GHOST_ID, ConstraintModelTag: 'GhostType' },
];

describe('cml convert underwriting-rules', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let workspaceDir: string;
  let uwFile: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'underwriting-rules-test-'));
    uwFile = path.join(workspaceDir, 'uw.json');
  });

  afterEach(async () => {
    $$.restore();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  /** Routes the connection methods the command touches to in-memory fakes. No live org, no network. */
  const stubOrgConnection = (opts: MockOpts = {}): void => {
    $$.SANDBOX.stub(Connection.prototype, 'getApiVersion').returns('68.0');
    $$.SANDBOX.stub(Connection.prototype, 'sobject').callsFake(
      (name: string) =>
        ({
          findOne: (): Promise<unknown> => {
            if (opts.existingCml === undefined) return Promise.resolve(null);
            if (name === 'ExpressionSetDefinition') return Promise.resolve({ Id: 'def1' });
            if (name === 'ExpressionSetDefinitionVersion') return Promise.resolve({ Id: 'ver1' });
            return Promise.resolve(null);
          },
        } as unknown as ReturnType<Connection['sobject']>)
    );
    $$.fakeConnectionRequest = () => Promise.resolve(opts.existingCml ?? GOLD_CML);
    const queryFake = (soql: string): Promise<{ records: unknown[] }> => {
      if (soql.includes('FROM Product2')) return Promise.resolve({ records: opts.productCodes ?? ALL_PRODUCT_CODES });
      if (soql.includes('FROM ExpressionSetConstraintObj')) {
        return Promise.resolve({ records: opts.productTypeTags ?? ALL_TYPE_TAGS });
      }
      return Promise.resolve({ records: [] });
    };
    $$.SANDBOX.stub(Connection.prototype, 'query').callsFake(queryFake as never);
  };

  const runCommand = async (records: UwFixture[], opts: MockOpts = {}): Promise<CmlConvertUnderwritingRulesResult> => {
    stubOrgConnection({ existingCml: GOLD_CML, ...opts });
    await fs.writeFile(uwFile, JSON.stringify(records), 'utf8');
    return CmlConvertUnderwritingRules.run([
      '--target-org',
      testOrg.username,
      '--uw-file',
      uwFile,
      '--cml-api',
      CML_API,
      '--workspace-dir',
      workspaceDir,
    ]);
  };

  const readPlan = async (result: CmlConvertUnderwritingRulesResult): Promise<RecordUpdatePlan> =>
    JSON.parse(await fs.readFile(result.recordUpdateFile as string, 'utf8')) as RecordUpdatePlan;

  const groupUpdates = (plan: RecordUpdatePlan): RecordUpdate[] =>
    plan.updates.filter((u) => u.sobject === 'UnderwritingRuleGroup');

  const ruleUpdates = (plan: RecordUpdatePlan): RecordUpdate[] =>
    plan.updates.filter((u) => u.sobject === 'UnderwritingRule');

  /** The rewritten DynamicRuleDefinition string an update would write, verbatim. */
  const rewrittenBlob = (update: RecordUpdate): string => {
    const field = update.fields.find((f) => f.field === 'DynamicRuleDefinition');
    expect(field, `${update.name} should carry a DynamicRuleDefinition rewrite`).to.not.equal(undefined);
    return field?.value ?? '';
  };

  const parsedBlob = (update: RecordUpdate): Record<string, unknown> =>
    JSON.parse(rewrittenBlob(update)) as Record<string, unknown>;

  const nestedGroup = (update: RecordUpdate): Record<string, unknown> =>
    parsedBlob(update).underwritingRuleGroup as Record<string, unknown>;

  const warnOutput = (): string =>
    sfCommandStubs.warn
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  const logOutput = (): string =>
    sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  // ---- Positive control. A rule whose constraint really lands in the merged CML must still flip its
  // group; without this the "don't flip" assertions below could pass on a plan that flips nothing.
  it('flips the rule group of a rule whose constraint landed in the merged CML', async () => {
    const result = await runCommand([
      uwRecord({ id: '1KX000000000001', name: 'Placed Rule', groupId: '1KQ000000000001', groupName: 'Placed Group' }),
    ]);

    expect(result.ruleKeyMapping, 'the rule should have been placed').to.have.length(1);
    const mergedCml = await fs.readFile(result.cmlFile, 'utf8');
    expect(mergedCml).to.include('constraint Placed_Rule_DraftToSubmitted');

    const groups = groupUpdates(await readPlan(result));
    expect(groups).to.have.length(1);
    expect(groups[0].id).to.equal('1KQ000000000001');
    expect(groups[0].name).to.equal('Placed Group');
    expect(groups[0].fields).to.deep.equal([{ field: 'RuleEngineType', value: 'ConstraintEngine' }]);
  });

  // ---- The defect, in the shape the live-org run produced: 7 groups flipped while only 1 rule was
  // merged. Every skipped rule's group must be absent from the plan entirely — a group flipped with
  // no constraint behind it silently disables the rule the platform stops evaluating.
  //
  // One case per distinct skip reason `mergeUnderwritingConstraints` can report.
  const skipCases: Array<{ reason: string; records: (groupId: string) => UwFixture[]; expectWarn: RegExp }> = [
    {
      reason: 'empty ProductPath',
      records: (groupId) => [uwRecord({ id: '1KX000000000011', name: 'No Path Rule', groupId, productPath: ' / ' })],
      expectWarn: /SKIPPED No Path Rule: empty ProductPath/,
    },
    {
      reason: 'no CML type tag for the leaf product',
      records: (groupId) => [uwRecord({ id: '1KX000000000012', name: 'Orphan Rule', groupId, leafId: ORPHAN_ID })],
      expectWarn: /SKIPPED Orphan Rule: no CML type tag/,
    },
    {
      reason: 'type block missing from the existing model',
      records: (groupId) => [uwRecord({ id: '1KX000000000013', name: 'Ghost Rule', groupId, leafId: GHOST_ID })],
      expectWarn: /SKIPPED Ghost Rule: type block 'GhostType' not found in existing model/,
    },
    {
      reason: 'ambiguous type block',
      records: (groupId) => [uwRecord({ id: '1KX000000000014', name: 'Twice Rule', groupId, leafId: TWICE_ID })],
      expectWarn: /SKIPPED Twice Rule: type block 'TwiceDeclared' is ambiguous/,
    },
    {
      reason: 'intra-run duplicate (typeName, constraintName)',
      // Two records resolving to the same type and the same constraint name: the first is placed
      // (under its own group), the second collides and is skipped.
      records: (groupId) => [
        uwRecord({
          id: '1KX000000000015',
          name: 'First Winner',
          apiName: 'SharedApiName',
          groupId: '1KQ000000000099',
          groupName: 'Winner Group',
        }),
        uwRecord({ id: '1KX000000000016', name: 'Dup Loser', apiName: 'SharedApiName', groupId }),
      ],
      expectWarn: /SKIPPED Dup Loser: duplicate constraint name/,
    },
  ];

  for (const testCase of skipCases) {
    it(`does not flip the rule group of a rule skipped for: ${testCase.reason}`, async () => {
      const skippedGroupId = '1KQ000000000042';
      const result = await runCommand(testCase.records(skippedGroupId));

      // The rule really was skipped for the reason under test (guards against the fixture drifting
      // into a different skip reason, or into being placed).
      expect(warnOutput()).to.match(testCase.expectWarn);
      expect(result.ruleKeyMapping.map((m) => m.recordId)).to.not.include(testCase.records(skippedGroupId).at(-1)?.Id);

      const groupIds = groupUpdates(await readPlan(result)).map((u) => u.id);
      expect(groupIds, 'a group with no merged constraint must not be flipped').to.not.include(skippedGroupId);
    });
  }

  it('emits no group flips at all when every rule was skipped', async () => {
    const result = await runCommand([
      uwRecord({ id: '1KX000000000021', name: 'Orphan One', groupId: '1KQ000000000021', leafId: ORPHAN_ID }),
      uwRecord({ id: '1KX000000000022', name: 'Orphan Two', groupId: '1KQ000000000022', leafId: ORPHAN_ID }),
    ]);

    expect(result.ruleKeyMapping).to.have.length(0);
    const plan = await readPlan(result);
    expect(plan.updates).to.deep.equal([]);
    // The operator is told the flips were withheld rather than being left to infer it from an
    // empty plan.
    expect(logOutput()).to.match(/Withheld 2 UnderwritingRuleGroup flip/);
  });

  // ---- Partial group: some rules placed, some skipped. Flipping disables the skipped rules'
  // logic (unrecoverable until someone notices); withholding leaves the placed constraints inert
  // (recoverable by re-running). We withhold and warn.
  it('withholds a partially-migrated group and names the inert constraint and the blocking rule', async () => {
    const result = await runCommand([
      uwRecord({
        id: '1KX000000000031',
        name: 'Mixed Placed',
        groupId: '1KQ000000000031',
        groupName: 'Mixed Group',
      }),
      uwRecord({
        id: '1KX000000000032',
        name: 'Mixed Skipped',
        groupId: '1KQ000000000031',
        groupName: 'Mixed Group',
        leafId: ORPHAN_ID,
      }),
    ]);

    // One of the two rules did land in the CML, so this is genuinely the mixed case.
    expect(result.ruleKeyMapping.map((m) => m.name)).to.deep.equal(['Mixed Placed']);

    const plan = await readPlan(result);
    expect(
      groupUpdates(plan).map((u) => u.id),
      'partial group must not be flipped'
    ).to.not.include('1KQ000000000031');

    const warns = warnOutput();
    expect(warns).to.include('Mixed Group');
    expect(warns).to.match(/not flipping|Not flipping/);
    // Both halves of the trade-off are named: what blocks the flip, and what stays inert.
    expect(warns).to.include('Mixed Skipped');
    expect(warns).to.include('Mixed Placed');
  });

  it('flips only the groups whose rules were merged when placed and skipped groups are mixed', async () => {
    const result = await runCommand([
      uwRecord({ id: '1KX000000000041', name: 'Good Rule', groupId: '1KQ000000000041', groupName: 'Good Group' }),
      uwRecord({
        id: '1KX000000000042',
        name: 'Claim Rule A',
        groupId: '1KQ000000000042',
        groupName: 'Claim Group A',
        leafId: ORPHAN_ID,
      }),
      uwRecord({
        id: '1KX000000000043',
        name: 'Claim Rule B',
        groupId: '1KQ000000000043',
        groupName: 'Claim Group B',
        leafId: GHOST_ID,
      }),
    ]);

    const plan = await readPlan(result);
    expect(groupUpdates(plan).map((u) => u.id)).to.deep.equal(['1KQ000000000041']);
    // The placed rule's own blob rewrite is still emitted (it is the record that got a ruleKey).
    expect(plan.updates.filter((u) => u.sobject === 'UnderwritingRule').map((u) => u.id)).to.deep.equal([
      '1KX000000000041',
    ]);
  });

  it('still refuses to flip a placed rule\u2019s group when the group Name could not be resolved', async () => {
    const result = await runCommand([
      uwRecord({ id: '1KX000000000051', name: 'Nameless Group Rule', groupId: '1KQ000000000051', groupName: null }),
    ]);

    expect(result.ruleKeyMapping, 'the rule itself should be placed').to.have.length(1);
    expect(groupUpdates(await readPlan(result))).to.have.length(0);
    expect(warnOutput()).to.match(/no Name resolved/);
  });

  // ---- The blob rewrite must agree with the flip decision. Withholding a group's flip while its
  // placed rule's blob still asserts `underwritingRuleGroup.ruleEngineType: ConstraintEngine` leaves
  // the applied org in a self-contradictory state: the blob says ConstraintEngine, the group record
  // it names still carries its old RuleEngineType. (Whether the platform READS the nested copy is
  // unverified — the sibling `underwritingRuleGroupId` is null in every stored blob and appears
  // unmaintained — so these tests pin internal consistency, not a known runtime failure.)
  describe('nested underwritingRuleGroup.ruleEngineType', () => {
    /** The whole mutation, and nothing but: the org's stored document with `ruleKey` set. */
    const withRuleKeyOnly = (record: UwFixture, ruleKey: string): string =>
      JSON.stringify({ ...(JSON.parse(record.DynamicRuleDefinition as string) as Record<string, unknown>), ruleKey });

    const placedRuleKey = (result: CmlConvertUnderwritingRulesResult, recordId: string): string =>
      result.ruleKeyMapping.find((m) => m.recordId === recordId)?.ruleKey ?? '<not placed>';

    // Positive control: guards the fix against over-correcting into "never set it".
    it('is set to ConstraintEngine when the rule\u2019s group IS flipped by this same plan', async () => {
      const record = uwRecord({
        id: '1KX000000000061',
        name: 'Flipped Rule',
        groupId: '1KQ000000000061',
        groupName: 'Flipped Group',
        groupExtras: { ruleEngineType: 'BusinessRuleEngine' },
      });
      const result = await runCommand([record]);
      const plan = await readPlan(result);

      expect(
        groupUpdates(plan).map((u) => u.id),
        'the group really is flipped here'
      ).to.deep.equal(['1KQ000000000061']);
      const rules = ruleUpdates(plan);
      expect(rules.map((u) => u.id)).to.deep.equal([record.Id]);
      expect(nestedGroup(rules[0]).ruleEngineType).to.equal('ConstraintEngine');
      expect(parsedBlob(rules[0]).ruleKey).to.equal(placedRuleKey(result, record.Id));
    });

    it('keeps the org\u2019s stored value when the group is withheld for being partially migrated', async () => {
      const placed = uwRecord({
        id: '1KX000000000062',
        name: 'Partial Placed',
        groupId: '1KQ000000000062',
        groupName: 'Partial Group',
        // What a real org stores: an explicit BRE engine type, and the null sibling id.
        groupExtras: { ruleEngineType: 'BusinessRuleEngine', underwritingRuleGroupId: null },
      });
      const skipped = uwRecord({
        id: '1KX000000000063',
        name: 'Partial Skipped',
        groupId: '1KQ000000000062',
        groupName: 'Partial Group',
        leafId: ORPHAN_ID,
      });
      const result = await runCommand([placed, skipped]);
      const plan = await readPlan(result);

      expect(groupUpdates(plan), 'the partial group must stay unflipped for this test to mean anything').to.have.length(
        0
      );
      const rules = ruleUpdates(plan);
      expect(
        rules.map((u) => u.id),
        'the placed rule still gets its blob rewritten'
      ).to.deep.equal([placed.Id]);
      expect(nestedGroup(rules[0]).ruleEngineType).to.equal('BusinessRuleEngine');
      // The ruleKey rewrite is the whole reason the update is still emitted.
      expect(parsedBlob(rules[0]).ruleKey).to.equal(placedRuleKey(result, placed.Id));
      // ...and nothing else in the document moved, byte for byte.
      expect(rewrittenBlob(rules[0])).to.equal(withRuleKeyOnly(placed, placedRuleKey(result, placed.Id)));
    });

    it('is not introduced when the group is withheld and the org never stored one', async () => {
      const record = uwRecord({
        id: '1KX000000000064',
        name: 'Nameless Blob Rule',
        groupId: '1KQ000000000064',
        groupName: null,
      });
      const result = await runCommand([record]);
      const plan = await readPlan(result);

      expect(groupUpdates(plan), 'a Name-less group is never flipped').to.have.length(0);
      const rules = ruleUpdates(plan);
      expect(rules.map((u) => u.id)).to.deep.equal([record.Id]);
      // Absent stays absent: withholding must not delete, add, or substitute the nested value.
      expect(Object.keys(nestedGroup(rules[0]))).to.deep.equal(['fromStage', 'toStage']);
      expect(rewrittenBlob(rules[0])).to.equal(withRuleKeyOnly(record, placedRuleKey(result, record.Id)));
    });

    it('emits no blob rewrite at all for a group none of whose rules were placed', async () => {
      const result = await runCommand([
        uwRecord({ id: '1KX000000000065', name: 'All Skipped', groupId: '1KQ000000000065', leafId: ORPHAN_ID }),
      ]);
      const plan = await readPlan(result);

      expect(plan.updates).to.deep.equal([]);
      expect(JSON.stringify(plan.updates)).to.not.include('ConstraintEngine');
    });

    it('claims ConstraintEngine in exactly the blobs whose group this plan flips', async () => {
      const records = [
        uwRecord({ id: '1KX000000000071', name: 'Whole Group Rule', groupId: '1KQ000000000071', groupName: 'Whole' }),
        uwRecord({ id: '1KX000000000072', name: 'Mixed Placed Rule', groupId: '1KQ000000000072', groupName: 'Mixed' }),
        uwRecord({
          id: '1KX000000000073',
          name: 'Mixed Skipped Rule',
          groupId: '1KQ000000000072',
          groupName: 'Mixed',
          leafId: ORPHAN_ID,
        }),
        uwRecord({ id: '1KX000000000074', name: 'Nameless Rule', groupId: '1KQ000000000074', groupName: null }),
        uwRecord({ id: '1KX000000000075', name: 'Dead Group Rule', groupId: '1KQ000000000075', leafId: GHOST_ID }),
      ];
      const result = await runCommand(records);
      const plan = await readPlan(result);

      const flipped = new Set(groupUpdates(plan).map((u) => u.id));
      expect([...flipped], 'only the fully-migrated named group flips').to.deep.equal(['1KQ000000000071']);

      const groupIdOf = new Map(records.map((r) => [r.Id, r.UnderwritingRuleGroupId]));
      const claiming = ruleUpdates(plan)
        .filter((u) => nestedGroup(u).ruleEngineType === 'ConstraintEngine')
        .map((u) => u.id);
      const expected = ruleUpdates(plan)
        .filter((u) => flipped.has(groupIdOf.get(u.id) ?? ''))
        .map((u) => u.id);

      expect(ruleUpdates(plan).length, 'the run must emit more blob rewrites than flips').to.be.greaterThan(
        flipped.size
      );
      expect(claiming).to.deep.equal(expected);
    });
  });
});
