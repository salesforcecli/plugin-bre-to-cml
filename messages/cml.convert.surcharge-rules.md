# summary

Converts BRE-based Product Surcharge dynamic rules to CML eligibility constraints.

# description

Reads ProductSurcharge records from the org (or a JSON file), parses their RuleDefinition, and generates CML constraints that evaluate surcharge eligibility. Each surcharge rule becomes a named constraint that returns true/false. The command outputs a .cml file with the constraint model, an \_Associations.csv file for ExpressionSetConstraintObj records, and a \_RuleKeyMapping.json with the ProductSurcharge ID to RuleKey mapping for updating records.

# examples

- <%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --target-org myOrg

- <%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --surcharge-file path/to/surcharges.json --workspace-dir data --target-org myOrg

# flags.surcharge-file.summary

Optional JSON file with pre-exported ProductSurcharge records. If omitted, records are queried from the org.
