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
import {
  PlannedChange,
  PlannedChangeOperation,
  PlannedChangeText,
  countPlannedChanges,
  formatChange,
  renderPlannedChanges,
  truncateCell,
} from '../../../src/shared/insurance/planned-change.js';
import { formatBlobChange, formatBlobSummary } from '../../../src/shared/insurance/record-update-plan.js';

const row = (operation: PlannedChangeOperation): PlannedChange => ({
  operation,
  object: 'ProductSurcharge',
  id: 'a0p000000000001',
  name: 'Collision Fee',
  field: 'RuleEngineType',
  change: 'BusinessRuleEngine → ConstraintEngine',
});

/**
 * A realistic org `DynamicRuleDefinition`: several hundred characters whose leading segment is
 * unchanged by convert. This is the shape that made a truncated raw diff useless.
 */
const orgBlob = JSON.stringify({
  apiName: 'MinDriverAgeRule',
  description: 'Driver must be at least 21 years old to qualify for this policy tier',
  name: 'Min Driver Age',
  productPath: '01tROOT00000000001/01tAUTO00000000001',
  ruleKey: null,
  ruleCriteria: [
    {
      rootObjectId: '01tAUTO00000000001',
      criteriaIndex: 0,
      conditions: [{ attributeName: 'DriverAge', operator: 'GreaterThanOrEqual', values: ['21'], dataType: 'Number' }],
    },
  ],
  underwritingRuleGroup: { fromStage: 'Submitted', toStage: 'Quoted', ruleEngineType: 'BusinessRuleEngine' },
  status: 'Active',
});

/** Exactly the mutation convert performs (cml/convert/underwriting-rules.ts buildRecordUpdates). */
const convertedBlob = ((): string => {
  const defn = JSON.parse(orgBlob) as Record<string, unknown>;
  defn.ruleKey = 'UW__auto__minDriverAge';
  (defn.underwritingRuleGroup as Record<string, unknown>).ruleEngineType = 'ConstraintEngine';
  return JSON.stringify(defn);
})();

describe('planned-change countPlannedChanges', () => {
  it('counts an unresolved-FK create as a create', () => {
    expect(countPlannedChanges([row('Create (UNRESOLVED FK)')])).to.deep.equal({
      creates: 1,
      updates: 0,
      reuses: 0,
      skips: 0,
    });
  });

  it('buckets every operation, so the counts always sum to the row total', () => {
    const all: PlannedChangeOperation[] = [
      'Create',
      'Create (UNRESOLVED FK)',
      'Update',
      'Reuse',
      'Skip (already current)',
    ];
    const rows = all.map(row);
    const counts = countPlannedChanges(rows);

    expect(counts).to.deep.equal({ creates: 2, updates: 1, reuses: 1, skips: 1 });
    expect(counts.creates + counts.updates + counts.reuses + counts.skips).to.equal(rows.length);
  });
});

describe('planned-change truncateCell', () => {
  it('leaves a value at the boundary alone and truncates one past it', () => {
    expect(truncateCell('x'.repeat(59))).to.equal('x'.repeat(59));
    expect(truncateCell('x'.repeat(60))).to.equal('x'.repeat(60));
    expect(truncateCell('x'.repeat(61))).to.equal(`${'x'.repeat(59)}…`);
    // Whatever the input, a rendered cell never exceeds the column budget.
    expect(truncateCell('x'.repeat(200))).to.have.length(60);
    expect(truncateCell('short')).to.equal('short');
  });

  it('never returns more characters than the max it was given', () => {
    // slice(0, max - 1) went negative below max=1, slicing from the end and returning a string
    // LONGER than the budget with a character missing from the middle.
    expect(truncateCell('abcde', 0)).to.equal('…');
    expect(truncateCell('abcde', 1)).to.equal('…');
    expect(truncateCell('abcde', 3)).to.equal('ab…');
  });

  it('does not split a surrogate pair when it truncates', () => {
    const truncated = truncateCell('🚗'.repeat(40));

    expect(
      /[\uD800-\uDBFF]/.test(truncated.slice(-2, -1)),
      `lone high surrogate in ${JSON.stringify(truncated)}`
    ).to.equal(false);
    expect(truncated.endsWith('…')).to.equal(true);
    expect(truncated).to.have.length.at.most(60);
  });
});

