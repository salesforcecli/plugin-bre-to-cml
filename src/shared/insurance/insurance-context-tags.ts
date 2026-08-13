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
import { Connection } from '@salesforce/core';

/**
 * Resolution of a BRE `Tag` condition (`attributeId: null`, keyed only by `contextTagName`) against
 * the org's context metadata, so the converter can DECLARE the reference instead of emitting a bare
 * undeclared identifier.
 *
 * Why this matters: a bare undeclared identifier is not a dead rule. The CML solver rejects the
 * ENTIRE model at deploy ("Couldn't find attribute 'TotalAmount' in AutoSilver"), which disables
 * every rule in that ExpressionSet and 500s the surcharge API. Neither import nor activation
 * validates, so the gate fires at first use in production. Until this module existed the only
 * defence was `findAbsentAttributes`, which withholds such a rule outright; that withholding
 * remains the fallback for every tag this module cannot resolve.
 *
 * ---------------------------------------------------------------------------
 * The ExpressionSet -> ContextDefinition linkage
 * ---------------------------------------------------------------------------
 * Resolving a tag requires knowing WHICH ContextDefinition the model is bound to: a tag title is
 * only unique within one definition. In the reference org `EndDate` resolves to DataType `date`
 * under SalesTransaction and `datetime` under SalesTransactionItem, and there are four
 * ContextDefinitions. Nothing at deploy validates a context binding — neither `contextPath` nor
 * `attributeSource` is checked, so a wrong path compiles happily and binds to nothing — which makes
 * this resolution the only check that exists. Guessing is therefore worse than withholding.
 *
 * There is no context field on ExpressionSet, ExpressionSetDefinition, ExpressionSetDefinitionVersion
 * or ExpressionSetVersion (verified by describe). The linkage lives on a junction sObject,
 * `ExpressionSetDefinitionContextDefinition`, which this plugin's own
 * `cml import as-expression-set` already CREATES when it activates a model — so the row is the
 * platform's record of the binding the operator chose, not an inference. Corroborated independently
 * against the Metadata API: `ExpressionSetDefinition.contextDefinitions` reads back the same
 * `InsuranceDynamicTest` for `Auto_Silver`. SOQL is preferred here because it is the same idiom the
 * rest of this converter uses and does not require a metadata round-trip.
 *
 * The full chain, all verified against the reference org, each step joining to the next:
 *
 * ExpressionSetDefinition.DeveloperName (== the CML API name)
 * -> ExpressionSetDefinitionContextDefinition.ContextDefinitionId
 * -> ContextDefinitionVersion (active version preferred)
 * -> ContextNode (Title + InheritedFrom give the node's path)
 * -> ContextAttribute (DataType is authoritative for the CML type)
 * -> ContextTag (Title is what a BRE condition's contextTagName names)
 *
 * Every step that cannot be resolved unambiguously yields NO binding, which sends the rule back to
 * the withholding gate. That is deliberate: a silent mis-binding is worse than a withheld rule,
 * because the loud failure is what currently protects the model.
 */

/** Where in the context tree a tag lives, which decides how CML must bind it. */
export type ContextTagScope =
  /**
   * The tag hangs directly off the root SalesTransaction node. CML binds these with a top-level
   * `@(contextPath = "SalesTransaction.<Tag>", attributeSource = "ST") extern <type> <name>;`.
   */
  | 'transaction'
  /**
   * The tag's node path descends through SalesTransactionItem. CML binds these with an in-type
   * `@(tagName = "<Tag>") <type> <name>;` declaration.
   */
  | 'item';

export type ContextTagBinding = {
  /** Raw ContextTag.Title, exactly as the BRE condition's `contextTagName` spells it. */
  tag: string;
  /** CML declaration type derived from ContextAttribute.DataType (e.g. `date`, `decimal(2)`). */
  cmlType: string;
  /**
   * ContextAttribute.DataType verbatim (e.g. `currency`). Carried so the CONDITION can be compared
   * as the same type the declaration uses — declaring an attribute one type and comparing it as
   * another is the defect `collectAttributeTypes` already guards against on the attribute path.
   */
  sourceDataType: string;
  scope: ContextTagScope;
};

/** Raw ContextTag.Title -> its resolved binding. A tag absent from this map must be withheld. */
export type ContextTagBindings = ReadonlyMap<string, ContextTagBinding>;

/**
 * ContextAttribute.DataType -> the CML type to DECLARE the reference as. Keyed uppercase because
 * the platform's spellings are lowercase but nothing guarantees that.
 *
 * `currency` maps to `decimal(2)` rather than a bare `decimal` to match the scale the curated model
 * already uses for a currency-backed tag (`@(tagName = "ItemTotalPrice") decimal(2) totalPrice;`).
 *
 * Deliberately ABSENT, so they resolve to nothing and the rule is withheld.
 * `datetime`: CML has no datetime primitive. Declaring it `date` would bind a value carrying a time
 * into a slot that cannot hold one, which is a silent mis-binding rather than a loud failure — the
 * generator's own datetime-literal guard refuses the value side for the same reason.
 * `picklist`: carries no comparable type of its own, exactly as `fetchAttributeDataTypes` treats an
 * unresolvable AttributeDefinition picklist.
 * `reference`: an id-shaped value whose comparable form is unproven here.
 */
