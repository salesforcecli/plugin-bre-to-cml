#!/usr/bin/env bash
# apply-surcharge-update.sh — flip ProductSurcharge.RuleEngineType from *_SurchargeUpdate.json
#
# Convert (`sf cml convert surcharge-rules`) is file-only and emits
# `<cmlApi>_SurchargeUpdate.json`. This script applies those updates to the org.
# Import the merged CML first (`sf cml import as-expression-set`), then run this.
#
# Usage:
#   ./scripts/apply-surcharge-update.sh SURCHARGE_CML_SurchargeUpdate.json myOrg
#   DRY_RUN=1 ./scripts/apply-surcharge-update.sh SURCHARGE_CML_SurchargeUpdate.json myOrg
#
# Requires: jq, sf (Salesforce CLI)

set -euo pipefail

FILE="${1:?Usage: $0 <SurchargeUpdate.json> <target-org>}"
ORG="${2:?Usage: $0 <SurchargeUpdate.json> <target-org>}"
DRY_RUN="${DRY_RUN:-0}"

if ! command -v jq >/dev/null; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v sf >/dev/null; then
  echo "sf (Salesforce CLI) is required" >&2
  exit 1
fi

if [[ ! -f "$FILE" ]]; then
  echo "File not found: $FILE" >&2
  exit 1
fi

kind=$(jq -r '.kind // empty' "$FILE")
if [[ "$kind" != "surcharge-update" ]]; then
  echo "Expected kind=surcharge-update, got: ${kind:-<missing>}" >&2
  exit 1
fi

count=$(jq '.updates | length' "$FILE")
echo "Org: $ORG"
echo "File: $FILE"
echo "Updates: $count"
if [[ "$count" -eq 0 ]]; then
  echo "Nothing to apply."
  exit 0
fi

ok=0
fail=0
skip=0

while read -r row; do
  id=$(jq -r '.id' <<<"$row")
  name=$(jq -r '.name // ""' <<<"$row")
  expected=$(jq -r '.expectedRuleKey // empty' <<<"$row")
  field=$(jq -r '.fields[0].field // empty' <<<"$row")
  value=$(jq -r '.fields[0].value // empty' <<<"$row")

  if [[ "$field" != "RuleEngineType" || "$value" != "ConstraintEngine" ]]; then
    echo "SKIP unexpected field update on $id ($name): $field=$value" >&2
    skip=$((skip + 1))
    continue
  fi

  echo "→ $id ($name) RuleEngineType=ConstraintEngine${expected:+  [expectedRuleKey=$expected]}"

  if [[ "$DRY_RUN" == "1" ]]; then
    ok=$((ok + 1))
    continue
  fi

  if sf data update record \
    --sobject ProductSurcharge \
    --record-id "$id" \
    --values "RuleEngineType=ConstraintEngine" \
    --target-org "$ORG"; then
    ok=$((ok + 1))
  else
    echo "FAIL updating $id ($name)" >&2
    fail=$((fail + 1))
  fi
done < <(jq -c '.updates[]' "$FILE")

echo "Summary: ok=$ok skip=$skip fail=$fail dry_run=$DRY_RUN"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run only — no org writes."
  exit 0
fi

if [[ "$fail" -gt 0 ]]; then
  exit 1
fi

echo "Verify RuleKey was generated:"
ids=$(jq -r '[.updates[].id] | map("'\''" + . + "'\''") | join(",")' "$FILE")
sf data query --target-org "$ORG" --query \
  "SELECT Id, Name, RuleEngineType, RuleKey, RuleApiName FROM ProductSurcharge WHERE Id IN ($ids)"