describe('planned-change renderPlannedChanges', () => {
  const changes: PlannedChange[] = [
    {
      operation: 'Update',
      object: 'ProductSurcharge',
      id: 'a0p000000000001',
      name: 'Collision Fee',
      field: 'RuleEngineType',
      change: 'BusinessRuleEngine → ConstraintEngine',
    },
    {
      operation: 'Skip (already current)',
      object: 'ProductSurcharge',
      id: 'a0p000000000002',
      name: 'Theft Fee',
      field: 'RuleEngineType',
      change: 'ConstraintEngine (unchanged)',
    },
  ];

  it('counts operations by bucket', () => {
    expect(countPlannedChanges(changes)).to.deep.equal({ creates: 0, updates: 1, reuses: 0, skips: 1 });
  });

  type Captured = {
    headers: string[];
    rows: Array<Record<string, unknown>>;
    logs: string[];
    warnings: string[];
  };

  const render = (text: PlannedChangeText): Captured => {
    const captured: Captured = { headers: [], rows: [], logs: [], warnings: [] };
    renderPlannedChanges(
      {
        styledHeader: (t: string) => captured.headers.push(t),
        table: (options) => {
          captured.rows = options.data;
        },
        log: (m: string) => captured.logs.push(m),
        warn: (m: string) => captured.warnings.push(m),
      },
      changes,
      text
    );
    return captured;
  };

  it('renders a header, one row per change, and the summary', () => {
    const captured = render({
      header: 'These changes will be applied to me@example.com',
      summary: '1 to update',
      notTransactional: 'NOT rolled back',
    });

    expect(captured.headers).to.deep.equal(['These changes will be applied to me@example.com']);
    expect(captured.rows).to.have.length(2);
    expect(captured.rows[0]).to.deep.equal({
      Operation: 'Update',
      Object: 'ProductSurcharge',
      Id: 'a0p000000000001',
      Name: 'Collision Fee',
      Field: 'RuleEngineType',
      Change: 'BusinessRuleEngine → ConstraintEngine',
    });
    // The summary is informational, and it is the whole output of a dry run. Emitting it through
    // warn() sends it to stderr (so `... --dry-run > plan.txt` loses it) and puts boilerplate in
    // every successful --json run's `warnings` array.
    expect(captured.logs).to.deep.equal(['1 to update']);
    // The non-transactional notice is a genuine caution, so it stays a warning.
    expect(captured.warnings).to.deep.equal(['NOT rolled back']);
  });

  it('omits the non-transactional notice when the caller will not write', () => {
    const captured = render({
      header: 'These changes will be applied to me@example.com',
      summary: '1 to update',
    });

    expect(captured.warnings, 'a read-only path has no partial-migration hazard to warn about').to.deep.equal([]);
    expect(captured.logs).to.deep.equal(['1 to update']);
    expect(captured.rows, 'the preview itself is still rendered').to.have.length(2);
  });
});

describe('planned-change formatChange', () => {
  it('shows an empty current value as (none)', () => {
    expect(formatChange(null, 'ConstraintEngine')).to.equal('(none) → ConstraintEngine');
    expect(formatChange('', 'ConstraintEngine')).to.equal('(none) → ConstraintEngine');
  });

  it('renders a realistic DynamicRuleDefinition identically on both sides (why the blob needs a semantic diff)', () => {
    const [before, after] = formatChange(orgBlob, convertedBlob).split(' → ');

    expect(orgBlob, 'fixture sanity: the blobs really do differ').to.not.equal(convertedBlob);
    expect(before, 'a raw truncated diff cannot show a blob mutation past char 60').to.equal(after);
  });
});

describe('planned-change DynamicRuleDefinition semantic diff', () => {
  it('shows the operator both mutated fields, with visibly different sides', () => {
    const rendered = formatBlobChange(orgBlob, convertedBlob);

    expect(rendered).to.equal(
      'ruleKey: (none) → UW__auto__minDriverAge, ' +
        'underwritingRuleGroup.ruleEngineType: BusinessRuleEngine → ConstraintEngine'
    );
  });

  it('renders (none) for a record that has no blob yet', () => {
    expect(formatBlobChange(null, convertedBlob)).to.equal(
      'ruleKey: (none) → UW__auto__minDriverAge, underwritingRuleGroup.ruleEngineType: (none) → ConstraintEngine'
    );
  });

  it('declines to render when either side is unreadable, so the caller falls back to the raw diff', () => {
    expect(formatBlobChange('{broken', convertedBlob)).to.equal(undefined);
    expect(formatBlobChange(orgBlob, '{broken')).to.equal(undefined);
  });

  it('summarizes an unchanged blob by the same mutated fields', () => {
    expect(formatBlobSummary(convertedBlob)).to.equal(
      'ruleKey: UW__auto__minDriverAge, underwritingRuleGroup.ruleEngineType: ConstraintEngine'
    );
    expect(formatBlobSummary('{broken')).to.equal(undefined);
    expect(formatBlobSummary(null)).to.equal(undefined);
  });
});

/**
 * The B1 invariant, as a predicate: a cell whose every `label: before → after` pair renders the
 * same string on both sides has shown the operator nothing, whatever the row's Operation says.
 */
const rendersOnlyIdenticalPairs = (cell: string): boolean => {
  const pairs = [...cell.matchAll(/: ([^,;]*) → ([^,;]*)/g)];
  return pairs.length > 0 && pairs.every(([, before, after]) => before === after);
};

