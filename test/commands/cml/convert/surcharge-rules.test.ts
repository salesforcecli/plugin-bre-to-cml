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
import CmlConvertSurchargeRules, {
  type CmlConvertSurchargeRulesResult,
} from '../../../../src/commands/cml/convert/surcharge-rules.js';
import { generateCsvForAssociations } from '../../../../src/shared/utils/association.utils.js';

/**
 * Curated "Gold Standard"-shaped model returned by the (mocked) ConstraintModel blob endpoint. It
 * declares a single `Collision` leaf type with a `Limit` attribute; surcharges nest into it.
 */
const GOLD_CML = `
type AutoSilver {
    decimal(2) totalPrice;
}

type Collision {
    int Limit = [1000, 2000, 5000];
}
`;

const CML_API = 'Auto_Silver';

/** A surcharge record as it appears in ProductSurcharge JSON (RuleDefinition is a JSON string). */
type SurchargeFixture = {
  Id: string;
  Name: string;
  ProductPath: string;
  RuleDefinition: string | null;
};

const ruleDefinition = (apiName: string, conditions: unknown[]): string =>
  JSON.stringify({
    ruleApiName: apiName,
    ruleCriteria: conditions.length ? [{ rootObjectId: 'root', conditions }] : [],
  });

type MockOpts = {
  existingCml?: string | undefined;
  productCodes?: Array<{ Id: string; ProductCode: string | null; Name: string | null }>;
  productTypeTags?: Array<{ ReferenceObjectId: string; ConstraintModelTag: string }>;
};

/** Identity helper so the org-fixture options read declaratively at each call site. */
const mockConnection = (opts: MockOpts): MockOpts => opts;

