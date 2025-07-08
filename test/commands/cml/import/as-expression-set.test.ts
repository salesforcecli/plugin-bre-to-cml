/*
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import CmlImportAsExpressionSet from '../../../../src/commands/cml/import/as-expression-set.js';

describe('cml import as-expression-set', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('runs hello', async () => {
    await CmlImportAsExpressionSet.run([
      '--target-org',
      'test@example.com',
      '--context-definition',
      'test-context',
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
    const result = await CmlImportAsExpressionSet.run([
      '--target-org',
      'test@example.com',
      '--context-definition',
      'test-context',
      '--cml-api',
      'test-api',
      '--workspace-dir',
      'data',
    ]);
    expect(result.path).to.equal('src/commands/cml/import/as-expression-set.ts');
  });

  it('runs hello world --name Astro', async () => {
    await CmlImportAsExpressionSet.run([
      '--target-org',
      'test@example.com',
      '--context-definition',
      'test-context',
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