const CONTEXT_DATA_TYPE_TO_CML_DECLARATION: Record<string, string> = {
  STRING: 'string',
  TEXT: 'string',
  NUMBER: 'decimal',
  DECIMAL: 'decimal',
  PERCENT: 'decimal',
  CURRENCY: 'decimal(2)',
  BOOLEAN: 'boolean',
  DATE: 'date',
};

/**
 * The CML declaration type for a ContextAttribute.DataType, or undefined when CML has no faithful
 * representation for it (see the omissions documented on the map above). Undefined means "withhold".
 */
export function contextDataTypeToCmlDeclaration(dataType?: string | null): string | undefined {
  if (!dataType) return undefined;
  return CONTEXT_DATA_TYPE_TO_CML_DECLARATION[dataType.trim().toUpperCase()];
}

/** The root node every supported context path starts from. */
const ROOT_NODE = 'SalesTransaction';
/** The node whose subtree binds per line item rather than per transaction. */
const ITEM_NODE = 'SalesTransactionItem';

/**
 * Splits a ContextNode.InheritedFrom path into its node segments.
 *
 * The stored form is `<SourceDefinition>/version/<Node>[/<Node>...]` (e.g.
 * `InsuranceContext__stdctx/version/SalesTransaction/SalesTransactionItem`), so everything up to and
 * including the `version` marker is prefix, not hierarchy. A node that was authored rather than
 * inherited carries a BLANK InheritedFrom — there is no parent pointer on ContextNode to fall back
 * on — so the caller passes the node's own Title and we treat it as a single-segment path.
 */
