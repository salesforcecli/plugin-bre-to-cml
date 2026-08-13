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
import { ConfirmText, confirmOrThrow } from '../../../src/shared/insurance/confirm-org-changes.js';

type Harness = {
  warnings: string[];
  prompts: Array<{ message: string; defaultAnswer?: boolean; ms?: number }>;
  host: {
    warn(message: string): unknown;
    confirm(options: { message: string; ms?: number; defaultAnswer?: boolean }): Promise<boolean>;
  };
};

const harness = (answer: boolean): Harness => {
  const warnings: string[] = [];
  const prompts: Array<{ message: string; defaultAnswer?: boolean; ms?: number }> = [];
  return {
    warnings,
    prompts,
    host: {
      warn: (message: string) => warnings.push(message),
      confirm: (options) => {
        prompts.push(options);
        return Promise.resolve(answer);
      },
    },
  };
};

const text: ConfirmText = {
  skippingPrompt: 'Proceeding without confirmation because --no-prompt was passed.',
  confirmApply: 'Apply these changes to the org',
  confirmationRequired: () => new Error('confirmation required'),
  aborted: () => new Error('aborted'),
};

const expectRejects = async (promise: Promise<unknown>, match: RegExp): Promise<void> => {
  let error: Error | undefined;
  try {
    await promise;
  } catch (e) {
    error = e as Error;
  }
  expect(error, 'expected the gate to reject').to.be.an('error');
  expect(error?.message).to.match(match);
};

describe('confirm-org-changes confirmOrThrow', () => {
  it('prompts and proceeds when the operator confirms', async () => {
    const h = harness(true);
    await confirmOrThrow(h.host, { noPrompt: false, interactive: true }, text);

    expect(h.prompts).to.have.length(1);
    expect(h.prompts[0].message).to.equal('Apply these changes to the org');
    // The prompt must never default to "yes" — an unanswered prompt must not mutate the org.
    expect(h.prompts[0].defaultAnswer).to.equal(false);
  });

  it('aborts when the operator declines', async () => {
    const h = harness(false);
    await expectRejects(confirmOrThrow(h.host, { noPrompt: false, interactive: true }, text), /aborted/);
  });

  it('skips the prompt under --no-prompt, but says so out loud', async () => {
    const h = harness(false);
    await confirmOrThrow(h.host, { noPrompt: true, interactive: true }, text);

    expect(h.prompts).to.deep.equal([]);
    expect(h.warnings.join('\n')).to.match(/without confirmation/);
  });

  it('fails fast when non-interactive rather than stalling on an unanswerable prompt', async () => {
    const h = harness(true);
    await expectRejects(confirmOrThrow(h.host, { noPrompt: false, interactive: false }, text), /confirmation required/);
    expect(h.prompts, 'must not enter a prompt nobody can answer').to.deep.equal([]);
  });

  it('lets --no-prompt through even when non-interactive (the automation path)', async () => {
    const h = harness(false);
    await confirmOrThrow(h.host, { noPrompt: true, interactive: false }, text);
    expect(h.prompts).to.deep.equal([]);
  });
});
