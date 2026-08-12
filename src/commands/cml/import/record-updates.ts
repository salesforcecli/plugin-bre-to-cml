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
import * as fs from 'node:fs/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { RecordUpdatePlan } from '../../../shared/insurance/models.js';
import {
  JSON_BLOB_FIELD,
  formatBlobChange,
  formatBlobSummary,
  parseRecordUpdatePlan,
} from '../../../shared/insurance/record-update-plan.js';
import {
  PlannedRecordChange,
  applyRecordUpdates,
  planRecordUpdates,
  verifySurchargeUpdates,
} from '../../../shared/insurance/record-update-apply.js';
import {
  NO_VALUE,
  PlannedChange,
  PlannedChangeCounts,
  countPlannedChanges,
  formatChange,
  renderPlannedChanges,
  truncateCell,
} from '../../../shared/insurance/planned-change.js';
import { confirmOrThrow } from '../../../shared/insurance/confirm-org-changes.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-bre-to-cml', 'cml.import.record-updates');

export type RecordUpdateSkipResult = {
  id: string;
  field: string;
  reason: string;
};

export type RecordUpdateFailureResult = {
  id: string;
  errors: string[];
  /** True when the request failed after it was sent, so the org may or may not hold the change. */
  outcomeUnknown: boolean;
};

export type CmlImportRecordUpdatesResult = {
  file: string;
  kind: RecordUpdatePlan['kind'];
  cmlApi: string;
  dryRun: boolean;
  /** Every field-level change the command resolved from a fresh org re-read, including skips. */
  plannedChanges: PlannedChange[];
  /**
   * Pre-write counts over `plannedChanges` — exactly the numbers the operator was shown before
   * confirming, in the same field-level unit. Populated on every run that gets as far as the
   * preview, including `--dry-run`, so a `--json` consumer never has to re-derive them from
   * `plannedChanges` or scrape the display text.
   */
  plannedCounts: {
    updates: number;
    alreadyCurrent: number;
  };
  /** Records written. */
  applied: number;
  skipped: RecordUpdateSkipResult[];
  failed: RecordUpdateFailureResult[];
};

/**
 * Applies a `<cmlApi>_{Surcharge,Underwriting}Update.json` plan to the org.
 *
 * One unified importer keyed off the file's `kind`, per the export/review/import design recorded on
 * work item W-23654540 (§3): both files share an envelope, and the
 * per-kind differences (allowed fields, the underwriting blob compare, the surcharge RuleKey
 * verification) are data-driven rather than separate commands.
 */