export function parseContextNodePath(inheritedFrom: string | null | undefined, nodeTitle: string): string[] {
  const segments = (inheritedFrom ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const versionIdx = segments.indexOf('version');
  const nodes = versionIdx >= 0 ? segments.slice(versionIdx + 1) : [];
  if (nodes.length > 0) return nodes;
  const title = nodeTitle.trim();
  return title.length > 0 ? [title] : [];
}

/**
 * Classifies a node path into the binding mechanism CML requires, or undefined when the path is
 * neither of the two shapes the converter knows how to bind.
 *
 * Both shapes are taken from declarations a human already hand-wrote into the curated Auto_Silver
 * model — `extern string UserProfile` for the transaction-level `SalesTransaction/UserProfile`, and
 * `@(tagName = "ItemTotalPrice") decimal(2) totalPrice` for the item-level
 * `SalesTransaction/SalesTransactionItem/TotalPrice`.
 *
 * Anything else (a sibling subtree such as `SalesTransaction/AppUsageAssignment`, or a path whose
 * root is not SalesTransaction at all) returns undefined and is withheld, because the correct
 * binding for it has not been established and nothing at deploy would catch a wrong guess.
 */
export function classifyContextTagScope(nodePath: readonly string[]): ContextTagScope | undefined {
  if (nodePath.length === 0 || nodePath[0] !== ROOT_NODE) return undefined;
  if (nodePath.length === 1) return 'transaction';
  return nodePath.includes(ITEM_NODE) ? 'item' : undefined;
}

/**
 * Salesforce DeveloperName / API name shape. Used to keep an interpolated SOQL literal safe; a name
 * failing it resolves nothing (fail closed) rather than being escaped into the query.
 */
const DEVELOPER_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
/** 15/18-char record id, mirroring the shared guard in insurance-org.ts. */
const SALESFORCE_ID_PATTERN = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/**
 * A ContextTag.Title safe to place in a SOQL string literal. Titles legitimately contain spaces
 * ("Cause Of Loss"), so spaces are allowed, but a quote, backslash or newline is refused outright
 * rather than escaped — the same reject-don't-escape stance the generator takes for condition
 * values. A refused title simply never resolves, so its rule is withheld.
 */
function isSafeSoqlTitle(title: string): boolean {
  return title.trim().length > 0 && !/['"\\\r\n]/.test(title);
}

function quoteSoqlStringList(values: Iterable<string>): string {
  return Array.from(values)
    .filter(isSafeSoqlTitle)
    .map((v) => `'${v}'`)
    .join(',');
}

function quoteSoqlIdList(ids: Iterable<string>): string {
  return Array.from(ids)
    .filter((id) => SALESFORCE_ID_PATTERN.test(id))
    .map((id) => `'${id}'`)
    .join(',');
}

/**
 * The ContextDefinition ids bound to a CML model, via the junction row
 * `cml import as-expression-set` writes. Distinct ids only: the import creates a NEW junction row on
 * every activation without de-duplicating, so a long-lived model accumulates many identical rows.
 *
 * A definition-less model (the junction's ContextDefinitionId is nullable, and
 * `Salesforce_Default_Pricing_Discovery_Procedure` really does carry a null one) yields an empty
 * set, which resolves no tags at all.
 */
export async function fetchContextDefinitionIds(conn: Connection, cmlApiName: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!DEVELOPER_NAME_PATTERN.test(cmlApiName)) return ids;

  const result = await conn.query<{ ContextDefinitionId: string | null }>(
    'SELECT ContextDefinitionId FROM ExpressionSetDefinitionContextDefinition ' +
      `WHERE ExpressionSetDefinition.DeveloperName = '${cmlApiName}'`
  );
  for (const row of result.records) {
    if (row.ContextDefinitionId) ids.add(row.ContextDefinitionId);
  }
  return ids;
}

/**
 * The ContextDefinitionVersion to resolve tags against, one per definition.
 *
 * An active version wins (that is the one the runtime hydrates from); among several active ones, or
 * when none is active, the highest VersionNumber wins. This only picks WITHIN a definition — it
 * never merges two definitions, because disagreement between definitions is resolved by the caller
 * refusing the tag rather than by preferring one.
 */
async function fetchActiveContextVersionIds(conn: Connection, definitionIds: Set<string>): Promise<Set<string>> {
  const chosen = new Map<string, { id: string; isActive: boolean; versionNumber: number }>();
  const idList = quoteSoqlIdList(definitionIds);
  if (!idList) return new Set();

  const result = await conn.query<{
    Id: string;
    ContextDefinitionId: string;
    VersionNumber: number | null;
    IsActive: boolean | null;
  }>(
    'SELECT Id, ContextDefinitionId, VersionNumber, IsActive FROM ContextDefinitionVersion ' +
      `WHERE ContextDefinitionId IN (${idList})`
  );

  for (const row of result.records) {
    const candidate = { id: row.Id, isActive: row.IsActive === true, versionNumber: row.VersionNumber ?? 0 };
    const current = chosen.get(row.ContextDefinitionId);
    if (
      !current ||
      (candidate.isActive && !current.isActive) ||
      (candidate.isActive === current.isActive && candidate.versionNumber > current.versionNumber)
    ) {
      chosen.set(row.ContextDefinitionId, candidate);
    }
  }
  return new Set(Array.from(chosen.values()).map((v) => v.id));
}

type ContextTagRow = {
  Title: string | null;
  ContextAttribute: {
    DataType: string | null;
    ContextNode: { Title: string | null; InheritedFrom: string | null } | null;
  } | null;
};

/**
 * Resolves each requested context tag against the ContextDefinition(s) bound to `cmlApiName`.
 *
 * A tag is returned ONLY when every row that carries its title agrees on both the CML type and the
 * binding scope. Two rows disagreeing (the same title in two bound definitions, or twice within one
 * definition on nodes of different depth) drop the tag entirely rather than picking a winner: the
 * whole point of resolving is that nothing downstream would catch the wrong choice.
 *
 * Never throws for an unresolvable tag — an empty result is the withhold signal the caller already
 * handles. Genuine connection failures still propagate to the command layer, which warns and
 * continues with no bindings (again: withhold, never guess).
 */
export async function fetchContextTagBindings(
  conn: Connection,
  cmlApiName: string,
  tagNames: Iterable<string>
): Promise<ContextTagBindings> {
  const bindings = new Map<string, ContextTagBinding>();
  const titleList = quoteSoqlStringList(new Set(tagNames));
  if (!titleList) return bindings;

  const definitionIds = await fetchContextDefinitionIds(conn, cmlApiName);
  if (definitionIds.size === 0) return bindings;

  const versionIds = await fetchActiveContextVersionIds(conn, definitionIds);
  const versionList = quoteSoqlIdList(versionIds);
  if (!versionList) return bindings;

  const result = await conn.query<ContextTagRow>(
    'SELECT Title, ContextAttribute.DataType, ContextAttribute.ContextNode.Title, ' +
      'ContextAttribute.ContextNode.InheritedFrom FROM ContextTag ' +
      `WHERE ContextAttribute.ContextNode.ContextDefinitionVersionId IN (${versionList}) ` +
      `AND Title IN (${titleList})`
  );

  const conflicting = new Set<string>();
  for (const row of result.records) {
    const title = row.Title;
    const node = row.ContextAttribute?.ContextNode;
    if (!title || !node) continue;

    const cmlType = contextDataTypeToCmlDeclaration(row.ContextAttribute?.DataType);
    const scope = classifyContextTagScope(parseContextNodePath(node.InheritedFrom, node.Title ?? ''));
    if (!cmlType || !scope) {
      // Unrepresentable type or unrecognized path: the tag must not resolve at all, and must not be
      // resolvable via some OTHER row either — a title that is `date` in one place and `datetime` in
      // another is exactly the ambiguity this gate exists to refuse.
      conflicting.add(title);
      continue;
    }

    const existing = bindings.get(title);
    if (!existing) {
      bindings.set(title, { tag: title, cmlType, sourceDataType: row.ContextAttribute?.DataType ?? '', scope });
    } else if (existing.cmlType !== cmlType || existing.scope !== scope) {
      conflicting.add(title);
    }
  }

  for (const title of conflicting) bindings.delete(title);
  return bindings;
}
