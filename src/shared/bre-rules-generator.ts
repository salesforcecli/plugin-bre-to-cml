/*
 * Copyright 2025, Salesforce, Inc.
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
import { CML_DATA_TYPES, CONSTRAINT_TYPES } from './constants/constants.js';
import { extractProductIds } from './grouping.js';
import {
  BASE_LINE_ITEM_TYPE_NAME,
  CmlAttribute,
  CmlConstraint,
  CmlModel,
  CmlRelation,
  CmlType,
  VIRTUAL_QUOTE_TYPE_NAME,
} from './types/types.js';
import { Condition, ConfiguratorRuleInput, RuleAction, RuleConditionOperator, RuleCriteria } from './models.js';
import { PcmGenerator } from './pcm-generator.js';
import { Logger } from './utils/common.utils.js';

const INT_TAGS = ['LineItemQuantity'];

type IntermediateRelation = { rel: string; parent: string; target: string; neighbors: IntermediateRelation[] };
type Arc = { current: IntermediateRelation; parent: Arc | null };

function sameRels(one: IntermediateRelation, sec: IntermediateRelation): boolean {
  return one.parent === sec.parent && one.rel === sec.rel && one.target === sec.target;
}

function generatePath(arc: Arc): IntermediateRelation[] {
  let path: IntermediateRelation[] = [];
  if (arc.parent !== null) {
    path = generatePath(arc.parent);
  }

  path.push(arc.current);

  return path;
}

function calculateItermediateRelations(cmlModel: CmlModel): IntermediateRelation[] {
  const cmlTypes = cmlModel.types;
  const relations: IntermediateRelation[] = cmlTypes.flatMap((t) =>
    t.relations.map((r) => ({ parent: t.name, rel: r.name, target: r.type, neighbors: [] }))
  );
  relations.push(
    ...cmlTypes
      .filter((t) => t.isVirtualContainer)
      .flatMap((t) =>
        t.relations.flatMap((r) =>
          cmlTypes
            .filter((tt) => tt.parentType?.name === r.type)
            .map((tt) => ({ parent: t.name, rel: r.name, target: tt.name, neighbors: [] }))
        )
      )
  );

  for (const r1 of relations) {
    for (const r2 of relations) {
      if (r1.target === r2.parent) {
        r1.neighbors.push(r2);
      }
    }
  }

  return relations;
}

function handleAutoAddAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { behaviorTypeLock, message, messageType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  if (!parentTargetType) {
    targetType.addConstraint(
      CmlConstraint.createMessageConstraint(
        declaration,
        doubleQuoted(`AutoAdd (scope: ${rule.scope}): Parent type can't be null for Auto-Add action.`),
        doubleQuoted('error')
      )
    );
    //    throw new Error("Parent type can't be null for Auto-Add action.");
  } else {
    const rel = findCmlRelation(parentTargetType, targetType);
    if (rel) {
      const constraint = CmlConstraint.createRequireConstraint(
        CONSTRAINT_TYPES.REQUIRE,
        declaration,
        rel.name,
        targetType.name
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
      if (behaviorTypeLock === true) {
        (parentTargetType ?? targetType).addConstraint(
          CmlConstraint.createRuleConstraint(declaration, 'Disable', 'relation', rel.name, 'type', [targetType.name])
        );
      }
      if (message) {
        (parentTargetType ?? targetType).addConstraint(
          CmlConstraint.createMessageConstraint(
            declaration,
            doubleQuoted(`AutoAdd: ${message}`),
            doubleQuoted(messageType)
          )
        );
      }
    }
  }
}

function handleAutoRemoveAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { message, messageType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  if (!parentTargetType) {
    targetType.addConstraint(
      CmlConstraint.createMessageConstraint(
        declaration,
        doubleQuoted(`AutoRemove (scope: ${rule.scope}): Parent type can't be null for Auto-Add action.`),
        doubleQuoted('error')
      )
    );
    //    throw new Error("Parent type can't be null for Auto-Add action.");
  } else {
    const rel = findCmlRelation(parentTargetType, targetType);
    if (rel) {
      const constraint = CmlConstraint.createRequireConstraint(
        CONSTRAINT_TYPES.EXCLUDE,
        declaration,
        rel.name,
        targetType.name
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
      if (message) {
        (parentTargetType ?? targetType).addConstraint(
          CmlConstraint.createMessageConstraint(
            declaration,
            doubleQuoted(`AutoRemove: ${message}`),
            doubleQuoted(messageType)
          )
        );
      }
    }
  }
}

function handleSetAttributeAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionParameters, behaviorTypeLock, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  for (const { attributeId, attributeName, dataType, values } of (actionParameters ?? []).filter(
    ({ type }) => type === 'Attribute'
  )) {
    if (attributeName) {
      const targetValue = values[0];
      const targetAttribute = getTargetAttribute(targetType, attributeId, attributeName, dataType ?? 'Text');
      const constraint = new CmlConstraint(
        CONSTRAINT_TYPES.CONSTRAINT,
        `${declaration} && (${attributeName} == ${
          targetAttribute.type === 'string' ? doubleQuoted(targetValue) : targetValue ?? ''
        })`
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
      if (behaviorTypeLock === true) {
        (parentTargetType ?? targetType).addConstraint(
          CmlConstraint.createRuleConstraint(declaration, 'Disable', 'attribute', targetAttribute.name)
        );
      }
    }
  }
}

function handleSetQuantityAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionParameters, message, messageType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  const constraint = CmlConstraint.createMessageConstraint(
    declaration,
    doubleQuoted(
      `[Not-Supported] SetQuantity: ${message ?? ''}. Please set quantity ${
        actionParameters?.[0]?.values?.[0] ?? ''
      } for type ${targetType.name}${parentTargetType ? ` of parent type ${parentTargetType.name}` : ''} manually.`
    ),
    doubleQuoted(messageType)
  );
  const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
  constraint.setProperties({ sequence: sequenceValue });
  (parentTargetType ?? targetType).addConstraint(constraint);
}

function handleSetDefaultProductAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { message, messageType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  const constraint = CmlConstraint.createMessageConstraint(
    declaration,
    doubleQuoted(`[Not-Supported] SetDefaultProduct: ${message ?? ''}`),
    doubleQuoted(messageType)
  );
  const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
  constraint.setProperties({ sequence: sequenceValue });
  (parentTargetType ?? targetType).addConstraint(constraint);
}

function handleSetDefaultAttributeValueAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { message, messageType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  const constraint = CmlConstraint.createMessageConstraint(
    declaration,
    doubleQuoted(`[Not-Supported] SetDefaultAttributeValue: ${message ?? ''}`),
    doubleQuoted(messageType)
  );
  const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
  constraint.setProperties({ sequence: sequenceValue });
  (parentTargetType ?? targetType).addConstraint(constraint);
}

function handleHideAttributeAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionParameters, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  for (const { attributeId: targetAttributeId, attributeName: targetAttributeName } of (actionParameters ?? []).filter(
    ({ type }) => type === 'Attribute'
  )) {
    if (targetAttributeId && targetAttributeName) {
      const constraint = CmlConstraint.createRuleConstraint(declaration, 'Hide', 'attribute', targetAttributeName);
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
    }
  }
}

function handleHideDisableAttributeValueAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionParameters, actionType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  for (const { attributeId: targetAttributeId, attributeName: targetAttributeName, values: targetAttributeValues } of (
    actionParameters ?? []
  ).filter(({ type }) => type === 'Attribute')) {
    if (targetAttributeId && targetAttributeName) {
      const constraint = CmlConstraint.createRuleConstraint(
        declaration,
        actionType === 'HideAttributeValue' ? 'Hide' : 'Disable',
        'attribute',
        targetAttributeName,
        'value',
        targetAttributeValues
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
    }
  }
}

function handleHideDisableProductAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionType, sequence }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  if (!parentTargetType) {
    targetType.addConstraint(
      CmlConstraint.createMessageConstraint(
        declaration,
        doubleQuoted(`${actionType} (scope: ${rule.scope}): Parent type can't be null for ${actionType} action.`),
        doubleQuoted('error')
      )
    );
    //    throw new Error("Parent type can't be null for Auto-Add action.");
  } else {
    const rel = findCmlRelation(parentTargetType, targetType);
    if (rel) {
      const constraint = CmlConstraint.createRuleConstraint(
        declaration,
        actionType === 'HideProduct' ? 'Hide' : 'Disable',
        'relation',
        rel.name,
        'type',
        [targetType.name]
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
    }
  }
}

function handleExcludesRequiresAction(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  declaration: string,
  { actionType, sequence, targetInformation }: RuleAction,
  rule: ConfiguratorRuleInput
): void {
  if (!parentTargetType) {
    (parentTargetType ?? targetType).addConstraint(
      CmlConstraint.createMessageConstraint(
        declaration,
        doubleQuoted(`${actionType}: Parent type can't be null for ${actionType} action.`),
        doubleQuoted('error')
      )
    );
    //    throw new Error("Parent type can't be null for Auto-Add action.");
  } else {
    const rel = findCmlRelation(parentTargetType, targetType);
    if (rel) {
      const productId = targetInformation.find((ti) => ti.name === 'Product')?.values.values[0];
      const constraint = CmlConstraint.createMessageConstraint(
        declaration,
        doubleQuoted(
          `Product with ID ${productId ?? '{ID NOT FOUND}'} ${
            actionType === 'Requires' ? 'should be added' : 'is excluded'
          }`
        ),
        doubleQuoted('error')
      );
      const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
      constraint.setProperties({ sequence: sequenceValue });
      (parentTargetType ?? targetType).addConstraint(constraint);
    }
  }
}

function findCmlRelation(
  parentType: CmlType,
  targetType: CmlType,
  includeVirtualParent: boolean = false
): CmlRelation | null {
  //    if (targetType.parentType?.name !== parentType.name) {
  //      throw new Error(`Type ${targetType.name} isn't a child of ${parentType.name}.`);
  //    }
  for (const rel of parentType.relations.values()) {
    if (
      rel.type === targetType.name ||
      ((includeVirtualParent || !targetType.parentType?.properties['virtual']) &&
        rel.type === targetType.parentType?.name)
    ) {
      return rel;
    }
  }
  return null;
}

function acceptCriteriaConstraints(
  parentTargetType: CmlType | null,
  targetType: CmlType,
  criteriaConstraints: CmlConstraint[]
): string {
  if (parentTargetType) {
    criteriaConstraints.forEach((c) => parentTargetType.addConstraint(c));
  } else {
    criteriaConstraints.forEach((c) => targetType.addConstraint(c));
  }

  return criteriaConstraints.length > 0 ? criteriaConstraints.map((c) => c.name).join(' && ') : 'true';
}

function getTargetAttribute(
  targetType: CmlType,
  targetAttributeId: string | null | undefined,
  targetAttributeName: string,
  targetDataType: string
): CmlAttribute {
  let targetAttribute =
    (targetAttributeId && targetType.findAttributeById(targetAttributeId)) ??
    targetType.getAttribute(targetAttributeName);
  if (!targetAttribute) {
    targetType.addAttribute(
      (targetAttribute = new CmlAttribute(
        targetAttributeId ?? null,
        targetAttributeName,
        INT_TAGS.includes(targetAttributeName)
          ? CML_DATA_TYPES.INTEGER
          : PcmGenerator.dataTypeNameToCmlDataType(targetDataType)
      ))
    );
  }
  return targetAttribute;
}

function doubleQuotedIfNeeded(value: string | undefined, dataType: string | undefined): string {
  return `${dataType === 'string' ? doubleQuoted(value) ?? '' : value ?? "''"}`;
}

function doubleQuoted(string: string | undefined): string {
  if (string) {
    return `"${string}"`;
  }
  return string ?? "''";
}

function convertToCmlExpression(
  left: string,
  ruleExprOperator: RuleConditionOperator,
  right?: string | string[],
  dataType?: string
): string {
  switch (ruleExprOperator) {
    case 'Equals':
      return `${left} == ${doubleQuotedIfNeeded(right as string | undefined, dataType)}`;
    case 'NotEquals':
      return `${left} != ${doubleQuotedIfNeeded(right as string | undefined, dataType)}`;
    case 'LessThan':
      return `${left} <= ${(right as string | undefined) ?? ''}`;
    case 'LessThanOrEquals':
      return `${left} <= ${(right as string | undefined) ?? ''}`;
    case 'GreaterThan':
      return `${left} > ${(right as string | undefined) ?? ''}`;
    case 'GreaterThanOrEquals':
      return `${left} >= ${(right as string | undefined) ?? ''}`;
    case 'IsNotNull':
      return `${left} != null`;
    case 'IsNull':
      return `${left} == null`;
    case 'Contains':
      return `strcontain(${left}, ${doubleQuoted(right as string | undefined)})`;
    case 'DoesNotContain':
      return `!strcontain(${left}, ${doubleQuoted(right as string | undefined)})`;
    case 'In':
      return `${left} in [${(Array.isArray(right) ? right : [right as string])
        .map((r) => doubleQuoted(r))
        .join(', ')}]`;
    case 'NotIn':
      return `!(${left} in [${(Array.isArray(right) ? right : [right as string])
        .map((r) => doubleQuoted(r))
        .join(', ')}])`;
  }

  //  throw new Error(`Operator ${ruleExprOperator} is not supported.`);
}

export class BreRulesGenerator {
  readonly #logger: Logger;
  readonly #virtualRoot: CmlType;
  readonly #cmlModel: CmlModel;
  readonly #breRulesGroup: ConfiguratorRuleInput[];

  readonly #intermediateRelations: IntermediateRelation[];

  private constructor(cmlModel: CmlModel, breRulesGroup: ConfiguratorRuleInput[], logger: Logger) {
    this.#logger = logger;
    this.#cmlModel = cmlModel;
    this.#breRulesGroup = breRulesGroup;

    this.#virtualRoot = new CmlType(VIRTUAL_QUOTE_TYPE_NAME, undefined, undefined);
    this.#virtualRoot.setProperties({ virtual: true });
    const lineItemRelation = new CmlRelation('lineItems', BASE_LINE_ITEM_TYPE_NAME);
    lineItemRelation.setProperties({ sourceContextNode: 'SalesTransaction.SalesTransactionItem' });
    this.#virtualRoot.addRelation(lineItemRelation);
    this.#cmlModel.addType(this.#virtualRoot);

    this.#intermediateRelations = calculateItermediateRelations(this.#cmlModel);
  }

  public static generateConstraints(cmlModel: CmlModel, breRulesGroup: ConfiguratorRuleInput[], logger: Logger): void {
    new BreRulesGenerator(cmlModel, breRulesGroup, logger).generate();
  }

  //  private info(msg: string): void {
  //    this.#logger.info(msg);
  //  }

  private warn(msg: string): void {
    this.#logger.warn(msg);
  }

  //  private error(msg: string): void {
  //    this.#logger.error(msg);
  //  }

  private generate(): void {
    for (const rule of this.#breRulesGroup) {
      try {
        const ruleProductIds = extractProductIds(rule);
        if (ruleProductIds.size < 1) {
          continue;
        }
        const criteriaConstraints: CmlConstraint[] = [];
        for (const criterion of rule.criteria) {
          const criteriaConstraint = this.convertCriteria(rule, criterion);
          criteriaConstraints.push(criteriaConstraint);
        }
        for (const action of rule.actions) {
          this.convertAction(rule, action, criteriaConstraints);
        }
      } catch (e) {
        this.warn(`❌  Failed to convert rule ${rule.apiName}. Error: ${(e as Error)?.message}\nSkip it.`);
      }
    }

    if (!this.#virtualRoot.constraints.length) {
      this.#cmlModel.deleteType(this.#virtualRoot);
    }
  }

  private convertCriteria(rule: ConfiguratorRuleInput, criteria: RuleCriteria): CmlConstraint {
    const targetType = this.findTargetTypeForCriteria(rule, criteria);
    if (!targetType) {
      throw new Error(
        `Can't find target CML type for criteria: ${rule.apiName}_criteria_${criteria.criteriaIndex ?? 0}`
      );
    }
    const criteriaConstraintName = `${rule.apiName}_criteria_${criteria.criteriaIndex ?? 0}`;
    const sourceType = this.#cmlModel.getTypeByProductId(criteria.sourceValues[0]);
    if (!sourceType) {
      throw new Error(
        `Can't find source CML type for criteria: ${rule.apiName}_criteria_${criteria.criteriaIndex ?? 0}`
      );
    }
    const conditionExpressions: string[] = [];
    if (['Bundle', 'Transaction'].includes(rule.scope)) {
      if (['Contains', 'DoesNotContain', 'Equals'].includes(criteria.sourceOperator ?? '')) {
        const rels: IntermediateRelation[][] = this.xFindAllPaths(targetType.name, sourceType.name);
        const transactionCaseExpressions: string[] = rels.map(
          (rrs) => `${rrs.map((r) => `${r.rel}[${r.target}]`).join('.')}`
        );
        if (['Contains', 'Equals'].includes(criteria.sourceOperator ?? '')) {
          conditionExpressions.push(`(${transactionCaseExpressions.map((e) => `${e} > 0`).join(' || ')})`);
        } else {
          conditionExpressions.push(`(${transactionCaseExpressions.map((e) => `${e} == 0`).join(' && ')})`);
        }
      }
    }
    for (const c of criteria.conditions ?? []) {
      const expr = this.convertRuleConditionToCmlExpression(c, sourceType, targetType);
      if (expr) {
        conditionExpressions.push(expr);
      }
    }
    const constraint = new CmlConstraint(
      CONSTRAINT_TYPES.CONSTRAINT,
      conditionExpressions.length ? `${conditionExpressions.join(' && ')}` : 'true'
    );
    constraint.name = criteriaConstraintName;
    return constraint;
  }

  private xFindAllPaths(fromType: string, toType: string): IntermediateRelation[][] {
    const paths: IntermediateRelation[][] = [];
    const starts = this.#intermediateRelations.filter((r) => r.parent === fromType);
    const ends = this.#intermediateRelations.filter((r) => r.target === toType);

    for (const start of starts) {
      for (const end of ends) {
        const found = this.xFindPath(this.#intermediateRelations, start, end);
        if (found.length > 0) {
          paths.push(found);
        }
      }
    }

    return paths;
  }

  private xFindPath(
    relations: IntermediateRelation[],
    start: IntermediateRelation,
    end: IntermediateRelation
  ): IntermediateRelation[] {
    this.#cmlModel.getType(start.parent);
    const rels = relations.map((r) => ({ ...r }));
    for (const r1 of rels) {
      for (const r2 of rels) {
        if (r1.target === r2.parent) {
          r1.neighbors.push(r2);
        }
      }
    }

    const queue: Arc[] = [];
    const visited: IntermediateRelation[] = [];

    queue.push({ current: start, parent: null });
    while (queue.length > 0) {
      const arc = queue.pop()!;
      if (sameRels(arc.current, end)) {
        return generatePath(arc);
      }

      if (!visited.some((v) => sameRels(v, arc.current))) {
        visited.push(arc.current);
        for (const neighbor of arc.current.neighbors) {
          if (!visited.some((v) => sameRels(v, neighbor))) {
            queue.push({ current: neighbor, parent: arc });
          }
        }
      }
    }

    return [];
  }

  private getExprLeftPrefix(parentType: CmlType, targetType: CmlType): string {
    if (parentType.name !== targetType.name) {
      return (
        this.xFindAllPaths(parentType.name, targetType.name)
          .find((paths) => paths.length > 0)
          ?.map(({ rel, target }) => `${rel}[${target}].`)
          .join('') ?? ''
      );
    }
    return '';
  }

  private convertRuleConditionToCmlExpression(
    condition: Condition,
    targetType: CmlType,
    parentType?: CmlType | null
  ): string | null {
    const leftPrefix = (parentType && this.getExprLeftPrefix(parentType, targetType)) ?? '';
    if (condition.type === 'Attribute') {
      const { attributeId, attributeName, dataType, operator, values } = condition;
      if (attributeName) {
        const targetAttribute = getTargetAttribute(targetType, attributeId, attributeName, dataType ?? 'Text');
        return convertToCmlExpression(leftPrefix + targetAttribute.name, operator, values, targetAttribute.type);
      }
    } else if (condition.type === 'Tag') {
      const { contextTagName, dataType, operator, values } = condition;
      if (contextTagName) {
        const targetAttribute = getTargetAttribute(targetType, null, contextTagName, dataType ?? 'Text');
        return convertToCmlExpression(leftPrefix + contextTagName, operator, values, targetAttribute.type);
      }
    }

    return null;
  }

  private findTargetTypeForCriteria(rule: ConfiguratorRuleInput, criterion: RuleCriteria): CmlType | null {
    if (rule.scope === 'Transaction') {
      return this.#virtualRoot;
    }
    const productId = criterion.rootObjectId ?? criterion.sourceValues[0];
    if (productId) {
      return this.#cmlModel.getTypeByProductId(productId) ?? null;
    }
    return null;
  }

  private findTargetTypeForAction(
    rule: ConfiguratorRuleInput,
    ruleAction: RuleAction
  ): { parentTargetType: CmlType | null; targetType: CmlType | null } | null {
    const productId = ruleAction.targetInformation.find((ti) => ti.name === 'Product')?.values.values[0];
    if (productId) {
      const parentTargetType =
        rule.scope === 'Transaction'
          ? this.#virtualRoot
          : rule.scope === 'Bundle'
          ? this.findParentTargetType(ruleAction) ??
            rule.criteria.map((c) => this.findTargetTypeForCriteria(rule, c))[0]
          : null;
      const targetType = this.#cmlModel.getTypeByProductId(productId) ?? null;
      return { parentTargetType, targetType };
    }
    return null;
  }

  private findParentTargetType(ruleAction: RuleAction): CmlType | null {
    if (ruleAction.targetContextTagName === 'ProductRelationComponent') {
      const targetValue = ruleAction.targetValues[0];
      return (
        this.#cmlModel.types.find((t) => Array.from(t.relations).some((r) => r.prcIds.includes(targetValue))) ?? null
      );
    }
    return null;
  }

  private convertAction(
    rule: ConfiguratorRuleInput,
    ruleAction: RuleAction,
    criteriaConstraints: CmlConstraint[]
  ): void {
    const { parentTargetType, targetType } = this.findTargetTypeForAction(rule, ruleAction) ?? {
      parentTargetType: null,
    };
    if (targetType) {
      const declaration = acceptCriteriaConstraints(parentTargetType, targetType, criteriaConstraints);
      switch (ruleAction.actionType) {
        case 'AutoAdd':
          handleAutoAddAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
        case 'AutoRemove':
          handleAutoRemoveAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
        case 'SetAttribute':
          handleSetAttributeAction(parentTargetType, targetType, declaration, ruleAction, rule);
          break;
        case 'SetQuantity':
          handleSetQuantityAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
        case 'SetDefaultProduct':
          handleSetDefaultProductAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
        case 'SetDefaultAttributeValue':
          handleSetDefaultAttributeValueAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
        case 'HideAttribute':
          handleHideAttributeAction(parentTargetType, targetType, declaration, ruleAction, rule);
          break;
        case 'HideAttributeValue':
        case 'DisableAttributeValue':
          handleHideDisableAttributeValueAction(parentTargetType, targetType, declaration, ruleAction, rule);
          break;
        case 'HideProduct':
        case 'DisableProduct':
          handleHideDisableProductAction(parentTargetType, targetType, declaration, ruleAction, rule);
          break;
        case 'Excludes':
        case 'Requires':
          handleExcludesRequiresAction(parentTargetType, targetType, declaration, ruleAction, rule);
          break;
        case 'Validate':
          this.handleValidateAction(parentTargetType, targetType, declaration, ruleAction, rule);
          return;
      }
      if (ruleAction.message) {
        (parentTargetType ?? targetType).addConstraint(
          CmlConstraint.createMessageConstraint(
            declaration,
            doubleQuoted(`${ruleAction.actionType}: ${ruleAction.message}`),
            doubleQuoted(ruleAction.messageType)
          )
        );
      }
    }
  }

  private handleValidateAction(
    parentTargetType: CmlType | null,
    targetType: CmlType,
    declaration: string,
    { actionParameters, message, messageType, sequence }: RuleAction,
    rule: ConfiguratorRuleInput
  ): void {
    const validationParts: string[] = [];
    for (const ap of actionParameters ?? []) {
      const part = this.convertRuleConditionToCmlExpression(ap, targetType, parentTargetType);
      if (part) {
        validationParts.push(part);
      }
    }
    const constraint = CmlConstraint.createMessageConstraint(
      `${declaration} && !(${validationParts.join(' || !')})`,
      doubleQuoted(`Validate: ${message ?? ''}`),
      doubleQuoted(messageType)
    );
    const sequenceValue = (rule.sequence ?? 0) + (sequence ?? 0);
    constraint.setProperties({ sequence: sequenceValue });
    (parentTargetType ?? targetType).addConstraint(constraint);
  }
}
