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
 * (export/review/import design, work item W-23654540 §3, §8).
 *
 * The `<safeApi>_{Underwriting,Surcharge}Update.json` file is explicitly meant to be reviewed and
 * hand-corrected before it is applied, so everything here treats it as untrusted input: the whole
 * file is rejected on any structural violation, before a single write. Passing the id regex is NOT
 * identity proof — the apply-time Name cross-check (record-update-apply.ts) is the real guard
 * against writing to a valid-but-wrong record.
 */
import { RecordUpdate, RecordUpdateField, RecordUpdatePlan } from './models.js';
import { NO_VALUE, truncateCell } from './planned-change.js';
import { decodeHtmlEntities } from './insurance-rule-generator.js';

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

/**
 * Which sObjects each kind may carry. `kind` selects behaviour the sObjects themselves do not
 * imply — most importantly the post-flip RuleKey readback, which the command dispatches purely on
 * `kind`. A file labelled `underwriting-update` that contains ProductSurcharge updates would flip
 * them with that verification silently skipped, losing the one check that catches "imports cleanly
 * but never fires".
 */
const KIND_SOBJECTS: Readonly<Record<RecordUpdatePlan['kind'], ReadonlyArray<RecordUpdate['sobject']>>> = {
  'underwriting-update': ['UnderwritingRuleGroup', 'UnderwritingRule'],
  'surcharge-update': ['ProductSurcharge'],
};

const SALESFORCE_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** The one field whose value is itself a JSON document, so it needs structural (not raw) compare. */
export const JSON_BLOB_FIELD = 'DynamicRuleDefinition';

/**
 * Violations that have their own operator-facing message key, because the remediation for them is
 * not the generic "regenerate the file or correct the reported problem".
 */
export type RecordUpdatePlanErrorCode = 'duplicateRecordId';

/** Thrown for any structural violation; the command turns it into `error.invalidFile`. */
export class RecordUpdatePlanError extends Error {
  public readonly code?: RecordUpdatePlanErrorCode;

  public constructor(message: string, code?: RecordUpdatePlanErrorCode) {
    super(message);
    this.code = code;
  }
}

const fail = (source: string, detail: string, code?: RecordUpdatePlanErrorCode): never => {
  throw new RecordUpdatePlanError(`${source}: ${detail}`, code);
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

  const typedKind = kind as RecordUpdatePlan['kind'];
  const updates = (plan.updates as unknown[]).map((u, i) => parseUpdate(u, source, i, typedKind, options));
  rejectRepeatedIds(updates, source);

  return {
    schemaVersion: 1,
    kind: typedKind,
    cmlApi: plan.cmlApi as string,
    generatedAt: typeof plan.generatedAt === 'string' ? plan.generatedAt : '',
    updates,
  };
}

/**
 * The 15-character form of an id, which is what identifies the record: the optional 3-character
 * suffix is only a case-safety checksum, so `a0p…001` and `a0p…001AAA` are the same record spelled
 * two ways and must count as a repeat.
 */
const recordKey = (id: string): string => id.slice(0, 15);

/**
 * Refuses a file that carries two entries for one record — the record-level twin of the
 * duplicate-field check in {@link parseUpdate}.
 *
 * Two entries for one id are not merged anywhere: the preview renders the record twice, with
 * contradictory operations when the values disagree; the field-level counts report the one record as
 * both an update and an already-current skip while the record-level summary reports neither; and
 * when both values need writing, `applyRecordUpdates` groups by plan entry, so two payloads
 * carrying the same `Id` go into a single `/composite/sobjects` PATCH, which the org rejects. Not
 * scoped per sObject: a Salesforce id names exactly one record of exactly one type, so the same id
 * under two sObjects is a hand-edit gone wrong, and `applied` counts plan entries either way.
 */
