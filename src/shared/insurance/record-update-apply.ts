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
 * Org-facing half of `sf cml import record-updates`
 * (docs/insurance-export-review-import-redesign.md §5).
 *
 * Split into a read phase and an apply phase on purpose: the command must be able to compute and
 * render every planned change using read-only operations, then prompt, and only then write. Keeping
 * both phases here (rather than in the oclif command) makes them unit-testable against a stub
 * Connection.
 */
import { Connection } from '@salesforce/core';
import { RecordUpdate, RecordUpdateField, RecordUpdatePlan } from './models.js';
import { fetchProductCodes, quoteSoqlIdList } from './insurance-org.js';
import { splitProductPath } from './insurance-cml-merge.js';
import {
  JSON_BLOB_FIELD,
  SOBJECT_APPLY_ORDER,
  dynamicRuleDefinitionApiName,
  isAlreadyCurrent,
} from './record-update-plan.js';

/** One field-level change, joined to the org's current value from a fresh re-read. */
export type PlannedRecordChange = {
  update: RecordUpdate;
  field: RecordUpdateField;
  /** Current org value, from this invocation's re-read. Null when the field is empty. */
  currentValue: string | null;
  /** True when the org already holds the desired value, so the apply skips this field. */
  alreadyCurrent: boolean;
};

export type RecordUpdateReadPhase = {
  changes: PlannedRecordChange[];
  /**
   * Blocking problems found before any write: a record that no longer exists, or whose Name (or UW
   * blob apiName) disagrees with the file. Refusing here is what stops an edited id from silently
   * retargeting a valid-but-wrong record.
   */
  identityErrors: string[];
  /** Non-blocking notices, e.g. ProductCode drift that would desync the platform-generated RuleKey. */
  advisories: string[];
};

type OrgRecord = Record<string, unknown>;

/**
 * Salesforce rejects a `/composite/sobjects` request carrying more than 200 records, and jsforce
 * only splits the batch itself when `allowRecursive` is set (which `sobject().update()` does not
 * pass). Without chunking here, a 201-record plan fails wholesale and is then misreported as a
 * partial migration.
 */
const MAX_DML_CHUNK = 200;

/** Keeps a generated `Id IN (...)` clause comfortably inside the SOQL statement length limit. */
const MAX_SOQL_ID_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

const asString = (value: unknown): string | null =>
  value == null ? null : typeof value === 'string' ? value : String(value);

/** Groups updates by sObject, in the order the apply must issue them. */
function groupBySobject(updates: RecordUpdate[]): Array<[RecordUpdate['sobject'], RecordUpdate[]]> {
  return SOBJECT_APPLY_ORDER.map(
    (sobject) => [sobject, updates.filter((u) => u.sobject === sobject)] as [RecordUpdate['sobject'], RecordUpdate[]]
  ).filter(([, group]) => group.length > 0);
}

/**
 * Re-reads current org state for every record in the plan and returns the resolved field-level
 * changes. Read-only: safe to run under `--dry-run` and before the confirmation prompt.
 *
 * Only regex-validated ids are ever interpolated into SOQL (via `quoteSoqlIdList`); free text from
 * the file — `name`, `value` — never is.
 */