describe('cml convert surcharge-rules', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let workspaceDir: string;
  let surchargeFile: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'surcharge-rules-test-'));
    surchargeFile = path.join(workspaceDir, 'surcharges.json');
  });

  afterEach(async () => {
    $$.restore();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  /**
   * Routes the connection methods the surcharge command touches to in-memory fakes, keyed off the
   * SOQL text / blob URL. No live org, no network. `productTypeTags` controls which leaf products
   * resolve to a CML type (no tag => the rule is skipped as UNRESOLVED).
   */
  const stubOrgConnection = (opts: MockOpts): void => {
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
    // TestContext already wraps Connection.prototype.request; override its fake instead of
    // re-stubbing. The only request the command issues is the ConstraintModel blob GET.
    $$.fakeConnectionRequest = () => Promise.resolve(opts.existingCml ?? '');
    const queryFake = (soql: string): Promise<{ records: unknown[] }> => {
      if (soql.includes('FROM Product2')) return Promise.resolve({ records: opts.productCodes ?? [] });
      if (soql.includes('FROM ExpressionSetConstraintObj')) {
        return Promise.resolve({ records: opts.productTypeTags ?? [] });
      }
      return Promise.resolve({ records: [] });
    };
    $$.SANDBOX.stub(Connection.prototype, 'query').callsFake(queryFake as never);
  };

  const writeSurchargeFile = async (records: SurchargeFixture[]): Promise<void> => {
    await fs.writeFile(surchargeFile, JSON.stringify(records), 'utf8');
  };

  const runCommand = async (): Promise<CmlConvertSurchargeRulesResult> => {
    const result: CmlConvertSurchargeRulesResult = await CmlConvertSurchargeRules.run([
      '--target-org',
      testOrg.username,
      '--surcharge-file',
      surchargeFile,
      '--cml-api',
      CML_API,
      '--workspace-dir',
      workspaceDir,
    ]);
    return result;
  };

  const warnOutput = (): string =>
    sfCommandStubs.warn
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  it('errors clearly when no existing ConstraintModel is found (merge has nothing to merge into)', async () => {
    // existingCml undefined => fetchExistingConstraintModel resolves undefined => the merge guard fires.
    stubOrgConnection({
      existingCml: undefined,
      productTypeTags: [{ ReferenceObjectId: '01tCOLL00000000001', ConstraintModelTag: 'Collision' }],
    });
    await writeSurchargeFile([
      {
        Id: 'a0p000000000001',
        Name: 'Collision Fee',
        ProductPath: '01tROOT00000000001/01tCOLL00000000001',
        RuleDefinition: ruleDefinition('CollisionFee', []),
      },
    ]);

    let error: Error | undefined;
    try {
      await runCommand();
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'command should reject when no model exists').to.be.an('error');
    expect(error?.message).to.match(/existing ConstraintModel/i);
    expect(error?.message).to.include(CML_API);
  });

  it('inserts a surcharge rule into the resolved leaf type block and writes the three output files', async () => {
    stubOrgConnection(
      mockConnection({
        existingCml: GOLD_CML,
        productCodes: [
          { Id: '01tROOT00000000001', ProductCode: 'autoSilver', Name: 'Auto Silver' },
          { Id: '01tCOLL00000000001', ProductCode: 'collision', Name: 'Collision' },
        ],
        productTypeTags: [{ ReferenceObjectId: '01tCOLL00000000001', ConstraintModelTag: 'Collision' }],
      })
    );
    await writeSurchargeFile([
      {
        Id: 'a0p000000000001',
        Name: 'Collision Fee',
        ProductPath: '01tROOT00000000001/01tCOLL00000000001',
        RuleDefinition: ruleDefinition('CollisionFee', [
          { operator: 'GreaterThan', attributeName: 'Limit', dataType: 'Number', values: ['1000'] },
        ]),
      },
    ]);

    const result = await runCommand();

    // Outputs are reported back and on disk.
    expect(result.cmlFile).to.equal(path.join(workspaceDir, `${CML_API}.cml`));
    expect(result.associationsFile).to.equal(path.join(workspaceDir, `${CML_API}_Associations.csv`));
    expect(result.ruleKeyMapping).to.have.length(1);
    expect(result.ruleKeyMapping[0].ruleKey).to.equal('SC__autoSilver__collision__CollisionFee');

    const mergedCml = await fs.readFile(result.cmlFile, 'utf8');
    // The rule is nested inside the Collision block (after its header, before the model end).
    const collisionIdx = mergedCml.indexOf('type Collision {');
    const ruleIdx = mergedCml.indexOf('SC__autoSilver__collision__CollisionFee');
    expect(ruleIdx).to.be.greaterThan(collisionIdx);
    expect(mergedCml).to.include(
      'rule(Limit > 1000, "InsuranceSurchargeRule", "SC__autoSilver__collision__CollisionFee", "True");'
    );

    // The associations file is the header-only CSV.
    const csv = await fs.readFile(result.associationsFile, 'utf8');
    expect(csv.trim()).to.equal(
      'ExpressionSet.ApiName,ConstraintModelTag,ConstraintModelTagType,ReferenceObjectId,$Product2ReferenceId,$ProductClassificationName,$ProductRelatedComponentKey'
    );

    // And the rule-key mapping file is written.
    const mapping = JSON.parse(
      await fs.readFile(path.join(workspaceDir, `${CML_API}_RuleKeyMapping.json`), 'utf8')
    ) as Array<{ ruleKey: string }>;
    expect(mapping[0].ruleKey).to.equal('SC__autoSilver__collision__CollisionFee');
  });

  it('surfaces both a skip and an attribute warning (neither is silent)', async () => {
    stubOrgConnection(
      mockConnection({
        existingCml: GOLD_CML,
        productCodes: [
          { Id: '01tROOT00000000001', ProductCode: 'autoSilver', Name: 'Auto Silver' },
          { Id: '01tCOLL00000000001', ProductCode: 'collision', Name: 'Collision' },
          { Id: '01tORPH00000000001', ProductCode: 'orphan', Name: 'Orphan' },
        ],
        // Only Collision resolves to a type tag; the orphan leaf has none => that rule is skipped.
        productTypeTags: [{ ReferenceObjectId: '01tCOLL00000000001', ConstraintModelTag: 'Collision' }],
      })
    );
    await writeSurchargeFile([
      {
        // Resolves to Collision, but references GhostAttr which is absent from the model => WARN.
        Id: 'a0p000000000001',
        Name: 'Ghost Attr Fee',
        ProductPath: '01tROOT00000000001/01tCOLL00000000001',
        RuleDefinition: ruleDefinition('GhostAttrFee', [
          { operator: 'GreaterThan', attributeName: 'GhostAttr', dataType: 'Number', values: ['5'] },
        ]),
      },
      {
        // Leaf product has no type tag => UNRESOLVED => skipped (reported, not silent).
        Id: 'a0p000000000002',
        Name: 'Orphan Fee',
        ProductPath: '01tROOT00000000001/01tORPH00000000001',
        RuleDefinition: ruleDefinition('OrphanFee', [
          { operator: 'GreaterThan', attributeName: 'Limit', dataType: 'Number', values: ['1000'] },
        ]),
      },
    ]);

    const result = await runCommand();

    const warns = warnOutput();
    // The skip is surfaced as a warning with a clear reason.
    expect(warns).to.match(/SKIPPED Orphan Fee/);
    // The absent-attribute warning is surfaced.
    expect(warns).to.match(/ATTRIBUTE/);
    expect(warns).to.match(/GhostAttr/);

    // Only the resolvable rule made it into the mapping (the orphan was skipped, not placed).
    expect(result.ruleKeyMapping).to.have.length(1);
    expect(result.ruleKeyMapping[0].name).to.equal('Ghost Attr Fee');

    const mergedCml = await fs.readFile(result.cmlFile, 'utf8');
    expect(mergedCml).to.include('SC__autoSilver__collision__GhostAttrFee');
    expect(mergedCml).to.not.include('OrphanFee');
  });

  // ---- M8: the insurance-layer merge-CSV header MUST stay identical to the common util's header.
  // The constant is duplicated (insurance owns the header-only merge CSV; the common util owns the
  // build-path CSV). This guard fails if the common header drifts so the divergence can't go silent.
  it('M8: merge associations header is byte-identical to the common util header', async () => {
    stubOrgConnection(
      mockConnection({
        existingCml: GOLD_CML,
        productCodes: [
          { Id: '01tROOT00000000001', ProductCode: 'autoSilver', Name: 'Auto Silver' },
          { Id: '01tCOLL00000000001', ProductCode: 'collision', Name: 'Collision' },
        ],
        productTypeTags: [{ ReferenceObjectId: '01tCOLL00000000001', ConstraintModelTag: 'Collision' }],
      })
    );
    await writeSurchargeFile([
      {
        Id: 'a0p000000000001',
        Name: 'Collision Fee',
        ProductPath: '01tROOT00000000001/01tCOLL00000000001',
        RuleDefinition: ruleDefinition('CollisionFee', []),
      },
    ]);

    const result = await runCommand();
    const mergeHeader = (await fs.readFile(result.associationsFile, 'utf8')).split('\n')[0];

    // The common util emits its header as the first line of its CSV (with zero associations).
    const commonHeader = generateCsvForAssociations('ignored', []).split('\n')[0];

    expect(mergeHeader).to.equal(commonHeader);
  });
});
