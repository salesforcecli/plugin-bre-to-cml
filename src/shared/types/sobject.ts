export type ExpressionSetConstraintObj = {
  Id: string;
  ExpressionSetId: string;
  'ExpressionSet.ApiName': string;
  ReferenceObjectId: string;
  ConstraintModelTag: string;
  ConstraintModelTagType: 'Type' | 'Port';
};

export type ExpressionSetConstraintObjCustom = ExpressionSetConstraintObj & {
  $Product2ReferenceId: string;
  $ProductClassificationName: string;
  $ProductRelatedComponentKey: string;
};
