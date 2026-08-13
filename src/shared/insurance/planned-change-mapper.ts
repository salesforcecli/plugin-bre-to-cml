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
 * Turns the apply layer's {@link PlannedRecordChange} into the shapes the operator and a `--json`
 * consumer see. Kept out of `planned-change.ts` because rendering a blob change needs
 * `record-update-plan.ts`, which already imports `planned-change.ts` — putting these there would
 * close an import cycle.
 */
import { PlannedRecordChange } from './record-update-apply.js';
import { JSON_BLOB_FIELD, formatBlobChange, formatBlobSummary } from './record-update-plan.js';
import { NO_VALUE, PlannedChange, formatChange, truncateCell } from './planned-change.js';

export type RecordUpdateSkipResult = {
  id: string;
  field: string;
  reason: string;
};

export function toPlannedChange(change: PlannedRecordChange): PlannedChange {
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

export function toSkipResult(change: PlannedRecordChange): RecordUpdateSkipResult {
  return {
    id: change.update.id,
    field: change.field.field,
    reason: 'org already matches the requested value',
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
