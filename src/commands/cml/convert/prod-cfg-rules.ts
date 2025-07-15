import * as fs from 'node:fs/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { ConfiguratorRuleInput } from '../../../shared/models.js';
import { extractProductIds, groupByNonIntersectingProduct2 } from '../../../shared/grouping.js';
import { fetchProductsFromPcm } from '../../../shared/pcm-products.js';
import { BreRulesGenerator } from '../../../shared/bre-rules-generator.js';
import { PcmGenerator } from '../../../shared/pcm-generator.js';
import { BASE_LINE_ITEM_TYPE_NAME, CmlModel, CmlType } from '../../../shared/types/types.js';
import { PCMProduct } from '../../../shared/pcm-products.types.js';
import { generateCsvForAssociations } from '../../../shared/utils/association.utils.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('plugin-bre-to-cml', 'cml.convert.prod-cfg-rules');

export type CmlConvertProdCfgRulesResult = {
  path: string;
};

function newCmlModel(): CmlModel {
  const cmlModel = new CmlModel();

  const lineItemType = new CmlType(BASE_LINE_ITEM_TYPE_NAME, undefined, undefined);
  cmlModel.addType(lineItemType);

  return cmlModel;
}

export default class CmlConvertProdCfgRules extends SfCommand<CmlConvertProdCfgRulesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
    'pcr-file': Flags.file({
      summary: messages.getMessage('flags.pcr-file.summary'),
      char: 'r',
      required: true,
      exists: true,
    }),
    'cml-api': Flags.string({
      summary: messages.getMessage('flags.cml-api.summary'),
      char: 'c',
      required: true,
    }),
    'workspace-dir': Flags.directory({
      summary: messages.getMessage('flags.workspace-dir.summary'),
      char: 'd',
      exists: true,
    }),
    'additional-products': Flags.string({
      summary: messages.getMessage('flags.additional-products.summary'),
      char: 'x',
      exists: true,
    }),
    'products-file': Flags.file({
      summary: messages.getMessage('flags.products-file.summary'),
      char: 'v',
      exists: true,
    }),
  };

  public async run(): Promise<CmlConvertProdCfgRulesResult> {
    const { flags } = await this.parse(CmlConvertProdCfgRules);

    const api = flags['cml-api'];
    const pcrFile = flags['pcr-file'];
    const workspaceDir = flags['workspace-dir'];
    const targetOrg = flags['target-org'];

    this.log(`Using CML API: ${api}`);
    this.log(`Using PCR File: ${pcrFile}`);
    this.log(`Using Workspace Directory: ${workspaceDir}`);
    this.log(`Using Target Org: ${targetOrg.getUsername()}`);

    const pcrFileContents = await fs.readFile(pcrFile, 'utf8');
    const pcrData = JSON.parse(pcrFileContents) as Array<{
      ApiName: string;
      Name: string;
      Description: string;
      Sequence: string;
      Status: string;
      EffectiveFromDate: string;
      EffectiveToDate?: string;
      ConfigurationRuleDefinition: string;
    }>;

    const rules: ConfiguratorRuleInput[] = [];

    for (const raw of pcrData) {
      try {
        const parsed = JSON.parse(raw.ConfigurationRuleDefinition) as ConfiguratorRuleInput;
        rules.push(parsed);
      } catch {
        this.warn(`❌ Failed to parse ConfigurationRuleDefinition for rule: ${raw.Name}`);
      }
    }

    this.log(`Parsed ${rules.length} valid configuration rules`);

    rules.sort((l, r) => (l.sequence ?? 0) - (r.sequence ?? 0));
    const groups = groupByNonIntersectingProduct2(rules);
    this.log(`Found ${groups.size} non-intersecting Product2 groups`);

    const safeApi = api.replace(/[^a-zA-Z0-9_-]/g, '_');

    const uniqProductIds: Set<string> = new Set();
    const additionalProductIds = flags['additional-products']?.split(',')?.map((p) => p.trim()) ?? [];
    rules
      .map(extractProductIds)
      .flatMap((set) => [...set])
      .forEach((p) => uniqProductIds.add(p));
    additionalProductIds.forEach((p) => uniqProductIds.add(p));

    let products: Map<string, PCMProduct>;
    const productsFile = flags['products-file'];
    if (productsFile) {
      const prods = JSON.parse(await fs.readFile(productsFile, 'utf8')) as { [k: string]: PCMProduct };
      products = new Map<string, PCMProduct>(Object.entries(prods));
    } else {
      const conn = targetOrg.getConnection(flags['api-version']);
      products = await fetchProductsFromPcm(conn, Array.from(uniqProductIds));
    }

    this.log('📦 Convert products and BRE rules to CML');

    const cmlModel = newCmlModel();
    const modelInfo = PcmGenerator.generateViewModels(cmlModel, Array.from(products.values()));
    for (const type of modelInfo.types) {
      modelInfo.attributes.get(type.name)?.forEach((attr) => type.addAttribute(attr));
      modelInfo.relations.get(type.name)?.forEach((rel) => type.addRelation(rel));
      cmlModel.addType(type);
    }
    for (const association of modelInfo.associations) {
      cmlModel.addAssociation(association);
    }

    BreRulesGenerator.generateConstraints(cmlModel, groups, {
      info: (msg) => this.log(msg),
      warn: (msg) => this.warn(msg),
      error: (msg) => this.error(msg),
    });

    const cmlContent = cmlModel.generateCml();
    const associationsCsvContent = generateCsvForAssociations(safeApi, cmlModel.associations);

    const cmlFileName = `${safeApi}.cml`;
    const associationsFileName = `${safeApi}_Associations.csv`;
    const fullPath = workspaceDir ? `${workspaceDir}/${cmlFileName}` : cmlFileName;
    const associationsFullPath = workspaceDir ? `${workspaceDir}/${associationsFileName}` : associationsFileName;

    this.log(`📦 Writing CML content to ${cmlFileName}`);

    await fs.writeFile(fullPath, cmlContent, 'utf8');
    await fs.writeFile(associationsFullPath, associationsCsvContent, 'utf8');

    this.log(`✅ Wrote CML to ${fullPath}`);

    this.log('✅ Done');

    return {
      path: 'src/commands/cml/convert/prod-cfg-rules.ts',
    };
  }
}
