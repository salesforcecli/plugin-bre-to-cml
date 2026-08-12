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
 * Shared "what is about to change in the org" preview, used by the gated import commands
 * (see docs/insurance-export-review-import-redesign.md §4). Every org-mutating import builds the
 * complete PlannedChange[] from read-only operations, renders it, and only then prompts — so an
 * operator always sees the exact field-level changes before anything is written.
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
  /** `old → new`, both truncated for display. The `old` side is always a fresh re-read. */
  change: string;
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
  warn(message: string): unknown;
};

export function truncateCell(value: string, max = MAX_CELL_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
   */
  notTransactional: string;
};

/**
 * Renders the preview: styled header, one row per field-level change, then the count summary and
 * the non-transactional notice as warnings (so they also ride the `--json` `warnings` array while
 * the table itself is suppressed).
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
  renderer.warn(text.summary);
  renderer.warn(text.notTransactional);
}