export async function planRecordUpdates(conn: Connection, plan: RecordUpdatePlan): Promise<RecordUpdateReadPhase> {
  const changes: PlannedRecordChange[] = [];
  const identityErrors: string[] = [];
  const advisories: string[] = [];

  for (const [sobject, updates] of groupBySobject(plan.updates)) {
    const fieldNames = [...new Set(updates.flatMap((u) => u.fields.map((f) => f.field)))];
    // ProductPath backs the advisory ProductCode drift check below; it is read, never written.
    const extraFields = sobject === 'ProductSurcharge' ? ['ProductPath'] : [];
    // eslint-disable-next-line no-await-in-loop
    const current = await queryCurrentRecords(conn, sobject, updates, [...fieldNames, ...extraFields]);

    for (const update of updates) {
      const record = current.get(update.id);
      if (!record) {
        identityErrors.push(`${update.sobject} ${update.id} (${update.name}) was not found in the org`);
        continue;
      }

      const orgName = asString(record.Name);
      if (orgName !== update.name) {
        identityErrors.push(
          `${update.sobject} ${update.id} is named '${orgName ?? '<none>'}' in the org but the file expected '${
            update.name
          }' — refusing to write to a possibly-wrong record`
        );
        continue;
      }

      const blobCheck = findBlobApiNameMismatch(update, record);
      if (blobCheck?.error) {
        identityErrors.push(blobCheck.error);
        continue;
      }
      if (blobCheck?.advisory) advisories.push(blobCheck.advisory);

      for (const field of update.fields) {
        const currentValue = asString(record[field.field]);
        changes.push({
          update,
          field,
          currentValue,
          alreadyCurrent: isAlreadyCurrent(field.field, currentValue, field.value),
        });
      }
    }

    if (sobject === 'ProductSurcharge') {
      // eslint-disable-next-line no-await-in-loop
      advisories.push(...(await findProductCodeDrift(conn, updates, current)));
    }
  }

  return { changes, identityErrors, advisories };
}

async function queryCurrentRecords(
  conn: Connection,
  sobject: RecordUpdate['sobject'],
  updates: RecordUpdate[],
  fields: string[]
): Promise<Map<string, OrgRecord>> {
  const byId = new Map<string, OrgRecord>();
  const selected = ['Id', 'Name', ...fields.filter((f) => f !== 'Id' && f !== 'Name')];

  for (const batch of chunk(updates, MAX_SOQL_ID_CHUNK)) {
    const idList = quoteSoqlIdList(batch.map((u) => u.id));
    if (!idList) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await conn.query<OrgRecord>(`SELECT ${selected.join(', ')} FROM ${sobject} WHERE Id IN (${idList})`);
    for (const record of result.records) {
      const id = asString(record.Id);
      if (id) byId.set(id, record);
    }
  }
  return byId;
}

/**
 * For a `DynamicRuleDefinition` rewrite, the org blob's own `apiName` is a second identity key
 * alongside Name.
 *
 * The guard fails closed. Previously anything it could not read — a blob the re-read did not
 * select, or one it could not parse — returned "no name" and was indistinguishable from "the names
 * agree", so the second identity key silently stopped protecting the operator. The one case that
 * is genuinely benign is a readable blob that simply carries no `apiName` (convert takes that
 * value from the record's ApiName field, which the blob need not repeat); that is surfaced as an
 * advisory rather than blocking a legitimate migration.
 */
function findBlobApiNameMismatch(
  update: RecordUpdate,
  record: OrgRecord
): { error?: string; advisory?: string } | undefined {
  if (update.sobject !== 'UnderwritingRule' || !update.apiName) return undefined;

  const refusing = 'refusing to write to a possibly-wrong record';
  const prefix = `UnderwritingRule ${update.id} (${update.name})`;
  if (!(JSON_BLOB_FIELD in record)) {
    return {
      error: `${prefix}: the org re-read did not return ${JSON_BLOB_FIELD}, so the apiName identity check could not run — ${refusing}`,
    };
  }

  const orgApiName = dynamicRuleDefinitionApiName(asString(record[JSON_BLOB_FIELD]));
  if ('failure' in orgApiName) {
    if (orgApiName.failure === 'unparseable') {
      return {
        error: `${prefix}: the org's ${JSON_BLOB_FIELD} is not readable JSON, so the apiName identity check could not run — ${refusing}`,
      };
    }
    return {
      advisory: `${prefix}: the org's ${JSON_BLOB_FIELD} carries no apiName, so only the record Name could be verified`,
    };
  }
  if (orgApiName.apiName === update.apiName) return undefined;

  return {
    error: `${prefix} has apiName '${orgApiName.apiName}' in the org but the file expected '${update.apiName}' — ${refusing}`,
  };
}

/**
 * Advisory ProductCode drift check. Convert computes the pathed rule key from each product's Code
 * at convert time; the platform regenerates `ProductSurcharge.RuleKey` from the *current*
 * ProductCode/ProductPath when `RuleEngineType` flips. If they drifted in between, the keys diverge
 * silently and the surcharge never fires — so the divergence is surfaced, never blocked on.
 */
