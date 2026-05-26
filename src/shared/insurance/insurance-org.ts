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

export async function fetchProductCodes(conn: Connection, productIds: Set<string>): Promise<Map<string, string>> {
  const idToCode = new Map<string, string>();
  if (productIds.size === 0) return idToCode;

  const idList = Array.from(productIds)
    .map((id) => `'${id}'`)
    .join(',');
  const result = await conn.query<{ Id: string; ProductCode: string; Name: string }>(
    `SELECT Id, ProductCode, Name FROM Product2 WHERE Id IN (${idList})`
  );
  for (const p of result.records) {
    idToCode.set(p.Id, p.ProductCode ?? p.Name ?? p.Id);
  }
  return idToCode;
}

export async function discoverCmlApiByProducts(conn: Connection, productIds: Set<string>): Promise<string | undefined> {
  if (productIds.size === 0) return undefined;

  const idList = Array.from(productIds)
    .map((id) => `'${id}'`)
    .join(',');
  const assocResult = await conn.query<{ ExpressionSetId: string }>(
    `SELECT ExpressionSetId FROM ExpressionSetConstraintObj WHERE ReferenceObjectId IN (${idList}) AND ConstraintModelTagType = 'Type' LIMIT 1`
  );
  if (assocResult.records.length === 0) return undefined;

  const esId = assocResult.records[0].ExpressionSetId;
  const esResult = await conn.query<{ ApiName: string }>(`SELECT ApiName FROM ExpressionSet WHERE Id = '${esId}'`);
  if (esResult.records.length === 0) return undefined;

  return esResult.records[0].ApiName;
}
