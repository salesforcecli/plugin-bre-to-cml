/*
 * Copyright 2025, Salesforce, Inc.
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

  it('tests W-19783372', async () => {
    const cmlApiName = 'TestApiProductScopeW19783372';
    const result = await CmlConvertProdCfgRules.run([
      '--target-org',
      'test@example.com',
      '--pcr-file',
      'data/test/W-19783372/ProductConfigurationRules.json',
      '--products-file',
      'data/test/W-19783372/ProductsMap.json',
      '--cml-api',
      cmlApiName,
      '--workspace-dir',
      'data',
    ]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Using Target Org: test@example.com');
    expect(result.path).to.equal(`data/${cmlApiName}_0.cml`);
    const resultCml = await fs.readFile(result.path, 'utf8');
    const typeRegexStr = '^\\s*type (?<typeName>[a-zA-Z0-9_]+)\\s*';
    const typesMap = new Map<string, string[]>();
    let typeBody: string[] = [];
    for (const line of resultCml.split('\n')) {
      const regex = new RegExp(typeRegexStr);
      if (regex.test(line)) {
        const regexResult = regex.exec(line);
        const typeName = regexResult?.groups?.['typeName']
        expect(typeName).to.not.be.null;
        typeBody = [];
        typesMap.set(typeName!, typeBody);
      }
      typeBody.push(line);
    }

    const laptopProBundleType = typesMap.get('LaptopProBundle');
    expect(laptopProBundleType).to.not.be.null;
    expect(laptopProBundleType!.some(line => line.includes('constraint lpb_gk_criteria_1 = ((laptop1[Laptop] > 0) && laptop1[Laptop].Memory == "RAM 64GB");')));
    // LaptopProBundle should not contain constraint expression to Laptop.Memory through laptopbasicbundle[LaptopBasicBundle]
    expect(laptopProBundleType!.every(line => !line.includes('laptopbasicbundle[LaptopBasicBundle].laptop[Laptop].Memory')))
  });
});
