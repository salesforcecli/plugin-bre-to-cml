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

  const runCommandNoCmlApi = async (): Promise<CmlConvertSurchargeRulesResult> => {
    const result: CmlConvertSurchargeRulesResult = await CmlConvertSurchargeRules.run([
      '--target-org',
      testOrg.username,
      '--surcharge-file',
      surchargeFile,
      '--workspace-dir',
      workspaceDir,
    ]);
    return result;
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

  // ---- Fix #15: every emitted output path must use the OS-native separator (path.join), not
  // a hardcoded `${workspaceDir}/<name>` template literal. The hardcoded form returns forward
  // slashes on Windows even when `workspaceDir` is `C:\Users\...`, which yields paths like
  // `C:\Users\foo/Auto_Silver.cml` and breaks any caller that compares with path.join(). This
  // test verifies the four output paths (cml, associations, mapping, record-update) all match
  // path.join(workspaceDir, ...) exactly and contain no mixed separators within their leaf names.
  it('Fix #15: emits output paths via path.join so the OS-native separator is used', async () => {
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

    // Every emitted path equals path.join(workspaceDir, leaf) — i.e. uses the OS-native separator.
    // On Linux/macOS path.sep is '/', on Windows '\'. The test is meaningful on every platform
    // because a hardcoded '${workspaceDir}/<name>' template literal would only ever emit '/',
    // which on Windows differs from path.join and would fail this assertion.
    expect(result.cmlFile).to.equal(path.join(workspaceDir, `${CML_API}.cml`));
    expect(result.associationsFile).to.equal(path.join(workspaceDir, `${CML_API}_Associations.csv`));
    // recordUpdateFile is typed as optional on the result envelope (it's absent for build-mode
    // failures that short-circuit before the manifest is written), but the merge path always
    // produces it — assert presence then equality.
    expect(result.recordUpdateFile, 'merge path should emit a record-update file').to.be.a('string');
    expect(result.recordUpdateFile).to.equal(path.join(workspaceDir, `${CML_API}_SurchargeUpdate.json`));

    // The leaf name of each path must be plain (no embedded separators). Defends against a future
    // regression where someone reintroduces `${workspaceDir}/${leaf}` and `leaf` itself accidentally
    // contains a slash — path.basename should be a clean filename, not a sub-path.
    expect(path.basename(result.cmlFile)).to.equal(`${CML_API}.cml`);
    expect(path.basename(result.recordUpdateFile as string)).to.equal(`${CML_API}_SurchargeUpdate.json`);
  });

  // ---- Fix #11: the convert layer routes every ProductPath parse through `splitProductPath` —
  // a single helper with `trim + drop-empty` semantics. A path with leading slashes, blank
  // segments, and surrounding whitespace must NOT produce ghost product ids (which would surface
  // as bogus "Product ... was not returned by Product2 query" warnings for the empty string).
  it('Fix #11: messy ProductPaths (leading slash, blanks, whitespace) do not generate ghost product ids', async () => {
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
        // Leading slash, surrounding whitespace, and a blank middle segment — these would yield
        // empty-string ids if the convert layer parsed the path with raw `.split('/')`.
        ProductPath: '/  01tROOT00000000001  // 01tCOLL00000000001 /',
        RuleDefinition: ruleDefinition('CollisionFee', []),
      },
    ]);

    await runCommand();

    const warns = warnOutput();
    // No warning naming the empty string as a product id.
    expect(warns).to.not.match(/Product\s+was not returned/);
    expect(warns).to.not.match(/Product\s+has no ProductCode/);
  });

  // ---- Fix #9: when any rule is skipped the merge logs a single high-signal summary line that
  // buckets the skip reasons. An operator scanning the output for "what got dropped" should not
  // have to grep through per-rule warnings to count reasons.
  it('Fix #9: logs a final skip-breakdown summary when at least one rule is skipped', async () => {
    stubOrgConnection(
      mockConnection({
        existingCml: GOLD_CML,
        productCodes: [
          { Id: '01tROOT00000000001', ProductCode: 'autoSilver', Name: 'Auto Silver' },
          { Id: '01tORPH00000000001', ProductCode: 'orphan', Name: 'Orphan' },
        ],
        // No tag for the leaf => no-type-tag skip.
        productTypeTags: [],
      })
    );
    await writeSurchargeFile([
      {
        Id: 'a0p000000000001',
        Name: 'Orphan Fee',
        ProductPath: '01tROOT00000000001/01tORPH00000000001',
        RuleDefinition: ruleDefinition('OrphanFee', []),
      },
    ]);

    await runCommand();

    const logs = logOutput();
    expect(logs).to.match(/Skip breakdown:/);
    expect(logs).to.match(/no-type-tag/);
  });

  // ---- Fix #8: a product id that the Product2 query did NOT return (deleted / not visible /
  // filtered) used to silently fall back to the raw Id for that path segment, yielding a rule
  // key that won't match the platform-generated RuleKey. Surface it as a warning, distinct from
  // the existing null-ProductCode fallback warning.
  it('Fix #8: warns for a product id that is absent from the Product2 query result map', async () => {
    stubOrgConnection(
      mockConnection({
        existingCml: GOLD_CML,
        // Only the root resolves; the leaf id is referenced by ProductPath but missing from the
        // Product2 fixture, so it never reaches productIdToCode.
        productCodes: [{ Id: '01tROOT00000000001', ProductCode: 'autoSilver', Name: 'Auto Silver' }],
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

    await runCommand();

    const warns = warnOutput();
    // The Fix #8 warning specifically calls out the missing leaf id.
    expect(warns).to.match(/01tCOLL00000000001 was not returned by Product2 query/);
  });

  // ---- Fix #6: the --surcharge-file path JSON-parses operator-supplied input. A non-array root
  // or a record missing Id / Name / ProductPath used to propagate `undefined`s downstream as
  // confusing errors / malformed output; the loader now refuses such input with a clear message.
  it('Fix #6: rejects --surcharge-file whose top-level JSON is not an array', async () => {
    stubOrgConnection({ existingCml: GOLD_CML });
    // Top-level object instead of an array of records.
    await fs.writeFile(surchargeFile, JSON.stringify({ records: [] }), 'utf8');

    let error: Error | undefined;
    try {
      await runCommand();
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'command should reject a non-array root').to.be.an('error');
    expect(error?.message).to.match(/expected a top-level JSON array/);
  });

  it('Fix #6: rejects --surcharge-file records that are missing required string fields', async () => {
    stubOrgConnection({ existingCml: GOLD_CML });
    // Valid array shape but Id is the wrong type.
    await fs.writeFile(
      surchargeFile,
      JSON.stringify([{ Id: 12345, Name: 'X', ProductPath: '01tROOT00000000001', RuleDefinition: null }]),
      'utf8'
    );

    let error: Error | undefined;
    try {
      await runCommand();
    } catch (e) {
      error = e as Error;
    }
    expect(error, 'command should reject a non-string Id').to.be.an('error');
    expect(error?.message).to.match(/missing or non-string Id/);
  });

  // ---- Fix #5: when --cml-api is omitted, the auto-discovery fallback generates a CML API name
  // from the joined ProductCodes. A ProductCode that contains slashes / spaces / quotes would break
  // the on-disk path or SOQL identifier semantics downstream; the fallback must sanitize each
  // segment to `[A-Za-z0-9_]` before joining (mirroring sanitizeName).
  it('Fix #5: sanitizes ProductCode segments in the generated fallback CML API name', async () => {
    // No existing ConstraintModel and no discovered API — the command will reach the generated-name
    // fallback path inside discoverCmlApi, log it, then later error because no model exists. We
    // assert on the LOGGED fallback name, which is what would otherwise become the file name.
    stubOrgConnection({
      existingCml: undefined,
      productCodes: [
        // A ProductCode with characters that would corrupt the generated file path / SOQL identifier
        // if pasted in verbatim — Fix #5 sanitizes them to underscores before joining.
        { Id: '01tROOT00000000001', ProductCode: 'auto/silver "v1"', Name: null },
      ],
      productTypeTags: [],
    });
    await writeSurchargeFile([
      {
        Id: 'a0p000000000001',
        Name: 'Collision Fee',
        ProductPath: '01tROOT00000000001',
        RuleDefinition: ruleDefinition('CollisionFee', []),
      },
    ]);

    try {
      await runCommandNoCmlApi();
    } catch {
      // The command errors after the fallback name is logged (no curated model exists). The error
      // itself isn't what this test cares about — we assert on the fallback's log line.
    }

    const logs = logOutput();
    // The unsafe characters from the ProductCode never reach the generated name.
    expect(logs).to.match(/Generated new CML API name: SC_auto_silver__v1_/);
    expect(logs).to.not.match(/Generated new CML API name:.*\//);
    expect(logs).to.not.match(/Generated new CML API name:.*"/);
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
