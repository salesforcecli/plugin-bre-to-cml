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

%s to update, %s already current (will be skipped) in org %s.

# warn.notTransactional

Changes are applied in order and are NOT rolled back; a mid-apply failure can leave the org partially migrated.

# warn.outcomeUnknown

OUTCOME UNKNOWN %s (%s): %s. The request failed after it was sent, so the org may or may not hold this change; re-read the record before re-running.

# warn.skippingPrompt

Proceeding without confirmation because --no-prompt was passed.

# confirm.apply

Apply these changes to the org

# error.unreadableFile

Couldn't read the record-update file %s. %s

# error.unreadableFile.actions

- Check that the path points at a readable file (not a directory) and that you have permission to read it.

# error.invalidFile

Invalid record-update file. %s

# error.invalidFile.actions

- Regenerate the file with the matching `sf cml convert` command, or correct the reported problem by hand.

# error.duplicateRecordId

Invalid record-update file: the same record appears in it more than once. %s

# error.duplicateRecordId.actions

- Keep exactly one entry per record. If the repeated entries set different values, decide which value you intend and delete the others: a preview that shows one record twice, with two different outcomes, isn't something you can consent to.
- Regenerate the file with the matching `sf cml convert` command if you can't tell which of the entries is the correct one.

# error.recordIdentityMismatch

Refusing to apply: the org state doesn't match the record-update file.

%s

# error.recordIdentityMismatch.actions

- Regenerate the record-update file against this org, or hand-correct each reported entry so its id and name both match the record you mean to update. A record that was simply renamed in the org needs its `name` corrected, not its `id`.

# error.unreadableOrgBlob

Refusing to apply: the DynamicRuleDefinition stored in the org can't be parsed, so the identity check that keeps this write off the wrong record couldn't run.

%s

# error.unreadableOrgBlob.actions

- Read the record's DynamicRuleDefinition out of the org (`sf data query --query "SELECT Id, Name, DynamicRuleDefinition FROM UnderwritingRule WHERE Id = '<id>'" --target-org <org>`) and repair or restore it, then re-run. Regenerating the record-update file won't help: convert reads the same unparseable value.
- Drop the reported records from the file if you want to migrate the rest first; the records left in it are applied normally.

# error.identityCheckUnavailable

Refusing to apply: an identity check this command relies on couldn't run, so it can't confirm it would write to the right record. This is a defect in the plugin, not in your file.

%s

# error.identityCheckUnavailable.actions

- Report this to the plugin maintainers with the message above and the command you ran. Editing the record-update file can't affect it — the missing data is a field the plugin failed to read back from the org.
- Nothing was written: the check runs before any write, so the org is exactly as it was. Re-running, with or without --dry-run, refuses in the same place until the defect is fixed.

# error.confirmationRequired

Confirmation is required to apply changes to the org, but the terminal isn't interactive.

# error.confirmationRequired.actions

- Run again with --no-prompt to apply without confirmation (consider --dry-run first), or run interactively.

# error.confirmationRequiredJson

Confirmation is required to apply changes to the org, but the confirmation prompt is suppressed under --json because prompting would write prompt text into the JSON output stream.

# error.confirmationRequiredJson.actions

- Run again with --no-prompt to apply without confirmation, or with --dry-run to review the planned changes without writing.

# error.aborted

Aborted. No changes were applied to the org.

# error.applyFailures

%s of the record updates failed and %s succeeded. The org is partially migrated: the updates that succeeded are not rolled back.

# error.applyFailures.actions

- Fix the reported errors, then re-run (already-applied records are skipped): %s

# error.applyFailuresNoneApplied

%s of the record updates failed and none were applied, so this run left the org unchanged.

# error.applyFailuresNoneApplied.actions

- Fix the reported errors, then re-run. Nothing needs undoing first, because nothing was written: %s

# error.applyFailuresOutcomeUnknown

%s of the record updates failed and %s succeeded. %s of the failures happened after the request had been sent, so whether the org holds those changes is unknown; any update that did succeed is not rolled back.

# error.applyFailuresOutcomeUnknown.actions

- Re-read the records reported above as OUTCOME UNKNOWN to find out whether the org holds them, then fix the reported errors and re-run (already-applied records are skipped): %s
