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
// reviews that file and applies its changes to the org separately — this
// plugin emits the manifest but does not apply it. See
// docs/insurance-export-review-import-redesign.md §3.
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
  // Record Name -- REQUIRED. [Fix #14] This is ADVISORY context for the operator/apply tool, not
  // an enforced check by this plugin. Convert is file-only and does NOT write to the org; whether
  // Name is actually cross-checked against the org as an identity guard is the responsibility of
  // whichever apply tool consumes this manifest.
  name: string;
  // UnderwritingRule only: the rule ApiName. [Fix #14] Same status as `name` -- ADVISORY context
  // for the apply tool; whether it functions as a second identity guard alongside Name is up to
  // that tool, not this plugin.
  apiName?: string;
  fields: RecordUpdateField[];
  // Surcharge only: the convert-computed pathed rule key the CML `rule(...)` was emitted under.
  // [Fix #14] ADVISORY -- meant as a verification key for an apply tool. NOT written to the org
  // (the platform auto-generates ProductSurcharge.RuleKey when RuleEngineType flips); a mismatch
  // is what an apply tool MAY use to detect that the surcharge will silently not fire. This
  // plugin emits it but does not consume it.
  expectedRuleKey?: string;
  // Surcharge only: source ProductCodes (ordered ProductPath segments) at convert time. [Fix #14]
  // ADVISORY drift-detection input -- an apply tool consuming this manifest MAY compare against
  // the org's current ProductCodes to flag ProductCode/ProductPath drift that would desync the
  // platform-generated RuleKey. This plugin does not perform that comparison itself.
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
