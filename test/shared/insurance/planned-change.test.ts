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
  countPlannedChanges,
  formatChange,
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
