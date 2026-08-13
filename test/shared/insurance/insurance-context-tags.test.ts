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
import {
  classifyContextTagScope,
  contextDataTypeToCmlDeclaration,
  fetchContextDefinitionIds,
  fetchContextTagBindings,
  parseContextNodePath,
} from '../../../src/shared/insurance/insurance-context-tags.js';

const DEF_ID = '11Ofiw0000001k5EAA';
const VERSION_ID = '11pfiw0000008hdAAA';

/**
 * Minimal mock Connection that answers each SOQL by the object it selects FROM, so a test can
 * describe the org's shape without caring about query order. Records the SOQL it was asked, which
 * the injection-guard tests assert on.
 */
function mockConnection(tables: {
  junction?: unknown[];
  versions?: unknown[];
  tags?: unknown[];
  seen?: string[];
}): Connection {
  return {
    query: (soql: string) => {
      tables.seen?.push(soql);
      if (soql.includes('FROM ExpressionSetDefinitionContextDefinition')) {
        return Promise.resolve({ records: tables.junction ?? [] });
      }
      if (soql.includes('FROM ContextDefinitionVersion')) {
        return Promise.resolve({ records: tables.versions ?? [] });
      }
      if (soql.includes('FROM ContextTag')) {
        return Promise.resolve({ records: tables.tags ?? [] });
      }
      return Promise.resolve({ records: [] });
    },
  } as unknown as Connection;
}

/** A ContextTag row in the shape the resolution query returns it. */
function tagRow(title: string, dataType: string, nodeTitle: string, inheritedFrom: string | null): unknown {
  return {
    Title: title,
    ContextAttribute: { DataType: dataType, ContextNode: { Title: nodeTitle, InheritedFrom: inheritedFrom } },
  };
}

const ST = 'InsuranceContext__stdctx/version/SalesTransaction';
const STI = `${ST}/SalesTransactionItem`;

const DEFAULT_TABLES = {
  junction: [{ ContextDefinitionId: DEF_ID }],
  versions: [{ Id: VERSION_ID, ContextDefinitionId: DEF_ID, VersionNumber: 28, IsActive: true }],
};

describe('insurance-context-tags parseContextNodePath', () => {
  it('drops the definition/version prefix and keeps the node hierarchy', () => {
    expect(parseContextNodePath(STI, 'SalesTransactionItem')).to.deep.equal([
      'SalesTransaction',
      'SalesTransactionItem',
    ]);
  });

  it('treats an authored (non-inherited) node as a single-segment path from its own title', () => {
    // ContextNode carries no parent pointer, so a blank InheritedFrom leaves the node's own Title as
    // the only thing known about its position.
    expect(parseContextNodePath('', 'SalesTransaction')).to.deep.equal(['SalesTransaction']);
    expect(parseContextNodePath(null, 'SalesTransactionItem')).to.deep.equal(['SalesTransactionItem']);
  });

  it('yields no path at all when neither source says anything', () => {
    expect(parseContextNodePath(null, '   ')).to.deep.equal([]);
  });
});

describe('insurance-context-tags classifyContextTagScope', () => {
  it('binds a tag directly under SalesTransaction at transaction level', () => {
    expect(classifyContextTagScope(['SalesTransaction'])).to.equal('transaction');
  });

  it('binds a tag descending through SalesTransactionItem at item level', () => {
    expect(classifyContextTagScope(['SalesTransaction', 'SalesTransactionItem'])).to.equal('item');
    expect(
      classifyContextTagScope(['SalesTransaction', 'SalesTransactionItem', 'SalesTransactionItemDetail'])
    ).to.equal('item');
  });

  it('refuses a sibling subtree rather than guessing a binding for it', () => {
    // AppUsageAssignment hangs off SalesTransaction but is neither the root itself nor under the
    // item node, and no hand-written example establishes how CML should bind it.
    expect(classifyContextTagScope(['SalesTransaction', 'AppUsageAssignment'])).to.equal(undefined);
  });

  it('refuses a path that is not rooted at SalesTransaction, and an empty one', () => {
    expect(classifyContextTagScope(['SomethingElse', 'SalesTransactionItem'])).to.equal(undefined);
    expect(classifyContextTagScope([])).to.equal(undefined);
  });
});

describe('insurance-context-tags contextDataTypeToCmlDeclaration', () => {
  it('maps currency to the scaled decimal the curated model already uses', () => {
    expect(contextDataTypeToCmlDeclaration('currency')).to.equal('decimal(2)');
  });

  it('maps the representable platform types, case-insensitively', () => {
    expect(contextDataTypeToCmlDeclaration('date')).to.equal('date');
    expect(contextDataTypeToCmlDeclaration('STRING')).to.equal('string');
    expect(contextDataTypeToCmlDeclaration('Number')).to.equal('decimal');
    expect(contextDataTypeToCmlDeclaration('boolean')).to.equal('boolean');
    expect(contextDataTypeToCmlDeclaration('percent')).to.equal('decimal');
  });

  it('refuses datetime rather than truncating it into a date slot', () => {
    // CML has no datetime primitive. Declaring `date` would bind a value carrying a time into a slot
    // that cannot hold one — a silent mis-binding, which is worse than a withheld rule.
    expect(contextDataTypeToCmlDeclaration('datetime')).to.equal(undefined);
  });

  it('refuses types that carry no comparable form of their own', () => {
    expect(contextDataTypeToCmlDeclaration('picklist')).to.equal(undefined);
    expect(contextDataTypeToCmlDeclaration('reference')).to.equal(undefined);
    expect(contextDataTypeToCmlDeclaration('')).to.equal(undefined);
    expect(contextDataTypeToCmlDeclaration(null)).to.equal(undefined);
  });
});

