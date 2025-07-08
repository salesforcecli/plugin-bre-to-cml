export type RuleScope = 'Product' | 'Bundle' | 'Transaction';
export type RuleConditionType = 'Tag' | 'Enum' | 'Attribute';

export type RuleConditionOperator =
  | 'Equals'
  | 'NotEquals'
  | 'LessThan'
  | 'LessThanOrEquals'
  | 'GreaterThan'
  | 'GreaterThanOrEquals'
  | 'IsNotNull'
  | 'IsNull'
  | 'Contains'
  | 'DoesNotContain'
  | 'In'
  | 'NotIn';

export type RuleActionType =
  | 'AutoAdd'
  | 'AutoRemove'
  | 'SetAttribute'
  | 'SetQuantity'
  | 'SetDefaultProduct'
  | 'SetDefaultAttributeValue'
  | 'HideAttribute'
  | 'HideAttributeValue'
  | 'HideProduct'
  | 'DisableProduct'
  | 'DisableAttributeValue'
  | 'Requires'
  | 'Excludes'
  | 'Validate';

export type QuantityScaleMethod = 'Proportional' | 'Constant';

export type RuleConditionDataType =
  | 'Text'
  | 'String'
  | 'Number'
  | 'Integer'
  | 'Percent'
  | 'Picklist'
  | 'Boolean'
  | 'MultiPicklist'
  | 'Date'
  | 'DateTime'
  | 'Currency'
  | 'Lookup';

export type UpdateCartAction = 'Validate' | 'Price';

export type ResourceValues = {
  values: Array<string | null>;
};

export type ConditionInformation = {
  type: string;
  name: string;
  values: ResourceValues;
};

export type Condition = {
  contextTagName?: string;
  dataType?: RuleConditionDataType;
  values: string[];
  attributeId?: string;
  attributeName?: string;
  conditionIndex?: number;
  operator: RuleConditionOperator;
  type: RuleConditionType;
};

export type RuleCriteria = {
  rootObjectId: string;
  sourceDataType?: string;
  sourceContextTagName?: string;
  sourceOperator?: RuleConditionOperator;
  sourceValues: string[];
  sourceInformation: ConditionInformation[];
  conditionExpression?: string;
  criteriaIndex?: number;
  conditions?: Condition[];
};

export type RuleAction = {
  name: string;
  message?: string;
  actionType: RuleActionType;
  behaviorTypeLock?: boolean;
  messageType?: string;
  sequence?: number;
  targetValues: string[];
  targetInformation: ConditionInformation[];
  targetContextTagName?: string;
  targetDataType?: RuleConditionDataType;
  targetOperator?: RuleConditionOperator;
  actionParameters?: Condition[];
  actionParametersExpression?: string;
};

export type ConfiguratorRuleInput = {
  name: string;
  apiName: string;
  description?: string;
  sequence?: number;
  usageSubType: string;
  criteriaExpressionType: string;
  startDate?: string;
  endDate?: string;
  scope: RuleScope;
  criteria: RuleCriteria[];
  actions: RuleAction[];
  productConfigurationRuleId?: string;
};
