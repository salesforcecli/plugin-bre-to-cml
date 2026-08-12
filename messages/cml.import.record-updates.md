# summary

Applies a record-update file emitted by a cml convert command to the target org.

# description

Reads a `<cmlApi>_SurchargeUpdate.json` or `<cmlApi>_UnderwritingUpdate.json` file — the reviewable record-update plan emitted by `sf cml convert surcharge-rules` / `sf cml convert underwriting-rules` — and applies its changes to the org. Convert is file-only and never writes to the org; this command is the apply step.

The file is treated as untrusted input: it is structurally validated, every record is re-read from the org before anything is written, and each record's Name (plus the rule apiName for underwriting rule updates) is cross-checked against the file so an edited id cannot retarget a different record. Records whose org values already match are skipped, which makes re-running the command safe and idempotent.

Before applying, the command prints every planned field-level change and asks for confirmation. Use --dry-run to review the plan without writing, and --no-prompt to apply without confirmation in automation. Changes are applied in order and are not rolled back, so a mid-apply failure can leave the org partially migrated; re-running is safe because already-applied records are skipped.

Import the merged CML with `sf cml import as-expression-set` BEFORE applying a surcharge record-update file. The platform regenerates ProductSurcharge.RuleKey when RuleEngineType flips, and this command verifies that regenerated key against the key the CML rule was emitted under. That regeneration also requires the parent Surcharge.Code to be non-null — a surcharge whose parent Surcharge has a null Code cannot be flipped to ConstraintEngine and the org raises a save-hook error.

# examples

- Review the planned changes without writing anything:

  <%= config.bin %> <%= command.id %> --file data/SURCHARGE_CML_SurchargeUpdate.json --target-org myOrg --dry-run

- Apply the changes, confirming the preview interactively:

  <%= config.bin %> <%= command.id %> --file data/SURCHARGE_CML_SurchargeUpdate.json --target-org myOrg

- Apply the changes without a confirmation prompt, for automation:

  <%= config.bin %> <%= command.id %> --file data/UW_CML_UnderwritingUpdate.json --target-org myOrg --no-prompt

# flags.file.summary

Path to the record-update JSON file emitted by a cml convert command.

# flags.no-prompt.summary

Don't prompt for confirmation before applying the changes.

# flags.dry-run.summary

Show the planned changes and exit without writing anything to the org.

# info.nothingToApply

The file contains no updates. Nothing to apply.

# info.dryRun

Dry run only — no changes were applied.

# info.applySummary

Records: %s updated, %s skipped (already current), %s failed.

# warn.header

These changes will be applied to %s

# warn.summary

%s to create, %s to update, %s already current (reused), %s to skip in org %s.

# warn.notTransactional

Changes are applied in order and are NOT rolled back; a mid-apply failure can leave the org partially migrated.

# warn.outcomeUnknown

OUTCOME UNKNOWN %s (%s): %s. The request failed after it was sent, so the org may or may not hold this change; re-read the record before re-running.

# warn.skippingPrompt

Proceeding without confirmation because --no-prompt was passed.

# confirm.apply

Apply these changes to the org

# error.invalidFile

Invalid record-update file. %s

# error.invalidFile.actions

- Regenerate the file with the matching `sf cml convert` command, or correct the reported problem by hand.

# error.recordIdentityMismatch

Refusing to apply: the org state doesn't match the record-update file.

%s

# error.recordIdentityMismatch.actions

- Regenerate the record-update file against this org, or correct the mismatched record ids by hand.

# error.confirmationRequired

Confirmation is required to apply changes to the org, but the terminal isn't interactive.

# error.confirmationRequired.actions

- Run again with --no-prompt to apply without confirmation (consider --dry-run first), or run interactively.

# error.aborted

Aborted. No changes were applied to the org.

# error.applyFailures

%s of the record updates failed. The org is partially migrated: earlier updates were applied and are not rolled back.

# error.applyFailures.actions

- Fix the reported errors, then re-run (already-applied records are skipped): %s
