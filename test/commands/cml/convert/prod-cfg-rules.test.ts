/*
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import CmlConvertProdCfgRules from '../../../../src/commands/cml/convert/prod-cfg-rules.js';

describe('cml convert prod-cfg-rules', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('runs hello', async () => {
    await CmlConvertProdCfgRules.run([
      '--target-org',
      'test@example.com',
      '--pcr-file',
      'data/ProductConfigurationRules.json',
      '--cml-api',
      'test-api',
      '--workspace-dir',
      'data',
    ]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Using Target Org: test@example.com');
  });

  it('runs hello with --json and no provided name', async () => {
    const result = await CmlConvertProdCfgRules.run([
      '--target-org',
      'test@example.com',
      '--pcr-file',
      'data/ProductConfigurationRules.json',
      '--cml-api',
      'test-api',
      '--workspace-dir',
      'data',
    ]);
    expect(result.path).to.equal('src/commands/cml/convert/prod-cfg-rules.ts');
  });

  it('runs hello world --name Astro', async () => {
    await CmlConvertProdCfgRules.run([
      '--target-org',
      'test@example.com',
      '--pcr-file',
      'data/ProductConfigurationRules.json',
      '--cml-api',
      'test-api',
      '--workspace-dir',
      'data',
    ]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Using Target Org: test@example.com');
  });
});
*/