export default class CmlImportRecordUpdates extends SfCommand<CmlImportRecordUpdatesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    file: Flags.file({
      summary: messages.getMessage('flags.file.summary'),
      char: 'f',
      required: true,
      exists: true,
    }),
    'no-prompt': Flags.boolean({
      summary: messages.getMessage('flags.no-prompt.summary'),
      char: 'p',
      default: false,
    }),
    'dry-run': Flags.boolean({
      summary: messages.getMessage('flags.dry-run.summary'),
      default: false,
    }),
  };

  public async run(): Promise<CmlImportRecordUpdatesResult> {
    const { flags } = await this.parse(CmlImportRecordUpdates);
    const file = flags.file;
    const targetOrg = flags['target-org'];
    const username = targetOrg.getUsername() ?? 'unknown';
    const dryRun = flags['dry-run'];

    const plan = await this.loadPlan(file);

    this.log(`Target org: ${username}`);
    this.log(`File: ${file}`);
    this.log(`Kind: ${plan.kind}`);
    this.log(`CML API: ${plan.cmlApi}`);
    this.log(`Updates: ${plan.updates.length}`);

    const result: CmlImportRecordUpdatesResult = {
      file,
      kind: plan.kind,
      cmlApi: plan.cmlApi,
      dryRun,
      plannedChanges: [],
      plannedCounts: { updates: 0, alreadyCurrent: 0 },
      applied: 0,
      skipped: [],
      failed: [],
    };

    // An empty plan is a valid "nothing to do" — convert always emits the file, even with zero
    // records — so it is a logged no-op, not a prompt and not an error.
    if (plan.updates.length === 0) {
      this.log(messages.getMessage('info.nothingToApply'));
      return result;
    }

    const conn = targetOrg.getConnection(flags['api-version']);

    // Read phase: everything below happens before a single write, so the operator sees the real
    // current-vs-new values and identity problems are caught before they can corrupt a record.
    const { changes, identityErrors, advisories } = await planRecordUpdates(conn, plan);
    if (identityErrors.length > 0) {
      throw messages.createError('error.recordIdentityMismatch', [identityErrors.map((e) => `  ${e}`).join('\n')]);
    }

    result.plannedChanges = changes.map(toPlannedChange);
    result.skipped = changes.filter((c) => c.alreadyCurrent).map(toSkipResult);

    const counts = this.renderPreview(result.plannedChanges, username, dryRun);
    result.plannedCounts = { updates: counts.updates, alreadyCurrent: counts.skips };
    for (const advisory of advisories) this.warn(advisory);

    if (dryRun) {
      this.log(messages.getMessage('info.dryRun'));
      return result;
    }

    // Two independent reasons the prompt cannot run, kept apart so the error names the real one.
    // Under --json the suppression is deliberate, not a property of the terminal: `confirm` against
    // an unanswerable stdin writes prompt text to stdout and throws, which would corrupt the JSON
    // stream. An operator sitting at a real terminal must not be told their terminal is the problem
    // and sent to "run interactively", which they already are.
    const jsonMode = this.jsonEnabled();
    const ttyInteractive = Boolean(process.stdout.isTTY && process.stdin.isTTY);

    await confirmOrThrow(
      this,
      {
        noPrompt: flags['no-prompt'],
        interactive: ttyInteractive && !jsonMode,
      },
      {
        skippingPrompt: messages.getMessage('warn.skippingPrompt'),
        confirmApply: messages.getMessage('confirm.apply'),
        confirmationRequired: () =>
          messages.createError(jsonMode ? 'error.confirmationRequiredJson' : 'error.confirmationRequired'),
        aborted: () => messages.createError('error.aborted'),
      }
    );

    const { applied, failures } = await applyRecordUpdates(conn, changes);
    result.applied = applied;
    result.failed = failures.map((f) => ({ id: f.id, errors: f.errors, outcomeUnknown: f.outcomeUnknown }));
    for (const failure of failures) {
      const detail = failure.errors.join('; ') || 'unknown error';
      this.warn(
        failure.outcomeUnknown
          ? messages.getMessage('warn.outcomeUnknown', [failure.name, failure.id, detail])
          : `FAILED ${failure.name} (${failure.id}): ${detail}`
      );
    }

    // The flip regenerates ProductSurcharge.RuleKey server-side; read it back so the operator can
    // see whether the surcharge will actually fire. Advisory only — the writes already succeeded.
    if (plan.kind === 'surcharge-update') {
      const verification = await verifySurchargeUpdates(conn, plan.updates);
      for (const record of verification.records) {
        this.log(
          `  ${record.Id} ${record.Name}: RuleEngineType=${record.RuleEngineType ?? '<none>'} RuleKey=${
            record.RuleKey ?? '<none>'
          } RuleApiName=${record.RuleApiName ?? '<none>'}`
        );
      }
      for (const warning of verification.warnings) this.warn(warning);
    }

    // All three counts are records. `result.skipped` is deliberately field-level for the JSON
    // result, so it cannot be presented as a peer of `applied` and `failures.length`, which are not.
    const skippedRecords = new Set(changes.filter((c) => c.alreadyCurrent).map((c) => c.update.id));
    for (const change of changes) if (!change.alreadyCurrent) skippedRecords.delete(change.update.id);
    this.log(messages.getMessage('info.applySummary', [applied, skippedRecords.size, failures.length]));

    if (failures.length > 0) {
      const error = messages.createError(
        'error.applyFailures',
        [failures.length],
        [`sf cml import record-updates --file ${file} --target-org ${username}`]
      );
      // The apply is not transactional, so a throw discards a result that describes a real,
      // partially-migrated org. Under --json the count alone leaves automation nothing to act on.
      error.data = result;
      throw error;
    }

    return result;
  }

  /**
   * Renders the read-only preview the operator consents to, and returns the counts it displayed.
   *
   * `countPlannedChanges` is shared and buckets all five operations, but `toPlannedChange` emits
   * only 'Update' and 'Skip (already current)'. Reporting the create/reuse buckets here would print
   * two permanent zeros AND contradict the skip count: "0 already current (reused)" immediately
   * followed by "N to skip" — where those N are skipped precisely because they ARE current. This is
   * the last line the operator reads before authorizing writes, so it names only the two outcomes
   * this command can actually produce.
   */
  private renderPreview(changes: PlannedChange[], username: string, dryRun: boolean): PlannedChangeCounts {
    const counts = countPlannedChanges(changes);
    renderPlannedChanges(this, changes, {
      header: messages.getMessage('warn.header', [username]),
      summary: messages.getMessage('warn.summary', [counts.updates, counts.skips, username]),
      // A dry run writes nothing, so there is no partial-migration hazard to caution about. Warning
      // anyway would put boilerplate in every --json run's `warnings` array, where the ProductCode
      // drift advisory and the per-record save failures need to stand out.
      notTransactional: dryRun ? undefined : messages.getMessage('warn.notTransactional'),
    });
    return counts;
  }

  private async loadPlan(file: string): Promise<RecordUpdatePlan> {
    let raw: string;
    try {
      // --file only proves the path exists; a directory, or a file the user cannot read, still
      // reaches here and must surface as an SfError with actions, not a raw Node error.
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      throw messages.createError('error.unreadableFile', [file, (e as Error).message]);
    }
    try {
      return parseRecordUpdatePlan(raw, file, { onWarn: (message) => this.warn(message) });
    } catch (e) {
      throw messages.createError('error.invalidFile', [(e as Error).message]);
    }
  }
}

function toPlannedChange(change: PlannedRecordChange): PlannedChange {
  return {
    operation: change.alreadyCurrent ? 'Skip (already current)' : 'Update',
    object: change.update.sobject,
    id: change.update.id,
    name: change.update.name,
    field: change.field.field,
    change: describeChange(change),
    currentValue: change.currentValue,
    newValue: change.field.value,
  };
}

/**
 * Builds the operator-facing `Change` cell. `DynamicRuleDefinition` is rendered as a semantic diff
 * of the fields convert mutates, because the raw blob's first 60 characters are identical before
 * and after — a truncated raw diff shows the operator the same string twice.
 */
function describeChange(change: PlannedRecordChange): string {
  const isBlob = change.field.field === JSON_BLOB_FIELD;
  if (change.alreadyCurrent) {
    const summary = isBlob ? formatBlobSummary(change.currentValue) : undefined;
    return `${summary ?? truncateCell(change.currentValue ?? NO_VALUE)} (unchanged)`;
  }
  const semantic = isBlob ? formatBlobChange(change.currentValue, change.field.value) : undefined;
  return semantic ?? formatChange(change.currentValue, change.field.value);
}

function toSkipResult(change: PlannedRecordChange): RecordUpdateSkipResult {
  return {
    id: change.update.id,
    field: change.field.field,
    reason: 'org already matches the requested value',
  };
}
