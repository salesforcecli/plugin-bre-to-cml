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
 * The "what is about to change in the org" preview for the insurance import commands
 * (export/review/import design, work item W-23654540 §4): an org-mutating import builds the
 * complete PlannedChange[] from read-only operations, renders it, and only then prompts — so an
 * operator always sees the exact field-level changes before anything is written.
 *
 * Used today by `cml import record-updates`. Nothing here is specific to record updates, so
 * `cml import as-expression-set` can render its own plan through it when its gate lands (§7 step 12).
 */

/** Column values are rendered verbatim, so keep the vocabulary closed and stable. */
export type PlannedChangeOperation =
  | 'Create'
  | 'Update'
  | 'Reuse'
  | 'Skip (already current)'
  | 'Create (UNRESOLVED FK)';

export type PlannedChange = {
  operation: PlannedChangeOperation;
  /** sObject type, e.g. 'ProductSurcharge'. */
  object: string;
  /** Record id, or `NO_ID` for a create (the id does not exist yet). */
  id: string;
  name: string;
  field: string;
  /** `old → new`, truncated (and, for JSON blobs, reduced to the mutated fields) for display. */
  change: string;
  /**
   * Untruncated current org value, from the same fresh re-read `change` was built from. `change`
   * is a display string, so `--json` consumers need the real values to diff or audit against.
   * Absent for operations that have no current value, e.g. a create.
   */
  currentValue?: string | null;
  /** Untruncated value that will be written. Absent when the operation writes no single value. */
  newValue?: string;
};

/** Placeholder shown in the Id column for records that do not exist yet. */
export const NO_ID = '—';

/** Placeholder shown when a field currently has no value in the org. */
export const NO_VALUE = '(none)';

/** Table cells are truncated so an opaque blob (e.g. DynamicRuleDefinition) stays readable. */
const MAX_CELL_LENGTH = 60;

/**
 * Minimal surface the renderer needs, so this module is unit-testable without oclif. Declared with
 * method syntax so an `SfCommand` (whose `table` is generic) satisfies it.
 */
export type PlannedChangeRenderer = {
  styledHeader(text: string): void;
  table(options: { data: Array<Record<string, unknown>> }): void;
  log(message: string): void;
  warn(message: string): unknown;
};

export function truncateCell(value: string, max = MAX_CELL_LENGTH): string {
  if (value.length <= max) return value;
  // `max - 1` goes negative for max < 1, which would slice from the END of the string and return
  // something longer than the budget. The ellipsis alone is the smallest honest rendering.
  const keep = Math.max(max - 1, 0);
  let head = value.slice(0, keep);
  // Never emit the high half of a surrogate pair on its own — it renders as a replacement glyph.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** Renders a single field-level change as `old → new`, with both sides truncated. */
export function formatChange(currentValue: string | null | undefined, newValue: string): string {
  const before = currentValue == null || currentValue === '' ? NO_VALUE : currentValue;
  return `${truncateCell(before)} → ${truncateCell(newValue)}`;
}

export type PlannedChangeCounts = {
  creates: number;
  updates: number;
  reuses: number;
  skips: number;
};

export function countPlannedChanges(changes: PlannedChange[]): PlannedChangeCounts {
  return {
    creates: changes.filter((c) => c.operation.startsWith('Create')).length,
    updates: changes.filter((c) => c.operation === 'Update').length,
    reuses: changes.filter((c) => c.operation === 'Reuse').length,
    skips: changes.filter((c) => c.operation === 'Skip (already current)').length,
  };
}

export type PlannedChangeText = {
  /** Header line, e.g. `These changes will be applied to <username>`. */
  header: string;
  /** One-line count summary. */
  summary: string;
  /**
   * The explicit non-transactional notice (§4). Changes are applied in order and are NOT rolled
   * back, so a mid-apply failure can leave the org partially migrated — the operator must be told
   * this before confirming, not after a failure.
   *
   * Omit on a path that will not write (e.g. `--dry-run`). A caution about a hazard that cannot
   * occur is noise, and it dilutes the warnings that describe real ones.
   */
  notTransactional?: string;
};

/**
 * Renders the preview: styled header, one row per field-level change, the count summary, and — only
 * when the caller is on a path that will write — the non-transactional notice.
 *
 * The summary goes to `log`, not `warn`, on purpose. `warn` is not merely a louder `log`: it writes
 * to stderr, so under `--dry-run` (whose entire output IS the summary) redirecting stdout to a file
 * drops it; and `SfCommand.warn` pushes unconditionally to the `warnings` array, so emitting
 * boilerplate through it makes every successful `--json` run return a non-empty `warnings`, which
 * both trips consumers that treat `warnings.length > 0` as a problem signal and buries the genuine
 * warnings (ProductCode drift, per-record save failures) among the routine ones.
 */
export function renderPlannedChanges(
  renderer: PlannedChangeRenderer,
  changes: PlannedChange[],
  text: PlannedChangeText
): void {
  renderer.styledHeader(text.header);
  renderer.table({
    data: changes.map((c) => ({
      Operation: c.operation,
      Object: c.object,
      Id: c.id,
      Name: c.name,
      Field: c.field,
      Change: c.change,
    })),
  });
  renderer.log(text.summary);
  if (text.notTransactional !== undefined) renderer.warn(text.notTransactional);
}
