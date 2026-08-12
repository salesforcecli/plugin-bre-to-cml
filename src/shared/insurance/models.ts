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
export type RuleCondition = {
  contextTagName?: string;
  operator: string;
  conditionIndex?: number;
  attributeName?: string;
  attributePicklistValueId?: string;
  attributeId?: string;
  dataType?: string;
  type?: string;
  values?: string[];
};

export type RuleCriteria = {
  rootObjectId: string;
  criteriaIndex?: number;
  sourceContextTagName?: string;
  sourceOperator?: string;
  sourceDataType?: string;
  sourceValues?: string[];
  conditions?: RuleCondition[];
};

export type UnderwritingRuleGroup = {
  fromStage?: string;
  toStage?: string;
  stageTransitionName?: string;
};

export type ParsedRuleDefinition = {
  name: string;
  apiName: string;
  productPath: string;
  status?: string;
  description?: string;
  ruleCriteria?: RuleCriteria[];
  underwritingRuleGroup?: UnderwritingRuleGroup;
  // Surcharge only: the parent Surcharge Id, carried in the ProductSurcharge RuleDefinition JSON.
  // The platform derives the leaf segment of ProductSurcharge.RuleKey from that Surcharge's Code
  // (NOT the rule apiName), so the merge resolves this Id -> Surcharge.Code to build a matching key.
  surchargeId?: string;
};

export type RuleRecord = {
  Id: string;
  Name: string;
  ProductPath: string;
};

export type RuleKeyEntry = {
  recordId: string;
  name: string;
  ruleKey: string;
};

// ---------------------------------------------------------------------------
// Record-update export artifacts (classes (b) UW update, (c) surcharge update).
//
// Convert is file-only: instead of mutating the org live, it serializes the
// exact org-record changes it used to apply into a reviewable/correctable
// `<safeApi>_{Underwriting,Surcharge}Update.json` manifest. The operator
// reviews that file and applies it with `sf insurance import record-updates`, which
// is the consumer of every field below. See the export/review/import design
// on work item W-23654540 (§3).
// ---------------------------------------------------------------------------

export type RecordUpdateField = {
  /** sObject field API name to set, e.g. 'RuleEngineType' or 'DynamicRuleDefinition'. */
  field: string;
  /** Value to write. JSON-blob fields (DynamicRuleDefinition) are stringified verbatim. */
  value: string;
};

export type RecordUpdate = {
  sobject: 'UnderwritingRuleGroup' | 'UnderwritingRule' | 'ProductSurcharge';
  /** 15/18-char Salesforce Id (re-validated on apply). */
  id: string;
  // Record Name -- REQUIRED, and ENFORCED on apply: `sf insurance import record-updates` re-reads the
  // record and refuses the whole file when the org's Name disagrees, so an edited id cannot
  // retarget a valid-but-wrong record of the same type. Convert itself still never writes.
  name: string;
  // UnderwritingRule only: the rule ApiName. ENFORCED on apply as a second identity guard
  // alongside Name, read out of the org's DynamicRuleDefinition blob. The guard fails closed: an
  // unreadable or unselected blob blocks the write rather than passing silently.
  apiName?: string;
  fields: RecordUpdateField[];
  // Surcharge only: the convert-computed pathed rule key the CML `rule(...)` was emitted under.
  // NOT written to the org -- the platform auto-generates ProductSurcharge.RuleKey when
  // RuleEngineType flips. CONSUMED on apply: the importer reads the regenerated key back after
  // the flip and warns when it does not match, which is the only way to detect that the surcharge
  // imported cleanly but will never fire.
  expectedRuleKey?: string;
  // Surcharge only: source ProductCodes (ordered ProductPath segments) at convert time. CONSUMED
  // on apply as an advisory drift check against the org's current ProductCodes, which would
  // otherwise desync the platform-generated RuleKey. Advisory only -- it never blocks.
  productCodes?: string[];
};

export type RecordUpdatePlan = {
  schemaVersion: 1;
  kind: 'underwriting-update' | 'surcharge-update';
  /** Raw CML api name (matches the .cml / RuleKeyMapping for traceability). */
  cmlApi: string;
  /** ISO timestamp, advisory (drift-detection aid). */
  generatedAt: string;
  updates: RecordUpdate[];
};
