# summary

Converts BRE-based Product Surcharge dynamic rules to CML eligibility constraints.

# description

Reads ProductSurcharge records from the org (or a JSON file), parses their RuleDefinition, and merges the generated surcharge rules into the org's existing curated ConstraintModel for the resolved CML API. Each surcharge rule is nested into its leaf product type with a platform-compatible pathed rule key (matching the RuleKey the platform auto-generates), so the rule actually fires for nested products instead of being silently dropped. The command is file-only and never writes to the org. It requires an existing CML model to merge into and outputs a .cml file with the full merged model, a header-only \_Associations.csv file, a \_RuleKeyMapping.json with the ProductSurcharge ID to RuleKey mapping, and a \_SurchargeUpdate.json file enumerating the org-record changes. Review the files, then apply the CML with `sf cml import as-expression-set` and apply the org-record changes enumerated in the \_SurchargeUpdate.json file to the org separately (in that order).

The parent Surcharge's Code field must be set (non-null): the platform derives the leaf segment of the auto-generated ProductSurcharge.RuleKey from Surcharge.Code, so the converter uses it to build a matching rule key. A surcharge whose parent Surcharge has a null Code cannot be flipped to ConstraintEngine (the org raises a save-hook error) and will not convert correctly — populate Surcharge.Code before converting.

# examples

- <%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --target-org myOrg

- <%= config.bin %> <%= command.id %> --cml-api SURCHARGE_CML --surcharge-file path/to/surcharges.json --workspace-dir data --target-org myOrg

# flags.surcharge-file.summary

Optional JSON file with pre-exported ProductSurcharge records. If omitted, records are queried from the org.
