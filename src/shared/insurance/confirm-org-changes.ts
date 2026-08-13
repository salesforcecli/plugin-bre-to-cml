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

/**
 * The confirmation gate for the org-mutating insurance import commands
 * (export/review/import design, work item W-23654540 §4). Callers MUST have rendered the full
 * PlannedChange[] — built from read-only operations — before calling this, and MUST NOT issue any
 * write until it resolves.
 *
 * Used today by `insurance import record-updates`; the matrix is command-agnostic, so
 * `cml import as-expression-set` can gate on it when that work lands (§7 step 12).
 */

/** Minimal surface the gate needs, so it is unit-testable without oclif. */
export type ConfirmHost = {
  warn(message: string): unknown;
  confirm(options: { message: string; ms?: number; defaultAnswer?: boolean }): Promise<boolean>;
};

export type ConfirmOptions = {
  noPrompt: boolean;
  /**
   * Whether a human can actually answer. Callers pass
   * `process.stdout.isTTY && process.stdin.isTTY && !this.jsonEnabled()`.
   */
  interactive: boolean;
};

export type ConfirmText = {
  /** Warning emitted when `--no-prompt` bypasses the gate. */
  skippingPrompt: string;
  /** The confirmation question (no question mark, no Y/N — `confirm` adds those). */
  confirmApply: string;
  /**
   * Built lazily: the prompt could not run and `--no-prompt` was not passed. Must carry remediation
   * actions, and must name which cause applied — a terminal that cannot prompt and a `--json` run
   * that must not prompt need different remediation.
   */
  confirmationRequired: () => Error;
  /** Built lazily: the operator answered "no". */
  aborted: () => Error;
};

/** How long to wait for an answer before falling back to the (negative) default. */
const CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Applies the confirmation matrix. Returns normally only when the caller may proceed to write.
 *
 * A non-interactive invocation without `--no-prompt` fails fast instead of prompting: `confirm`
 * does not throw on timeout, it returns `defaultAnswer` (false) after `ms`, which in CI reads as a
 * 30-second hang followed by a silent abort. Detecting up front turns that into an immediate,
 * actionable error.
 */
export async function confirmOrThrow(host: ConfirmHost, options: ConfirmOptions, text: ConfirmText): Promise<void> {
  if (options.noPrompt) {
    host.warn(text.skippingPrompt);
    return;
  }

  if (!options.interactive) {
    throw text.confirmationRequired();
  }

  const proceed = await host.confirm({
    message: text.confirmApply,
    defaultAnswer: false,
    ms: CONFIRM_TIMEOUT_MS,
  });
  if (!proceed) {
    throw text.aborted();
  }
}
