# summary

Converts BRE-based Insurance Underwriting dynamic rules to CML eligibility constraints.

# description

Reads UnderwritingRule records from the org (or a JSON file), parses their DynamicRuleDefinition, and generates CML constraints that evaluate underwriting eligibility. Each rule becomes a named constraint that returns true/false. The command is file-only and never writes to the org: it outputs a .cml file with the constraint model, an \_Associations.csv file for ExpressionSetConstraintObj records, a \_RuleKeyMapping.json with the UnderwritingRule ID to RuleKey mapping, and a \_UnderwritingUpdate.json file enumerating the org-record changes. Review the files, then apply the CML with `sf cml import as-expression-set` and apply the org-record changes enumerated in the \_UnderwritingUpdate.json file to the org separately.

# examples

- <%= config.bin %> <%= command.id %> --cml-api UW_CML --target-org myOrg

- <%= config.bin %> <%= command.id %> --cml-api UW_CML --uw-file data/underwriting.json --workspace-dir data --target-org myOrg

# flags.uw-file.summary

Optional JSON file with pre-exported UnderwritingRule records. If omitted, records are queried from the org.
