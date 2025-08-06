# plugin-bre-to-cml

[![NPM](https://img.shields.io/npm/v/@salesforce/plugin-agent.svg?label=@salesforce/plugin-agent)](https://www.npmjs.com/package/@salesforce/plugin-bre-to-cml) [![Downloads/week](https://img.shields.io/npm/dw/@salesforce/plugin-bre-to-cml.svg)](https://npmjs.org/package/@salesforce/plugin-bre-to-cml) [![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/license/apache-2-0)

## Install

```bash
sf plugins install @salesforce/plugin-bre-to-cml@x.y.z
```

## Contributing

1. Please read our [Code of Conduct](CODE_OF_CONDUCT.md)
2. Create a new issue before starting your project so that we can keep track of
   what you are trying to add/fix. That way, we can also offer suggestions or
   let you know if there is already an effort in progress.
3. Fork this repository.
4. [Build the plugin locally](#build)
5. Create a _topic_ branch in your fork. Note, this step is recommended but technically not required if contributing using a fork.
6. Edit the code in your fork.
7. Write appropriate tests for your changes. Try to achieve at least 95% code coverage on any new code. No pull request will be accepted without unit tests.
8. Sign CLA (see [CLA](#cla) below).
9. Send us a pull request when you are done. We'll review your code, suggest any needed changes, and merge it in.

### CLA

External contributors will be required to sign a Contributor's License
Agreement. You can do so by going to https://cla.salesforce.com/sign-cla.

### Build

To build the plugin locally, make sure to have yarn installed and run the following commands:

```bash
# Clone the repository
git clone git@github.com:salesforcecli/plugin-bre-to-cml

# Install the dependencies and compile
yarn install
yarn build
```

To use your plugin, run using the local `./bin/dev.js` or `./bin/dev.cmd` file.

```bash
# Run using local run file.
./bin/dev cml
```

There should be no differences when running via the Salesforce CLI or using the local run file. However, it can be useful to link the plugin to do some additional testing or run your commands from anywhere on your machine.

```bash
# Link your plugin to the sf cli
sf plugins link .
# To verify
sf plugins
```

## Commands

<!-- commands -->

- [`sf cml convert prod-cfg-rules`](#sf-cml-convert-prod-cfg-rules)
- [`sf cml import as-expression-set`](#sf-cml-import-as-expression-set)

## `sf cml convert prod-cfg-rules`

Converts BRE based Standard Configurator rules represented as JSON to CML and saves it as a pair of CML and association files.

```
USAGE
  $ sf cml convert prod-cfg-rules -o <value> -r <value> -c <value> [--json] [--flags-dir <value>] [--api-version <value>] [-d <value>] [-x <value>] [-v <value>]

FLAGS
  -c, --cml-api=<value>              (required) Unique CML API Name to be created.
  -d, --workspace-dir=<value>        Directory where working files are located, exported rules JSON and where CMLs will be created.
  -o, --target-org=<value>           (required) Username or alias of the target org. Not required if the `target-org` configuration variable is already set.
  -r, --pcr-file=<value>             (required) Name of the JSON file that contain exported standard Product Configuration Rules.
  -v, --products-file=<value>        Name of the JSON file that contain exported Products from PCM (if not present products will be fetched automatically).
  -x, --additional-products=<value>  Comma-separated list of additional product IDs for which CML types should be generated.
      --api-version=<value>          Override the api version used for api requests made by this command

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Converts BRE based Standard Configurator rules represented as JSON to CML and saves it as a pair of CML and association files.

  Before you execute this command make sure to migrate you PCM or that you are performing migration of rules within the same org.

  Authenticate to the orgs and export BRE based Standard Configurator rules using sf data export bulk plugin and save results in a JSON file, see examples.

  This command executes following logic:

  - Read SC Rules from the json file and build a list of `ConfiguratorRuleInput` to mimic the JSON structure of `ConfigurationRuleDefinition`
  - Group rules by non-intersecting `Product2` IDs (CMLs can’t share products)
  - For each group:
  - Query PCM for related products (for bundle rules) or root definitions (for others)
  - Build an in-memory representation of the CML
  - Apply logic to build constraints
  - Serialize the in-memory CML to a blob for import as an Expression Set, save it in a cml-api.cml file.
  - Create `ExpressionSetConstraintObj` association records pointing to the `cml-api` name and write them to `cml-api_associations.csv` file.
  - If multiple CML and association files are produced 1-N number will be appended to the names of files.

EXAMPLES
   Authenticate to target orgs:

   $ sf auth:web:login --instance-url https://sdb3.test1.pc-rnd.pc-aws.salesforce.com -a breSourceOrg
   $ sf auth:web:login --instance-url https://sdb3.test2.pc-rnd.pc-aws.salesforce.com -a cmlTargetOrg
   $ sf org list

   Export Standard Configurator rules:

   $ sf data export bulk -o breSourceOrg --query "SELECT ApiName, ConfigurationRuleDefinition, Description, EffectiveFromDate, EffectiveToDate, Id, IsDeleted, Name, ProcessScope, RuleSubType, RuleType, Sequence, Status FROM ProductConfigurationRule WHERE RuleType = 'Configurator'" --output-file data/ProductConfigurationRules.json --result-format json --wait 10 --all-rows

   Convert to CML:

   $ sf cml convert prod-cfg-rules --pcr-file data/ProductConfigurationRules.json --cml-api MY_TEST --workspace-dir data --target-org breSourceOrg
```

_See code: [src/commands/cml/convert/prod-cfg-rules.ts](https://github.com/salesforcecli/plugin-bre-to-cml/blob/main/src/commands/cml/convert/prod-cfg-rules.ts)_

## `sf cml import as-expression-set`

Imports CML and associations to the target org

```
USAGE
  $ sf cml import as-expression-set -o <value> -x <value> -c <value> [--json] [--flags-dir <value>] [--api-version <value>] [-d <value>]

FLAGS
  -c, --cml-api=<value>             (required) Unique CML API Name to be created.
  -d, --workspace-dir=<value>       Directory where converted CML and assocciations csv files are located.
  -o, --target-org=<value>          (required) Username or alias of the target org. Not required if the `target-org` configuration variable is already set.
  -x, --context-definition=<value>  (required) Context Definition name to be assocciated with the CML.
      --api-version=<value>         Override the api version used for api requests made by this command

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Imports CML and associations to the target org

  Review CM created by conversion command before doing import.
  This command executes following logic:
  - Import one CML at a time
  - Upsert the Expression Set using the `cml-api` name
  - Read and upsert `ExpressionSetConstraintObj` rows from the `cml-api_associations.csv` file (resolving FKs)
  - Upload the CML blob

EXAMPLES
  $ sf cml import as-expression-set --cml-api MY_TEST --context-definition PricingTransactionCD2 --workspace-dir data --target-org cmlTargetOrg
```

_See code: [src/commands/cml/import/as-expression-set.ts](https://github.com/salesforcecli/plugin-bre-to-cml/blob/main/src/commands/cml/import/as-expression-set.ts)_

<!-- commandsstop -->