async function findProductCodeDrift(
  conn: Connection,
  updates: RecordUpdate[],
  current: Map<string, OrgRecord>
): Promise<string[]> {
  const withCodes = updates.filter((u) => u.productCodes?.length);
  if (withCodes.length === 0) return [];

  const productIds = new Set<string>();
  for (const update of withCodes) {
    for (const id of splitProductPath(asString(current.get(update.id)?.ProductPath) ?? '')) productIds.add(id);
  }
  if (productIds.size === 0) return [];

  // A null ProductCode resolves to Name (then Id), which yields a key that cannot match the
  // platform-generated RuleKey — so the comparison below can be spurious in either direction.
  // The hook exists precisely to make that observable; ignoring it hid the signal.
  const fellBack = new Set<string>();
  const idToCode = await fetchProductCodes(conn, productIds, { onFallback: (id) => fellBack.add(id) });
  const advisories: string[] = [];
  if (fellBack.size > 0) {
    advisories.push(
      `products ${[...fellBack].join(', ')} have no ProductCode; their code was derived from Name or Id, so the ` +
        'ProductCode drift check below cannot be relied on for surcharges on those products'
    );
  }
  for (const update of withCodes) {
    const orgPath = splitProductPath(asString(current.get(update.id)?.ProductPath) ?? '');
    const orgCodes = orgPath.map((id) => idToCode.get(id) ?? id);
    const fileCodes = update.productCodes ?? [];
    if (orgCodes.join('/') !== fileCodes.join('/')) {
      advisories.push(
        `${update.name} (${update.id}): ProductCodes drifted since convert — file has '${fileCodes.join(
          '/'
        )}', org now resolves '${orgCodes.join(
          '/'
        )}'; the platform-generated RuleKey may not match the converted CML rule key`
      );
    }
  }
  return advisories;
}

export type RecordUpdateFailure = {
  id: string;
  name: string;
  errors: string[];
  /**
   * True when the request failed *after* it was sent, so whether the org applied this record is
   * genuinely unknown — a timeout or a 500 can arrive after the server committed. Distinct from a
   * rejection, where the org is known not to have written it.
   */
  outcomeUnknown: boolean;
};

export type ApplyRecordUpdatesResult = {
  /** Records (not fields) successfully written. */
  applied: number;
  failures: RecordUpdateFailure[];
};

/**
 * Writes the non-skipped changes, one `update` call per sObject type, groups issued in
 * `SOBJECT_APPLY_ORDER`. There is no transaction: successful writes are not rolled back when a
 * later one fails, which is why failures are collected and reported rather than thrown from here.
 */
export async function applyRecordUpdates(
  conn: Connection,
  changes: PlannedRecordChange[]
): Promise<ApplyRecordUpdatesResult> {
  const pending = changes.filter((c) => !c.alreadyCurrent);
  let applied = 0;
  const failures: RecordUpdateFailure[] = [];

  for (const [sobject, updates] of groupBySobject([...new Set(pending.map((c) => c.update))])) {
    const payloads: UpdatePayload[] = updates.map((update) => {
      const fields = pending.filter((c) => c.update === update).map((c) => c.field);
      return { Id: update.id, ...Object.fromEntries(fields.map((f) => [f.field, f.value])) };
    });

    // eslint-disable-next-line no-await-in-loop
    const results = await saveAll(conn, sobject, payloads);
    // Indexed by payload, never by result: a result list that does not line up with what was sent
    // must not throw here, because by this point the writes have already landed and the operator
    // would lose the failure report for an org that is now partially migrated.
    updates.forEach((update, i) => {
      const result = results[i];
      if (result?.success) applied += 1;
      else {
        failures.push({
          id: update.id,
          name: update.name,
          errors: result?.errors ?? [UNACCOUNTED_RESULT],
          outcomeUnknown: result?.outcomeUnknown ?? true,
        });
      }
    });
  }

  return { applied, failures };
}

type NormalizedSaveResult = { success: boolean; errors: string[]; outcomeUnknown: boolean };

