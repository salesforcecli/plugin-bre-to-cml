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
