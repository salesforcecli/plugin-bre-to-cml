export type PCMProduct = {
  id: string;
  name: string;
  productCode: string;
  nodeType: 'simpleProduct' | 'bundleProduct' | 'productClass';
  description: string;
  displayUrl: string;
  isActive: boolean;
  isAssetizable: boolean;
  isSoldOnlyWithOtherProds: boolean;
  additionalFields: Record<string, unknown>;
  attributeCategory: PCMAttributeCategory[];
  attributes: PCMProductAttribute[];
  catalogs: unknown[];
  categories: unknown[];
  childProducts: PCMProduct[];
  configureDuringSale: 'Allowed' | 'NotAllowed';
  productClassification: PCMProductClassification;
  productRelatedComponent: PCMProductRelatedComponent;
  productComponentGroups: PCMProductComponentGroup[];
  productSellingModelOptions: PCMProductSellingModelOption[];
  sequence: number;
};

export type PCMProductSellingModelOption = {
  id: string;
  isDefault: boolean;
  productId: string;
  productSellingModel: PCMProductSellingModel;
};

export type PCMProductSellingModel = {
  id: string;
  name: string;
  sellingModelType: string;
  status: string;
};

export type PCMProductComponentGroup = {
  id: string;
  code: string;
  name: string;
  parentProductId: string;
  isExcluded: boolean;
  components: PCMProduct[];
  childGroups: PCMProductComponentGroup[];
};

export type PCMProductClassification = {
  id: string;
  name: string;
};

export type PCMAttributeCategory = {
  id: string;
  name: string;
  code: string;
  attributes: PCMProductAttribute[];
};

export type PCMProductAttribute = {
  id: string;
  name: string;
  label: string;
  attributeNameOverride: string;
  developerName: string;
  dataType: string;
  additionalFields: Record<string, unknown>;
  defaultValue: string | number | boolean | undefined;
  isHidden: boolean;
  isPriceImpacting: boolean;
  isReadOnly: boolean;
  isRequired: boolean;
  picklist: PCMAttributePicklist;
  status: string;
};

export type PCMAttributePicklist = {
  id: string;
  name: string;
  dataType: string;
  values: PCMAttributePickListValue[];
};

export type PCMAttributePickListValue = {
  id: string;
  name: string;
  code: string;
  sequence: number;
  displayValue: string;
  value: string;
};

export type PCMProductRelatedComponent = {
  id: string;
  parentProductId: string;
  childProductId: string;
  productRelationshipTypeId: string;
  quantity: number;
  quantityScaleMethod?: 'Constant' | 'Proportional';
  doesBundlePriceIncludeChild: boolean;
  isComponentRequired: boolean;
  isDefaultComponent: boolean;
  isExcluded: boolean;
  isQuantityEditable: boolean;
  minQuantity: number | undefined;
  maxQuantity: number | undefined;
};
