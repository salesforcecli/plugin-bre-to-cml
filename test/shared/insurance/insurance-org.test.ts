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
import { expect } from 'chai';
import { Connection } from '@salesforce/core';
import { fetchProductCodes, quoteSoqlIdList } from '../../../src/shared/insurance/insurance-org.js';

/** Minimal mock Connection: only `query` is exercised by fetchProductCodes. No live org. */
function mockConnection(opts: { query?: (soql: string) => { records: unknown[] } }): Connection {
  return {
    query: (soql: string) => Promise.resolve(opts.query ? opts.query(soql) : { records: [] }),
  } as unknown as Connection;
}

const ID_A = '01tSB000004V4KKYA0';
const ID_B = '01tSB000004V4KNYA0';

describe('insurance-org fetchProductCodes', () => {
  it('maps real ProductCode without recording any fallback (M2)', async () => {
    const conn = mockConnection({
      query: () => ({
        records: [{ Id: ID_A, ProductCode: 'CollisionCode', Name: 'Collision' }],
      }),
    });
    const fellBack: string[] = [];
    const map = await fetchProductCodes(conn, new Set([ID_A]), { onFallback: (id) => fellBack.push(id) });

    expect(map.get(ID_A)).to.equal('CollisionCode');
    expect(fellBack).to.deep.equal([]);
  });

  it('records a fallback signal when ProductCode is null and falls back to Name (M2)', async () => {
    const conn = mockConnection({
      query: () => ({
        records: [{ Id: ID_A, ProductCode: null, Name: 'Collision' }],
      }),
    });
    const fellBack: string[] = [];
    const map = await fetchProductCodes(conn, new Set([ID_A]), { onFallback: (id) => fellBack.push(id) });

    // Fallback behavior preserved: Name is used so callers don't break...
    expect(map.get(ID_A)).to.equal('Collision');
    // ...but the fallback is now observable.
    expect(fellBack).to.deep.equal([ID_A]);
  });

  it('records a fallback when both ProductCode and Name are null, falling back to Id (M2)', async () => {
    const conn = mockConnection({
      query: () => ({
        records: [{ Id: ID_A, ProductCode: null, Name: null }],
      }),
    });
    const fellBack: string[] = [];
    const map = await fetchProductCodes(conn, new Set([ID_A]), { onFallback: (id) => fellBack.push(id) });

    expect(map.get(ID_A)).to.equal(ID_A);
    expect(fellBack).to.deep.equal([ID_A]);
  });

  it('records fallbacks per-id, only for the ones missing a ProductCode (M2)', async () => {
    const conn = mockConnection({
      query: () => ({
        records: [
          { Id: ID_A, ProductCode: 'GoodCode', Name: 'A' },
          { Id: ID_B, ProductCode: null, Name: 'BName' },
        ],
      }),
    });
    const fellBack: string[] = [];
    const map = await fetchProductCodes(conn, new Set([ID_A, ID_B]), { onFallback: (id) => fellBack.push(id) });

    expect(map.get(ID_A)).to.equal('GoodCode');
    expect(map.get(ID_B)).to.equal('BName');
    expect(fellBack).to.deep.equal([ID_B]);
  });

  it('works without the optional onFallback callback (additive signature, no ripple)', async () => {
    const conn = mockConnection({
      query: () => ({ records: [{ Id: ID_A, ProductCode: null, Name: 'Collision' }] }),
    });
    const map = await fetchProductCodes(conn, new Set([ID_A]));
    expect(map.get(ID_A)).to.equal('Collision');
  });

  it('returns an empty map and fires no fallback for an empty / all-invalid id set', async () => {
    const conn = mockConnection({ query: () => ({ records: [] }) });
    const fellBack: string[] = [];
    const map = await fetchProductCodes(conn, new Set(['not-an-id']), { onFallback: (id) => fellBack.push(id) });
    expect(map.size).to.equal(0);
    expect(fellBack).to.deep.equal([]);
  });
});

describe('insurance-org quoteSoqlIdList', () => {
  it('keeps only well-formed ids and quotes them', () => {
    expect(quoteSoqlIdList([ID_A, 'bad', ID_B])).to.equal(`'${ID_A}','${ID_B}'`);
  });
});
