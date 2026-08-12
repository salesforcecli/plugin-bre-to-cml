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
 * Load + validate side of `sf cml import record-updates`
 * (docs/insurance-export-review-import-redesign.md §3, §8).
 *
 * The `<safeApi>_{Underwriting,Surcharge}Update.json` file is explicitly meant to be reviewed and
 * hand-corrected before it is applied, so everything here treats it as untrusted input: the whole
 * file is rejected on any structural violation, before a single write. Passing the id regex is NOT
 * identity proof — the apply-time Name cross-check (record-update-apply.ts) is the real guard
 * against writing to a valid-but-wrong record.
 */
import { RecordUpdate, RecordUpdateField, RecordUpdatePlan } from './models.js';
import { NO_VALUE, truncateCell } from './planned-change.js';

export const RECORD_UPDATE_KINDS: ReadonlyArray<RecordUpdatePlan['kind']> = ['underwriting-update', 'surcharge-update'];

/**
 * Fields each sObject is allowed to set, matching what convert emits. Anything else in the file is
 * a hand-edit gone wrong (or a file from a newer plugin) and is refused rather than written.
 */
export const ALLOWED_FIELDS: Readonly<Record<RecordUpdate['sobject'], readonly string[]>> = {
  UnderwritingRuleGroup: ['RuleEngineType'],
  UnderwritingRule: ['DynamicRuleDefinition'],
  ProductSurcharge: ['RuleEngineType'],
};

/**
 * Apply order across sObject types. `UnderwritingRuleGroup` must precede `UnderwritingRule` to
 * preserve the ordering the original live convert path used.
 */
export const SOBJECT_APPLY_ORDER: ReadonlyArray<RecordUpdate['sobject']> = [
  'UnderwritingRuleGroup',
  'UnderwritingRule',
  'ProductSurcharge',
];

const SALESFORCE_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** The one field whose value is itself a JSON document, so it needs structural (not raw) compare. */
export const JSON_BLOB_FIELD = 'DynamicRuleDefinition';

/** Thrown for any structural violation; the command turns it into `error.invalidFile`. */
export class RecordUpdatePlanError extends Error {}