describe('insurance-context-tags fetchContextDefinitionIds', () => {
  it('de-duplicates the junction rows the import accumulates on every activation', async () => {
    const conn = mockConnection({
      junction: [{ ContextDefinitionId: DEF_ID }, { ContextDefinitionId: DEF_ID }, { ContextDefinitionId: DEF_ID }],
    });
    const ids = await fetchContextDefinitionIds(conn, 'Auto_Silver');
    expect(Array.from(ids)).to.deep.equal([DEF_ID]);
  });

  it('ignores a junction row with no context definition', async () => {
    const conn = mockConnection({ junction: [{ ContextDefinitionId: null }] });
    expect((await fetchContextDefinitionIds(conn, 'Auto_Silver')).size).to.equal(0);
  });

  it('resolves nothing for a CML api name that is not a bare developer name', async () => {
    const seen: string[] = [];
    const conn = mockConnection({ junction: [{ ContextDefinitionId: DEF_ID }], seen });
    // Fail closed rather than escaping a name into the SOQL literal.
    expect((await fetchContextDefinitionIds(conn, "Auto' OR Name != '")).size).to.equal(0);
    expect(seen).to.deep.equal([]);
  });
});

describe('insurance-context-tags fetchContextTagBindings', () => {
  it('resolves a transaction-level tag to its context type and binding scope', async () => {
    const conn = mockConnection({ ...DEFAULT_TABLES, tags: [tagRow('EndDate', 'date', 'SalesTransaction', ST)] });
    const bindings = await fetchContextTagBindings(conn, 'Auto_Silver', ['EndDate']);

    expect(bindings.get('EndDate')).to.deep.equal({
      tag: 'EndDate',
      cmlType: 'date',
      sourceDataType: 'date',
      scope: 'transaction',
    });
  });

  it('resolves an item-level tag, keeping the currency scale', async () => {
    const conn = mockConnection({
      ...DEFAULT_TABLES,
      tags: [tagRow('ItemTotalPrice', 'currency', 'SalesTransactionItem', STI)],
    });
    const bindings = await fetchContextTagBindings(conn, 'Auto_Silver', ['ItemTotalPrice']);

    expect(bindings.get('ItemTotalPrice')?.cmlType).to.equal('decimal(2)');
    expect(bindings.get('ItemTotalPrice')?.scope).to.equal('item');
  });

  it('prefers the active context version over a higher-numbered inactive one', async () => {
    const seen: string[] = [];
    const conn = mockConnection({
      junction: [{ ContextDefinitionId: DEF_ID }],
      versions: [
        { Id: VERSION_ID, ContextDefinitionId: DEF_ID, VersionNumber: 2, IsActive: true },
        { Id: '11pfiw0000008zzAAA', ContextDefinitionId: DEF_ID, VersionNumber: 9, IsActive: false },
      ],
      tags: [tagRow('EndDate', 'date', 'SalesTransaction', ST)],
      seen,
    });
    await fetchContextTagBindings(conn, 'Auto_Silver', ['EndDate']);

    const tagQuery = seen.find((s) => s.includes('FROM ContextTag'))!;
    expect(tagQuery).to.include(VERSION_ID);
    expect(tagQuery).to.not.include('11pfiw0000008zzAAA');
  });

  it('drops a tag whose rows disagree on type, rather than picking one', async () => {
    // The exact ambiguity the linkage exists to avoid: EndDate is `date` under SalesTransaction and
    // `datetime` under SalesTransactionItem. Nothing at deploy would catch the wrong choice.
    const conn = mockConnection({
      ...DEFAULT_TABLES,
      tags: [
        tagRow('EndDate', 'date', 'SalesTransaction', ST),
        tagRow('EndDate', 'datetime', 'SalesTransactionItem', STI),
      ],
    });
    const bindings = await fetchContextTagBindings(conn, 'Auto_Silver', ['EndDate']);
    expect(bindings.has('EndDate')).to.equal(false);
  });

  it('drops a tag that resolves once representably and once not, in either row order', async () => {
    const rows = [
      tagRow('EndDate', 'datetime', 'SalesTransactionItem', STI),
      tagRow('EndDate', 'date', 'SalesTransaction', ST),
    ];
    for (const tags of [rows, [...rows].reverse()]) {
      // eslint-disable-next-line no-await-in-loop
      const bindings = await fetchContextTagBindings(mockConnection({ ...DEFAULT_TABLES, tags }), 'Auto_Silver', [
        'EndDate',
      ]);
      expect(bindings.has('EndDate')).to.equal(false);
    }
  });

  it('resolves nothing when the model is bound to no context definition', async () => {
    const conn = mockConnection({ junction: [], tags: [tagRow('EndDate', 'date', 'SalesTransaction', ST)] });
    expect((await fetchContextTagBindings(conn, 'Auto_Silver', ['EndDate'])).size).to.equal(0);
  });

  it('resolves a tag whose title carries spaces, keeping the raw title', async () => {
    const conn = mockConnection({
      ...DEFAULT_TABLES,
      tags: [tagRow('Cause Of Loss', 'string', 'SalesTransaction', ST)],
    });
    const bindings = await fetchContextTagBindings(conn, 'Auto_Silver', ['Cause Of Loss']);
    expect(bindings.get('Cause Of Loss')?.tag).to.equal('Cause Of Loss');
  });

  it('never places a quote-bearing tag title into the SOQL literal', async () => {
    const seen: string[] = [];
    const conn = mockConnection({ ...DEFAULT_TABLES, seen });
    const bindings = await fetchContextTagBindings(conn, 'Auto_Silver', ["Bad' OR Title != '"]);

    expect(bindings.size).to.equal(0);
    // Refused outright: with no safe title left there is nothing to query at all.
    expect(seen).to.deep.equal([]);
  });
});
