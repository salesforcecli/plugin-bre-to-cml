# flags.cml-api.summary

CML API Name. If omitted, auto-discovers an existing CML associated with the same root products.

# flags.workspace-dir.summary

Directory where output files will be written.

# flags.update-records.summary

REMOVED. Convert no longer writes to the org; passing this flag now errors. Convert instead emits a reviewable record-update file enumerating the org-record changes, which you apply to the org separately.

# error.updateRecordsRemoved

convert no longer writes to the org. It now always emits a `<cmlApi>_{Underwriting,Surcharge}Update.json` file for review.

# error.updateRecordsRemoved.actions

- Review the emitted `<cmlApi>_{Underwriting,Surcharge}Update.json` file and apply its org-record changes to the target org separately.