/** Used when the org returned fewer results than the records that were sent. */
const UNACCOUNTED_RESULT = 'the org returned no result for this record, so whether it was written is unknown';

/** An update payload: the target record's Id plus the fields to set on it. */
type UpdatePayload = { Id: string } & Record<string, string>;

/**
 * Issues the update and normalizes jsforce's per-record results. A thrown error (network, invalid
 * session, whole-request rejection) is attributed to every record in the chunk, and marked
 * `outcomeUnknown`: the call site cannot tell a rejected request from a timeout or a 500 that
 * arrived after the server had already committed, and claiming the records were not written is
 * precisely wrong in the second case.
 */
async function saveAll(
  conn: Connection,
  sobject: RecordUpdate['sobject'],
  payloads: UpdatePayload[]
): Promise<NormalizedSaveResult[]> {
  const results: NormalizedSaveResult[] = [];
  for (const batch of chunk(payloads, MAX_DML_CHUNK)) {
    // Sequential, not parallel: a failing chunk must not race writes the operator may want to stop.
    // eslint-disable-next-line no-await-in-loop
    results.push(...(await saveChunk(conn, sobject, batch)));
  }
  return results;
}

async function saveChunk(
  conn: Connection,
  sobject: RecordUpdate['sobject'],
  payloads: UpdatePayload[]
): Promise<NormalizedSaveResult[]> {
  try {
    const raw = await conn.sobject(sobject).update(payloads);
    // A single-record update returns the bare result rather than a one-element array.
    const results = Array.isArray(raw) ? raw : [raw];
    return results.map((r) => ({
      success: Boolean((r as { success?: boolean }).success),
      errors: normalizeErrors((r as { errors?: unknown }).errors),
      outcomeUnknown: false,
    }));
  } catch (e) {
    return payloads.map(() => ({ success: false, errors: [(e as Error).message], outcomeUnknown: true }));
  }
}

function normalizeErrors(errors: unknown): string[] {
  if (!errors) return [];
  const list = Array.isArray(errors) ? errors : [errors];
  return list.map((e) => {
    if (typeof e === 'string') return e;
    const message = (e as { message?: unknown })?.message;
    return typeof message === 'string' ? message : JSON.stringify(e);
  });
}

export type SurchargeVerification = {
  Id: string;
  Name: string;
  RuleEngineType: string | null;
  RuleKey: string | null;
  RuleApiName: string | null;
};

export type SurchargeVerificationResult = {
  records: SurchargeVerification[];
  /** Loud but non-fatal: the flip succeeded, yet the surcharge will not fire. */
  warnings: string[];
};

/**
 * Post-flip verification (§5.4). `expectedRuleKey` is never written — the platform regenerates
 * `ProductSurcharge.RuleKey` when `RuleEngineType` flips — so the only way to know the surcharge
 * will actually fire is to read the regenerated key back and compare it to the key the CML rule was
 * emitted under.
 */
export async function verifySurchargeUpdates(
  conn: Connection,
  updates: RecordUpdate[]
): Promise<SurchargeVerificationResult> {
  const surcharges = updates.filter((u) => u.sobject === 'ProductSurcharge');
  const records: SurchargeVerification[] = [];
  for (const batch of chunk(surcharges, MAX_SOQL_ID_CHUNK)) {
    const idList = quoteSoqlIdList(batch.map((u) => u.id));
    if (!idList) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await conn.query<SurchargeVerification>(
      `SELECT Id, Name, RuleEngineType, RuleKey, RuleApiName FROM ProductSurcharge WHERE Id IN (${idList})`
    );
    records.push(...result.records);
  }
  const byId = new Map(records.map((r) => [r.Id, r]));

  const warnings: string[] = [];
  for (const update of surcharges) {
    if (!update.expectedRuleKey) continue;
    const actual = byId.get(update.id)?.RuleKey ?? null;
    if (actual !== update.expectedRuleKey) {
      warnings.push(
        `surcharge ${update.name} RuleKey '${actual ?? '<none>'}' does not match the converted CML rule key '${
          update.expectedRuleKey
        }'; the surcharge will not fire`
      );
    }
  }

  return { records, warnings };
}