/**
 * B2 made the already-current decision compare the WHOLE blob document, while the preview kept
 * rendering only the two fields convert mutates. A row can therefore be an `Update` whose every
 * displayed pair is identical — the operator is told the record will be rewritten and shown nothing
 * that differs. These pin the disclosure that closes that gap.
 */
describe('planned-change DynamicRuleDefinition differences outside the mutated fields', () => {
  /** The reviewer lowered the minimum driver age; both mutated fields were already current. */
  const handCorrected = convertedBlob.replace('"21"', '"18"');

  it('discloses the other difference instead of rendering a cell of identical pairs', () => {
    // Verbatim from the live-org run: `ruleKey: X → X, underwritingRuleGroup.ruleEngineType: Y → Y`
    // on a row marked Update, with no way to see what actually differed.
    const rendered = formatBlobChange(convertedBlob, handCorrected);

    expect(rendered, 'both sides parse, so the semantic renderer must still own the cell').to.not.equal(undefined);
    expect(rendersOnlyIdenticalPairs(rendered ?? ''), `useless cell: ${rendered ?? ''}`).to.equal(false);
    expect(rendered).to.equal(
      'ruleKey and underwritingRuleGroup.ruleEngineType unchanged; ' +
        '1 other field differs: ruleCriteria[0].conditions[0].values[0]'
    );
  });

  it('keeps the mutated diff and appends the rest when both changed', () => {
    const current = orgBlob.replace('policy tier', 'policy band');
    const rendered = formatBlobChange(current, convertedBlob);

    expect(rendered).to.equal(
      'ruleKey: (none) → UW__auto__minDriverAge, ' +
        'underwritingRuleGroup.ruleEngineType: BusinessRuleEngine → ConstraintEngine; ' +
        'also 1 other field differs: description'
    );
  });

  it('leaves the plain pairwise diff alone when only the mutated fields changed', () => {
    const rendered = formatBlobChange(orgBlob, convertedBlob);

    expect(rendered, 'the common case must not grow a clause about differences that do not exist').to.not.match(
      /other field/
    );
    expect(rendered).to.equal(
      'ruleKey: (none) → UW__auto__minDriverAge, ' +
        'underwritingRuleGroup.ruleEngineType: BusinessRuleEngine → ConstraintEngine'
    );
  });

  it('names what fits and counts the overflow, rather than dumping every path', () => {
    // Five differences whose dotted paths together run well past the cell budget.
    const edited = JSON.parse(convertedBlob) as Record<string, unknown>;
    edited.apiName = 'MinDriverAgeRuleV2';
    edited.description = 'Driver must be at least 18 years old';
    const criteria = (edited.ruleCriteria as Array<Record<string, unknown>>)[0];
    criteria.rootObjectId = '01tMOTO00000000001';
    ((criteria.conditions as Array<Record<string, unknown>>)[0].values as string[])[0] = '18';
    (edited.underwritingRuleGroup as Record<string, unknown>).fromStage = 'Draft';
    const rendered = formatBlobChange(convertedBlob, JSON.stringify(edited)) ?? '';

    expect(rendered).to.match(/^ruleKey and underwritingRuleGroup\.ruleEngineType unchanged; 5 other fields differ: /);
    expect(rendered, 'an operator who cannot see every path must at least know how many are hidden').to.match(
      /\+2 more$/
    );
    const named = rendered.slice(rendered.indexOf('differ: ') + 'differ: '.length);
    expect(named.length, `the disclosure must respect the cell budget: ${named}`).to.be.at.most(60);
    expect(named.split(', ')[0], 'at least one path is always named').to.equal('apiName');
  });

  it('reads an entity-encoded current blob, so the preview and the skip decision agree', () => {
    // Both read the org value through the same tolerant parse. If the preview used a stricter one it
    // would fall back to the raw diff on exactly the rows the skip decision called an Update.
    const encoded = convertedBlob.replace(/"/g, '&quot;');

    expect(formatBlobChange(encoded, handCorrected)).to.equal(
      'ruleKey and underwritingRuleGroup.ruleEngineType unchanged; ' +
        '1 other field differs: ruleCriteria[0].conditions[0].values[0]'
    );
  });

  it('says nothing about other fields when the record has no blob at all', () => {
    // There is no document to compare against, and `(none) → value` is already a visibly different
    // pair, so nothing is being hidden from the operator.
    const rendered = formatBlobChange(null, convertedBlob) ?? '';

    expect(rendered).to.not.match(/other field/);
    expect(rendersOnlyIdenticalPairs(rendered)).to.equal(false);
  });

  it('still declines the cell when the current blob cannot be read structurally', () => {
    // The contract the caller depends on: no invented value, fall back to the raw diff.
    expect(formatBlobChange('{broken', handCorrected)).to.equal(undefined);
    expect(formatBlobChange(convertedBlob, '{broken')).to.equal(undefined);
  });
});