const fail = (source: string, detail: string): never => {
  throw new RecordUpdatePlanError(`${source}: ${detail}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export type ParsePlanOptions = {
  /** Non-fatal notices, e.g. a `DynamicRuleDefinition` value that does not parse as JSON. */
  onWarn?: (message: string) => void;
};

/**
 * Parses and structurally validates a record-update file. `source` is the file path, used only to
 * make error messages point at the offending file.
 */
export function parseRecordUpdatePlan(raw: string, source: string, options: ParsePlanOptions = {}): RecordUpdatePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(source, `not valid JSON (${(e as Error).message})`);
  }

  if (!isRecord(parsed)) fail(source, 'expected a top-level JSON object');
  const plan = parsed as Record<string, unknown>;

  if (plan.schemaVersion !== 1) {
    fail(source, `unsupported schemaVersion ${JSON.stringify(plan.schemaVersion) ?? '<missing>'} (expected 1)`);
  }

  const kind = plan.kind;
  if (typeof kind !== 'string' || !RECORD_UPDATE_KINDS.includes(kind as RecordUpdatePlan['kind'])) {
    fail(
      source,
      `unsupported kind ${JSON.stringify(kind) ?? '<missing>'} (expected one of ${RECORD_UPDATE_KINDS.join(', ')})`
    );
  }

  if (!isNonEmptyString(plan.cmlApi)) fail(source, 'missing or non-string cmlApi');
  if (!Array.isArray(plan.updates)) fail(source, 'updates must be an array');

  const updates = (plan.updates as unknown[]).map((u, i) => parseUpdate(u, source, i, options));

  return {
    schemaVersion: 1,
    kind: kind as RecordUpdatePlan['kind'],
    cmlApi: plan.cmlApi as string,
    generatedAt: typeof plan.generatedAt === 'string' ? plan.generatedAt : '',
    updates,
  };
}

function parseUpdate(value: unknown, source: string, index: number, options: ParsePlanOptions): RecordUpdate {
  const at = `updates[${index}]`;
  if (!isRecord(value)) return fail(source, `${at} is not an object`);

  const sobject = value.sobject;
  if (typeof sobject !== 'string' || !(sobject in ALLOWED_FIELDS)) {
    fail(source, `${at} has unsupported sobject ${JSON.stringify(sobject) ?? '<missing>'}`);
  }
  const typedSobject = sobject as RecordUpdate['sobject'];

  if (typeof value.id !== 'string' || !SALESFORCE_ID_PATTERN.test(value.id)) {
    fail(source, `${at} has a malformed Salesforce id ${JSON.stringify(value.id) ?? '<missing>'}`);
  }
  // `name` is a required verification key, not cosmetic: the apply cross-checks it against the org
  // so an edited id cannot silently retarget a valid-but-wrong record of the same type.
  if (!isNonEmptyString(value.name)) fail(source, `${at} (${value.id as string}) is missing a non-empty name`);

  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    fail(source, `${at} (${value.name as string}) must have at least one field`);
  }

  const fields = (value.fields as unknown[]).map((f, fi) =>
    parseField(f, source, `${at}.fields[${fi}]`, typedSobject, value.name as string, options)
  );

  return {
    sobject: typedSobject,
    id: value.id as string,
    name: value.name as string,
    ...(typeof value.apiName === 'string' ? { apiName: value.apiName } : {}),
    fields,
    ...(typeof value.expectedRuleKey === 'string' ? { expectedRuleKey: value.expectedRuleKey } : {}),
    ...(Array.isArray(value.productCodes) && value.productCodes.every((c) => typeof c === 'string')
      ? { productCodes: value.productCodes }
      : {}),
  };
}

function parseField(
  value: unknown,
  source: string,
  at: string,
  sobject: RecordUpdate['sobject'],
  recordName: string,
  options: ParsePlanOptions
): RecordUpdateField {
  if (!isRecord(value)) return fail(source, `${at} is not an object`);
  const { field, value: fieldValue } = value;

  if (typeof field !== 'string' || !ALLOWED_FIELDS[sobject].includes(field)) {
    fail(
      source,
      `${at} sets ${JSON.stringify(field) ?? '<missing>'} on ${sobject}; allowed: ${ALLOWED_FIELDS[sobject].join(', ')}`
    );
  }
  if (typeof fieldValue !== 'string') {
    fail(source, `${at} (${field as string}) must have a string value`);
  }

  // The blob is written verbatim so a reviewer's hand-correction is honored byte-for-byte; an
  // unparseable value is still worth flagging, but the org may accept it, so this is not fatal.
  if (field === JSON_BLOB_FIELD) {
    try {
      JSON.parse(fieldValue as string);
    } catch {
      options.onWarn?.(`${recordName}: ${JSON_BLOB_FIELD} is not valid JSON; it will be written verbatim`);
    }
  }

  return { field: field as string, value: fieldValue as string };
}

/** The subset of a `DynamicRuleDefinition` blob that convert actually mutates. */
type BlobSignature = {
  ruleKey: unknown;
  ruleEngineType: unknown;
};

/**
 * Extracts the only parts of the blob convert rewrites. Returns undefined when the value is not
 * parseable JSON, so callers can fall back to a raw compare.
 */
export function dynamicRuleDefinitionSignature(value: string): BlobSignature | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(parsed)) return undefined;
    const group = parsed.underwritingRuleGroup;
    return {
      ruleKey: parsed.ruleKey,
      ruleEngineType: isRecord(group) ? group.ruleEngineType : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The mutated fields, paired with the dotted path an operator would recognize them by. */
const BLOB_SIGNATURE_FIELDS: ReadonlyArray<[keyof BlobSignature, string]> = [
  ['ruleKey', 'ruleKey'],
  ['ruleEngineType', 'underwritingRuleGroup.ruleEngineType'],
];

const renderSignatureValue = (value: unknown): string => {
  if (value == null) return NO_VALUE;
  return truncateCell(typeof value === 'string' ? value : JSON.stringify(value));
};

/**
 * Renders a `DynamicRuleDefinition` change as a semantic diff of just the fields convert mutates.
 *
 * A real blob is several hundred characters whose first 60 are identical before and after, so a
 * truncated raw `old → new` renders byte-identically on both sides and the operator confirms
 * without having seen anything. Returns undefined when either side cannot be read structurally, so
 * the caller falls back to the raw diff rather than inventing a value.
 */
export function formatBlobChange(currentValue: string | null | undefined, newValue: string): string | undefined {
  const desired = dynamicRuleDefinitionSignature(newValue);
  if (!desired) return undefined;
  // A null current value is a genuinely empty field, not an unreadable one.
  const current = currentValue == null ? undefined : dynamicRuleDefinitionSignature(currentValue);
  if (currentValue != null && !current) return undefined;

  return BLOB_SIGNATURE_FIELDS.map(
    ([key, label]) => `${label}: ${renderSignatureValue(current?.[key])} → ${renderSignatureValue(desired[key])}`
  ).join(', ');
}

/** The same semantic view of a single blob, for rendering an already-current row. */
export function formatBlobSummary(value: string | null | undefined): string | undefined {
  const signature = value == null ? undefined : dynamicRuleDefinitionSignature(value);
  if (!signature) return undefined;
  return BLOB_SIGNATURE_FIELDS.map(([key, label]) => `${label}: ${renderSignatureValue(signature[key])}`).join(', ');
}

/** Reads the `apiName` out of a `DynamicRuleDefinition` blob, for the apply-time identity check. */
export function dynamicRuleDefinitionApiName(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return isRecord(parsed) && typeof parsed.apiName === 'string' ? parsed.apiName : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Field-type-aware "is the org already in the desired state?" check (§5.3).
 *
 * `DynamicRuleDefinition` is compared structurally on just the fields convert mutates, so that a
 * re-run after the org re-serializes the blob — or after a reviewer reformats it — is correctly
 * recognized as a no-op instead of rewriting it. Scalar fields compare raw.
 */
export function isAlreadyCurrent(field: string, currentValue: string | null | undefined, newValue: string): boolean {
  if (currentValue == null) return false;
  if (field !== JSON_BLOB_FIELD) return currentValue === newValue;

  const current = dynamicRuleDefinitionSignature(currentValue);
  const desired = dynamicRuleDefinitionSignature(newValue);
  // An unparseable side means we cannot reason structurally; fall back to the raw comparison.
  if (!current || !desired) return currentValue === newValue;

  return current.ruleKey === desired.ruleKey && current.ruleEngineType === desired.ruleEngineType;
}
