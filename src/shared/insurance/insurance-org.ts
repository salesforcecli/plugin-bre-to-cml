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
import { Connection } from '@salesforce/core';

/**
 * Matches a well-formed 15- or 18-character Salesforce record id. Only those two lengths exist —
 * this is the same pattern record-update-plan.ts validates the plan file's ids against, so the two
 * gates cannot disagree about what an id is.
 */
const SALESFORCE_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/**
 * Builds a quoted, comma-separated SOQL id list, keeping only well-formed Salesforce ids.
 * Product ids originate from rule definitions that may be supplied via --surcharge-file /
 * --uw-file, so validating here prevents SOQL injection through the `IN (...)` clause.
 */
export function quoteSoqlIdList(ids: Iterable<string>): string {
  return Array.from(ids)
    .filter((id) => SALESFORCE_ID_PATTERN.test(id))
    .map((id) => `'${id}'`)
    .join(',');
}

/** Ids per SOQL `IN (...)` batch. Mirrors record-update-apply so a large rule set cannot overflow. */
const MAX_SOQL_ID_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

/**
 * Resolves each AttributeDefinition id to the data type its values must be compared as.
 *
 * `Picklist` is not itself a comparable type — the comparable type lives on the AttributePicklist
 * behind it — so a picklist resolves to `Picklist.DataType` (e.g. Currency for a Deductible whose
 * values are 250/500/1000) and every other attribute to its own `DataType`.
 *
 * An attribute whose picklist type is unavailable (deleted, or not visible to the running user) is
 * omitted rather than recorded as 'Picklist', which keeps the caller on the safe string-quoted path
 * instead of asking it to interpret a type that carries no comparable type of its own.
 */
export async function fetchAttributeDataTypes(
  conn: Connection,
  attributeIds: Set<string>
): Promise<Map<string, string>> {
  const idToDataType = new Map<string, string>();
  const ids = Array.from(attributeIds).filter((id) => SALESFORCE_ID_PATTERN.test(id));
  if (ids.length === 0) return idToDataType;

  for (const batch of chunk(ids, MAX_SOQL_ID_CHUNK)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await conn.query<{
      Id: string;
      DataType: string | null;
      Picklist: { DataType: string | null } | null;
    }>(`SELECT Id, DataType, Picklist.DataType FROM AttributeDefinition WHERE Id IN (${quoteSoqlIdList(batch)})`);
    for (const attribute of result.records) {
      const resolved =
        attribute.DataType?.toUpperCase() === 'PICKLIST' ? attribute.Picklist?.DataType : attribute.DataType;
      if (resolved) idToDataType.set(attribute.Id, resolved);
    }
  }
  return idToDataType;
}

/** Optional hooks for {@link fetchProductCodes}. Additive so existing callers need no changes. */
export type FetchProductCodesOptions = {
  /**
   * Invoked once per product id whose code had to be derived from a fallback (Name, then Id)
   * because `ProductCode` was blank. The pathed rule key is built from these codes, so a fallback
   * silently yields a key that will NOT match the platform's auto-generated RuleKey — the rule then
   * imports cleanly but never fires. Surfacing the fallback lets the command layer warn instead of
   * dropping the surcharge silently (M2).
   */
  onFallback?: (productId: string) => void;
  /**
   * When provided, populated with each product's Name (Id -> Name) from the same query. The common
   * `cml import as-expression-set` resolves a Type association's Product2 by Name, so the convert
   * layer must emit Name — not ProductCode — as the association reference value. Collected here to
   * avoid a second round-trip. Products with a null Name are omitted (they cannot match by name).
   */
  collectNames?: Map<string, string>;
};

export async function fetchProductCodes(
  conn: Connection,
  productIds: Set<string>,
  options: FetchProductCodesOptions = {}
): Promise<Map<string, string>> {
  const idToCode = new Map<string, string>();
  const idList = quoteSoqlIdList(productIds);
  if (!idList) return idToCode;

  const result = await conn.query<{ Id: string; ProductCode: string | null; Name: string | null }>(
    `SELECT Id, ProductCode, Name FROM Product2 WHERE Id IN (${idList})`
  );
  for (const p of result.records) {
    // Keep the fallback chain (don't break callers), but make it observable: a null ProductCode
    // means the resolved code did NOT come from the platform-authoritative field.
    if (p.ProductCode == null) {
      options.onFallback?.(p.Id);
    }
    idToCode.set(p.Id, p.ProductCode ?? p.Name ?? p.Id);
    if (p.Name != null) {
      options.collectNames?.set(p.Id, p.Name);
    }
  }
  return idToCode;
}

export async function discoverCmlApiByProducts(conn: Connection, productIds: Set<string>): Promise<string | undefined> {
  const idList = quoteSoqlIdList(productIds);
  if (!idList) return undefined;

  const assocResult = await conn.query<{ ExpressionSetId: string }>(
    `SELECT ExpressionSetId FROM ExpressionSetConstraintObj WHERE ReferenceObjectId IN (${idList}) AND ConstraintModelTagType = 'Type' LIMIT 1`
  );
  if (assocResult.records.length === 0) return undefined;

  const esId = assocResult.records[0].ExpressionSetId;
  if (!SALESFORCE_ID_PATTERN.test(esId)) return undefined;

  const esResult = await conn.query<{ ApiName: string }>(`SELECT ApiName FROM ExpressionSet WHERE Id = '${esId}'`);
  if (esResult.records.length === 0) return undefined;

  return esResult.records[0].ApiName;
}