function rejectRepeatedIds(updates: RecordUpdate[], source: string): void {
  const firstSeenAt = new Map<string, number>();
  updates.forEach((update, index) => {
    const key = recordKey(update.id);
    const first = firstSeenAt.get(key);
    if (first === undefined) {
      firstSeenAt.set(key, index);
      return;
    }
    fail(
      source,
      `updates[${index}] (${update.name}) repeats record id ${update.id}, which updates[${first}] (${updates[first].name}) already updates; each record must appear exactly once`,
      'duplicateRecordId'
    );
  });
}

function parseUpdate(
  value: unknown,
  source: string,
  index: number,
  kind: RecordUpdatePlan['kind'],
  options: ParsePlanOptions
): RecordUpdate {
  const at = `updates[${index}]`;
  if (!isRecord(value)) return fail(source, `${at} is not an object`);

  const sobject = value.sobject;
  if (typeof sobject !== 'string' || !(sobject in ALLOWED_FIELDS)) {
    fail(source, `${at} has unsupported sobject ${JSON.stringify(sobject) ?? '<missing>'}`);
  }
  const typedSobject = sobject as RecordUpdate['sobject'];
  if (!KIND_SOBJECTS[kind].includes(typedSobject)) {
    fail(
      source,
      `${at} has sobject ${typedSobject}, which a '${kind}' file cannot contain; allowed: ${KIND_SOBJECTS[kind].join(
        ', '
      )}`
    );
  }

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
  // Two entries for the same field render two preview rows with two different target values while
  // exactly one write happens (the payload is built with Object.fromEntries, so the last wins).
  // The operator cannot consent to that, so refuse the file rather than pick a winner.
  const duplicate = fields.find((f, i) => fields.findIndex((other) => other.field === f.field) !== i);
  if (duplicate) {
    fail(source, `${at} (${value.name as string}) sets ${duplicate.field} more than once`);
  }

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
  // An empty value is not "leave it alone": isAlreadyCurrent reports a change, the preview renders
  // an empty right-hand side, and the payload blanks the field in the org. Nothing convert emits
  // is ever empty, so this can only be a hand-edit gone wrong.
  if (!isNonEmptyString(fieldValue)) {
    fail(source, `${at} (${field as string}) has an empty value; a field to clear must be stated explicitly`);
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

/** Sentinel distinguishing "did not parse" from a document that legitimately parsed to null. */
const UNPARSEABLE = Symbol('unparseable');

/**
 * Parses a blob the org stored, tolerating the HTML-entity encoding these fields come back in.
 *
 * The raw parse is attempted first, so a blob that is already clean JSON is never altered — the
 * entity decode only runs on input that is not valid JSON as-is, which is precisely the encoded
 * case (`{&quot;apiName&quot;:…}` cannot parse raw). Convert decodes for the same reason.
 */
function parseBlob(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // fall through to the decoded attempt
  }
  try {
    return JSON.parse(decodeHtmlEntities(value));
  } catch {
    return UNPARSEABLE;
  }
}

/**
 * Extracts the only parts of the blob convert rewrites. Returns undefined when the value is not
 * parseable JSON, so callers can fall back to a raw compare.
 */
export function dynamicRuleDefinitionSignature(value: string): BlobSignature | undefined {
  const parsed = parseBlob(value);
  if (!isRecord(parsed)) return undefined;
  const group = parsed.underwritingRuleGroup;
  return {
    ruleKey: parsed.ruleKey,
    ruleEngineType: isRecord(group) ? group.ruleEngineType : undefined,
  };
}

/** The mutated fields, paired with the dotted path an operator would recognize them by. */
const BLOB_SIGNATURE_FIELDS: ReadonlyArray<[keyof BlobSignature, string]> = [
  ['ruleKey', 'ruleKey'],
  ['ruleEngineType', 'underwritingRuleGroup.ruleEngineType'],
];

/** The same two fields as dotted paths, to subtract them from a whole-document difference list. */
const BLOB_SIGNATURE_PATHS: ReadonlySet<string> = new Set(BLOB_SIGNATURE_FIELDS.map(([, label]) => label));

/** How much of the cell the named-path list may take, matching the per-value budget. */
const OTHER_PATHS_BUDGET = 60;

/** A single path is truncated well short of the list budget, so one long path cannot crowd out all others. */
const OTHER_PATH_BUDGET = 40;

const renderSignatureValue = (value: unknown): string => {
  if (value == null) return NO_VALUE;
  return truncateCell(typeof value === 'string' ? value : JSON.stringify(value));
};

/**
 * Names the differing paths that fit the cell budget, then counts the rest.
 *
 * Always names at least one, even if it alone exceeds the budget: a disclosure with no example is
 * barely more actionable than the identical-pairs cell this exists to replace.
 */
function nameOtherPaths(paths: readonly string[]): string {
  const named: string[] = [];
  let used = 0;
  for (const path of paths) {
    const rendered = truncateCell(path, OTHER_PATH_BUDGET);
    const cost = rendered.length + (named.length > 0 ? ', '.length : 0);
    if (named.length > 0 && used + cost > OTHER_PATHS_BUDGET) break;
    named.push(rendered);
    used += cost;
  }
  const overflow = paths.length - named.length;
  return overflow > 0 ? `${named.join(', ')}, +${overflow} more` : named.join(', ');
}

/** e.g. `3 other fields differ: status, description, +1 more`. */
const describeOtherPaths = (paths: readonly string[]): string =>
  `${paths.length} other ${paths.length === 1 ? 'field differs' : 'fields differ'}: ${nameOtherPaths(paths)}`;

/**
 * Renders a `DynamicRuleDefinition` change as a semantic diff of just the fields convert mutates,
 * plus a disclosure of any difference elsewhere in the document.
 *
 * A real blob is several hundred characters whose first 60 are identical before and after, so a
 * truncated raw `old → new` renders byte-identically on both sides and the operator confirms
 * without having seen anything (B1). But {@link isAlreadyCurrent} compares the WHOLE document (B2),
 * so a row can be an `Update` because of a field this diff does not show — and then every pair it
 * does show reads `X → X`, which is the same "confirmed without seeing anything" failure wearing a
 * different hat. The pairs are therefore only rendered when they actually changed, and anything
 * that changed outside them is named.
 *
 * Returns undefined when either side cannot be read structurally, so the caller falls back to the
 * raw diff rather than inventing a value.
 */
export function formatBlobChange(currentValue: string | null | undefined, newValue: string): string | undefined {
  const desired = dynamicRuleDefinitionSignature(newValue);
  if (!desired) return undefined;
  // A null current value is a genuinely empty field, not an unreadable one.
  const current = currentValue == null ? undefined : dynamicRuleDefinitionSignature(currentValue);
  if (currentValue != null && !current) return undefined;

  const pairs = BLOB_SIGNATURE_FIELDS.map(
    ([key, label]) => `${label}: ${renderSignatureValue(current?.[key])} → ${renderSignatureValue(desired[key])}`
  ).join(', ');

  // Nothing to diff against, and `(none) → value` is already visibly different on both sides: every
  // field in the document is new, so there is no subset worth singling out as "other".
  if (currentValue == null) return pairs;

  const other = documentDifferences(parseBlob(currentValue), parseBlob(newValue)).filter(
    (path) => !BLOB_SIGNATURE_PATHS.has(path)
  );
  if (other.length === 0) return pairs;

  const signatureChanged = BLOB_SIGNATURE_FIELDS.some(
    ([key]) => documentDifferences(current?.[key], desired[key]).length > 0
  );
  return signatureChanged
    ? `${pairs}; also ${describeOtherPaths(other)}`
    : `${BLOB_SIGNATURE_FIELDS.map(([, label]) => label).join(' and ')} unchanged; ${describeOtherPaths(other)}`;
}

/**
 * The same semantic view of a single blob, for rendering an already-current row.
 *
 * This needs no "other fields" disclosure: the row only exists because {@link isAlreadyCurrent}
 * found the two documents deep-equal, so by construction there is nothing outside these fields to
 * disclose. (The one already-current path that does not prove that — the raw-text fallback for an
 * unparseable blob — never reaches here, because an unparseable value yields no signature.)
 */
export function formatBlobSummary(value: string | null | undefined): string | undefined {
  const signature = value == null ? undefined : dynamicRuleDefinitionSignature(value);
  if (!signature) return undefined;
  return BLOB_SIGNATURE_FIELDS.map(([key, label]) => `${label}: ${renderSignatureValue(signature[key])}`).join(', ');
}

/** Why {@link dynamicRuleDefinitionApiName} could not produce a name. Callers must not ignore it. */
export type BlobApiNameFailure = 'unparseable' | 'absent';

/**
 * Reads the `apiName` out of a `DynamicRuleDefinition` blob, for the apply-time identity check.
 *
 * Returns a discriminated failure rather than `undefined` so the caller cannot silently read "no
 * name" as "no mismatch": an unreadable blob means the guard did not run, which is a different
 * thing from a blob that ran and agreed.
 */
export function dynamicRuleDefinitionApiName(
  value: string | null | undefined
): { apiName: string } | { failure: BlobApiNameFailure } {
  if (value == null || value === '') return { failure: 'absent' };
  const parsed = parseBlob(value);
  if (!isRecord(parsed)) return { failure: 'unparseable' };
  return typeof parsed.apiName === 'string' ? { apiName: parsed.apiName } : { failure: 'absent' };
}

/** Stands in for the path of a difference at the root, where there is no key to name. */
const ROOT_PATH = '(whole document)';

/**
 * Every dotted path at which two parsed JSON documents differ: objects compare
 * key-order-insensitively, arrays stay ordered. An empty result is exactly "same document, possibly
 * re-serialized" — the distinction the blob compare needs to draw.
 *
 * Deliberately the single definition of blob difference in this module. {@link isAlreadyCurrent}
 * decides whether to write from it and {@link formatBlobChange} describes the write from it, so the
 * preview cannot claim a document is unchanged that the skip decision is about to rewrite, or the
 * reverse. A second, separately-written comparison would eventually disagree with this one, and a
 * preview that contradicts what gets applied is worse than no preview.
 *
 * An array whose length differs is reported at the array itself rather than per element: the
 * element indices are not stable across an insertion, so naming them would mislead more than the
 * array's own name does.
 */
function documentDifferences(a: unknown, b: unknown, path = ''): string[] {
  if (a === b) return [];
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return [path === '' ? ROOT_PATH : path];
    return a.flatMap((item, i) => documentDifferences(item, b[i], `${path}[${i}]`));
  }
  if (!isRecord(a) || !isRecord(b)) return [path === '' ? ROOT_PATH : path];

  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => {
    const child = path === '' ? key : `${path}.${key}`;
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return [child];
    return documentDifferences(a[key], b[key], child);
  });
}

/**
 * Field-type-aware "is the org already in the desired state?" check (§5.3).
 *
 * `DynamicRuleDefinition` is compared as a whole JSON document rather than raw text, so a re-run
 * after the org re-serializes the blob — or after a reviewer reformats it — is correctly
 * recognized as a no-op instead of rewriting it. The comparison covers the *entire* document, not
 * just the fields convert mutates: the apply writes the file's blob verbatim, so a reviewer's
 * hand-correction anywhere in it (a threshold in `ruleCriteria`, say) is a substantive change that
 * must not be silently dropped as "already current". Scalar fields compare raw.
 */
export function isAlreadyCurrent(field: string, currentValue: string | null | undefined, newValue: string): boolean {
  if (currentValue == null) return false;
  if (field !== JSON_BLOB_FIELD) return currentValue === newValue;

  const current = parseBlob(currentValue);
  const desired = parseBlob(newValue);
  // An unparseable side means we cannot reason structurally; fall back to the raw comparison.
  if (current === UNPARSEABLE || desired === UNPARSEABLE) return currentValue === newValue;

  return documentDifferences(current, desired).length === 0;
}
