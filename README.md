# BRE to CML Spike

Export SC rules via `sf data export bulk`, edit the file if desired to remove unwanted rules.  
Run the two-part migration process:

1. `sf cml convert prod-cfg-rules`
2. `sf cml import as-expression-set`

Review the output and CML blobs created by conversion before import.  
Review the output of the import.

Add debug logging to both conversion and import.

When creating CMLs for bundles, use the `--full-bundles` flag (default: true) during conversion to indicate whether to include all bundles or just the subset referenced in the rules.

## Conversion Flow

- Read SC Rules from the file and build a list of `ConfiguratorRuleInput` to mimic the JSON structure of `ConfigurationRuleDefinition`
- Group rules by non-intersecting `Product2` IDs (CMLs can’t share products)
- For each group:
  - Query PCM for related products (for bundle rules) or root definitions (others)
  - Build an in-memory representation of the CML
  - Apply logic to build constraints

Serialize the in-memory CML to a blob for import as an Expression Set.  
Create `ExpressionSetConstraintObj` association records pointing to the `cml-api` name and write them to `cml-api_associations.csv`.

## Import Flow

- Import one CML at a time
- Upsert the Expression Set using the `cml-api` name
- Read and upsert `ExpressionSetConstraintObj` rows from the CSV (resolving FKs)
- Upload the CML blob

## Open Questions

- Is there a GitHub repo we should be using for this dev?
- Where can we learn more about Functions and calling CML logic from Admin UI?
- SF or SFDX preferred?
- Any CPU, RAM, or other limits to know?
- Is debug flag supported by default?
- Can we call the Product Discovery API from an SF Plugin?

## Setup Steps

1. **Convert:**

   ```bash
   sf dev generate command --name cml:convert:prod-cfg-rules
   sf dev generate flag (target-org, pcr-file, cml-api, full-bundles, workspace-dir)
   ```

2. **Import:**
   ```bash
   sf dev generate command --name cml:import:as-expression-set
   sf dev generate flag (target-org, context-definition, cml-api, workspace-dir)
   ```

## Execution Steps

1. **Authenticate to target org**

   ```bash
   sf auth:web:login --instance-url https://sdb3.test1.pc-rnd.pc-aws.salesforce.com -a breMigOrg
   sf org list
   ```

2. **Export SC Rules**

   ```bash
   sf data export bulk -o breMigOrg --query "SELECT ApiName, ConfigurationRuleDefinition, Description, EffectiveFromDate, EffectiveToDate, Id, IsDeleted, Name, ProcessScope, RuleSubType, RuleType, Sequence, Status FROM ProductConfigurationRule WHERE RuleType = 'Configurator'" --output-file data/ProductConfigurationRules.json --result-format json --wait 10 --all-rows
   ```

3. **Convert to CML**

   ```bash
   sf cml convert prod-cfg-rules --pcr-file export-ProductConfigurationRules.json --cml-api MIG_CML --workspace-dir data --target-org breMigOrg
   ```

4. **Import Expression Set**
   ```bash
   sf cml import as-expression-set --cml-api MIG_CML --context-definition PricingTransactionCD2 --workspace-dir data --target-org breMigOrg
   ```

## Debug

```bash
export NODE_OPTIONS='--inspect-brk'
unset NODE_OPTIONS
```

# my-first-plugin

[![NPM](https://img.shields.io/npm/v/my-first-plugin.svg?label=my-first-plugin)](https://www.npmjs.com/package/my-first-plugin) [![Downloads/week](https://img.shields.io/npm/dw/my-first-plugin.svg)](https://npmjs.org/package/my-first-plugin) [![License](https://img.shields.io/badge/License-BSD%203--Clause-brightgreen.svg)](https://raw.githubusercontent.com/salesforcecli/my-first-plugin/main/LICENSE.txt)

## Using the template

This repository provides a template for creating a plugin for the Salesforce CLI. To convert this template to a working plugin:

1. Please get in touch with the Platform CLI team. We want to help you develop your plugin.
2. Generate your plugin:

   ```
   sf plugins install dev
   sf dev generate plugin

   git init -b main
   git add . && git commit -m "chore: initial commit"
   ```

3. Create your plugin's repo in the salesforcecli github org
4. When you're ready, replace the contents of this README with the information you want.

## Learn about `sf` plugins

Salesforce CLI plugins are based on the [oclif plugin framework](<(https://oclif.io/docs/introduction.html)>). Read the [plugin developer guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_plugins.meta/sfdx_cli_plugins/cli_plugins_architecture_sf_cli.htm) to learn about Salesforce CLI plugin development.

This repository contains a lot of additional scripts and tools to help with general Salesforce node development and enforce coding standards. You should familiarize yourself with some of the [node developer packages](#tooling) used by Salesforce.

Additionally, there are some additional tests that the Salesforce CLI will enforce if this plugin is ever bundled with the CLI. These test are included by default under the `posttest` script and it is required to keep these tests active in your plugin if you plan to have it bundled.

### Tooling

- [@salesforce/core](https://github.com/forcedotcom/sfdx-core)
- [@salesforce/kit](https://github.com/forcedotcom/kit)
- [@salesforce/sf-plugins-core](https://github.com/salesforcecli/sf-plugins-core)
- [@salesforce/ts-types](https://github.com/forcedotcom/ts-types)
- [@salesforce/ts-sinon](https://github.com/forcedotcom/ts-sinon)
- [@salesforce/dev-config](https://github.com/forcedotcom/dev-config)
- [@salesforce/dev-scripts](https://github.com/forcedotcom/dev-scripts)

### Hooks

For cross clouds commands, e.g. `sf env list`, we utilize [oclif hooks](https://oclif.io/docs/hooks) to get the relevant information from installed plugins.

This plugin includes sample hooks in the [src/hooks directory](src/hooks). You'll just need to add the appropriate logic. You can also delete any of the hooks if they aren't required for your plugin.

# Everything past here is only a suggestion as to what should be in your specific plugin's description

This plugin is bundled with the [Salesforce CLI](https://developer.salesforce.com/tools/sfdxcli). For more information on the CLI, read the [getting started guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_intro.htm).

We always recommend using the latest version of these commands bundled with the CLI, however, you can install a specific version or tag if needed.

## Install

```bash
sf plugins install my-first-plugin@x.y.z
```

## Issues

Please report any issues at https://github.com/forcedotcom/cli/issues

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
git clone git@github.com:salesforcecli/my-first-plugin

# Install the dependencies and compile
yarn && yarn build
```

To use your plugin, run using the local `./bin/dev` or `./bin/dev.cmd` file.

```bash
# Run using local run file.
./bin/dev hello world
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

- [`sf hello world`](#sf-hello-world)

## `sf hello world`

Say hello either to the world or someone you know.

```
USAGE
  $ sf hello world [--json] [-n <value>]

FLAGS
  -n, --name=<value>  [default: World] The name of the person you'd like to say hello to.

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Say hello either to the world or someone you know.

  Say hello either to the world or someone you know.

EXAMPLES
  Say hello to the world:

    $ sf hello world

  Say hello to someone you know:

    $ sf hello world --name Astro
```

<!-- commandsstop -->
