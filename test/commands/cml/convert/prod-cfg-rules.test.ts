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


const extractTypesMapUsingRegex = async (resultPath: string): Promise<Map<string, string[]>> => {
  const resultCml = await fs.readFile(resultPath, 'utf8');
  const typesMap = new Map<string, string[]>();
  const typeRegex = new RegExp('type\\s+(?<typeName>\\w+)(?:\\s*:\\s*(?<parentType>\\w+))?\\s*(?:\\{(?<typeBody>[^}]*)\\}|;)\\s*', 'gm');
  let regexResult: RegExpExecArray | null = null;
  while ((regexResult = typeRegex.exec(resultCml)) !== null) {
    const groups = regexResult.groups!;
    typesMap.set(groups['typeName'], groups['typeBody']?.split('\n')?.filter(line => line.trim().length > 0)?.map(line => line.trim()) ?? []);
  }

  return typesMap;
}

// return [cml body as string, cml body lines as string[]]
const expectTypeAndGetLines = (typesMap: Map<string, string[]>, typeName: string): [string, string[]] => {
  const targetTypeLines = typesMap.get(typeName);
  expect(targetTypeLines).to.not.be.null;
  return [targetTypeLines!.join(' '), targetTypeLines!];
}

const executeConvertCommand = async (ticketNumber: string, cmlApiName: string, sfCommandStubs: ReturnType<typeof stubSfCommandUx>) => {
  const result = await CmlConvertProdCfgRules.run([
    '--target-org',
    'test@example.com',
    '--pcr-file',
    `data/test/${ticketNumber}/ProductConfigurationRules.json`,
    '--products-file',
    `data/test/${ticketNumber}/ProductsMap.json`,
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

  return result;
}

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
    const result = await executeConvertCommand('W-19783372', 'TestApiW19783372', sfCommandStubs);

    const typesMap = await extractTypesMapUsingRegex(result.path);

    const [laptopProBundleType, laptopProBundleTypeLines] = expectTypeAndGetLines(typesMap, 'LaptopProBundle');
    expect(laptopProBundleTypeLines).to.include('constraint lpb_gk_criteria_1 = ((laptop1[Laptop] > 0) && laptop1[Laptop].Memory == "RAM 64GB");');
    // LaptopProBundle should not contain constraint expression to Laptop.Memory through laptopbasicbundle[LaptopBasicBundle]
    expect(laptopProBundleType).to.not.include('laptopbasicbundle[LaptopBasicBundle].laptop[Laptop].Memory');
  });

  it('tests W-19785067', async () => {
    const result = await executeConvertCommand('W-19785067', 'TestApiW19785067', sfCommandStubs);

    const typesMap = await extractTypesMapUsingRegex(result.path);

    const [laptopProductivityBundleType, laptopProductivityBundleTypeLines] = expectTypeAndGetLines(typesMap, 'LaptopProductivityBundle');
    expect(laptopProductivityBundleTypeLines).to.include('boolean lpb_vr_criteria_1_value;');
    expect(laptopProductivityBundleTypeLines).to.include('constraint((lpb_vr_criteria_1) == lpb_vr_criteria_1_value);');
    // LaptopProductivityBundle should not contain rule for Laptop attribute Graphics
    expect(laptopProductivityBundleType).to.not.include('"Hide", "attribute", "Graphics");');
    // LaptopProductivityBundle should not contain rule for Laptop attribute Windows_Processor
    expect(laptopProductivityBundleType).to.not.include('"Disable", "attribute", "Windows_Processor", "value", ["i7-CPU 4.7GHz", "Intel Core i9 5.2 GHz"]);');
    // LaptopProductivityBundle should not contain rule for Printer attribute Printer
    expect(laptopProductivityBundleType).to.not.include('"Hide", "attribute", "Printer", "value", "Laser");');

    const [, laptopTypeLines] = expectTypeAndGetLines(typesMap, 'Laptop');
    expect(laptopTypeLines).to.include('boolean parent_lpb_vr_criteria_1_value = parent(lpb_vr_criteria_1_value);');
    expect(laptopTypeLines).to.include('rule(parent_lpb_vr_criteria_1_value == true, "Hide", "attribute", "Graphics");');
    expect(laptopTypeLines).to.include('rule(parent_lpb_vr_criteria_1_value == true, "Disable", "attribute", "Windows_Processor", "value", ["i7-CPU 4.7GHz", "Intel Core i9 5.2 GHz"]);');

    const [, printerTypeLines] = expectTypeAndGetLines(typesMap, 'Printer');
    expect(printerTypeLines).to.include('boolean parent_lpb_vr_criteria_1_value = parent(lpb_vr_criteria_1_value);');
    expect(printerTypeLines).to.include('rule(parent_lpb_vr_criteria_1_value == true, "Hide", "attribute", "Printer", "value", "Laser");');
  });

  it('tests W-19786482', async () => {
    const result = await executeConvertCommand('W-19786482', 'TestApiW19786482', sfCommandStubs);

    const typesMap = await extractTypesMapUsingRegex(result.path);

    const [, desktopTypeLines] = expectTypeAndGetLines(typesMap, 'Desktop');
    expect(desktopTypeLines).to.include('message(desktopp_criteria_1, "SetAttribute: 2k screen selected. and 27\\"", "Info");');
  });

  it('tests W-19996586', async () => {
    const result = await executeConvertCommand('W-19996586', 'TestApiW19996586', sfCommandStubs);

    const typesMap = await extractTypesMapUsingRegex(result.path);

    const [, laptopProBundleTypeLines] = expectTypeAndGetLines(typesMap, 'LaptopProBundle');
    // check if we have generated SellingModelType attribute and tagName annotation
    expect(laptopProBundleTypeLines).to.include('@(tagName = "SellingModelType")');
    expect(laptopProBundleTypeLines).to.include('string SellingModelType;');
    const smtAttrIndex = laptopProBundleTypeLines.findIndex(line => line.includes('string SellingModelType;'));
    const smtAnnotationIndex = laptopProBundleTypeLines.findIndex(line => line.includes('@(tagName = "SellingModelType")'));
    // tagName annotation should be defined before SellingModelType attribute
    expect(smtAnnotationIndex).to.equal(smtAttrIndex - 1);
  });
});
