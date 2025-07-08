/**
 * CML allows users to invoke a subset of methods via Java reflection.
 */
export const CML_METHODS = {
  GET_PROPERTY: 'getProperty',
  GET_ID: 'getId',
  GET_TYPE_NAME: 'getTypeName',
};

/**
 * CML has a set of predefined functions that can be invoked.
 */
export const CML_RELATION_ATTRIBUTE_FUNCTIONS = {
  SUM: 'sum',
  TOTAL: 'total',
  MAX: 'max',
  MIN: 'min',
  COUNT: 'count',
  JOIN: 'join',
};

/**
 * CML has a set of proxy variables.
 */
export const CML_PROXY_VARIABLES = {
  PARENT: 'parent',
  ROOT: 'root',
  SIBLING: 'sibling',
  CARDINALITY: 'cardinality',
  THIS_QUANTITY: 'this.quantity',
};

/**
 * CML variable value types.
 */
export const CML_VARIABLE_VALUE_TYPES = {
  DOMAIN: 'Domain',
  FUNCTION: 'Function',
  EXPRESSION: 'Expression',
  PROXY_VARIABLE: 'Proxy Variable',
};

/**
 * All primitive data types for CML.
 */
export const CML_DATA_TYPES = {
  BOOLEAN: 'boolean',
  DATE: 'date',
  DECIMAL: 'decimal',
  DOUBLE: 'double',
  INTEGER: 'int',
  STRING: 'string',
  STRING_ARRAY: 'string[]',
};

/**
 * Display names of primitive data types for CML.
 */
export const CML_DATA_TYPE_DISPLAY_NAMES = {
  int: 'Integer',
  boolean: 'Boolean',
  date: 'Date',
  decimal: 'Decimal',
  double: 'Double',
  string: 'String',
  'string[]': 'String Array',
};

/**
 * Subset of data types that are numbers.
 */
export const CML_NUMBER_DATA_TYPES = {
  DECIMAL: 'decimal',
  DOUBLE: 'double',
  INTEGER: 'int',
};

/**
 * All the constraint types.
 *
 * @type {Set<string>}
 */
export const CONSTRAINT_TYPES = {
  BELONG: 'belong',
  CONSTRAINT: 'constraint',
  DISTINCT: 'distinct',
  EQUAL: 'equal',
  EXCLUDE: 'exclude',
  INCLUDE: 'include',
  MESSAGE: 'message',
  PREFERENCE: 'preference',
  REQUIRE: 'require',
  RULE: 'rule',
  SEQUENTIAL: 'sequential',
  ACTION: 'action',
  SET: 'set',
  CONSTRUCTOR: 'constructor',
  UNKNOWN: 'unknown',
};

/**
 * All the CML association types.
 */
export type AssociationType = 'Type' | 'Port';
export const ASSOCIATION_TYPES: Record<'TYPE' | 'RELATION', AssociationType> = {
  TYPE: 'Type',
  RELATION: 'Port',
};
