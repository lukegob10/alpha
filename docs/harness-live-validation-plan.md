# Proposed bounded live validation

Status: planned only, 2026-09-18. No provider calls or spending authorized by this plan. The existing CLI accepted both
dry-run plans in `artifacts/harness/live-control-plan.json` and `live-candidate-plan.json` without launching a host.

## First paired readiness experiment

Question: can the baseline and candidate execute the same core task set and produce admissible, build-attested evidence?
This is a pipeline/readiness experiment, not enough repetitions to establish a quality or speed improvement.

- Baseline: clean build of `f85371b02c7fbe2fd07c19e7d411aebe8f2a8dce`; candidate: the reviewed change set, frozen before
  either run. The baseline needs the same compatible measurement harness; do not compare mismatched grader/runner
  identities or retrofit missing historical identities. Prepare and verify isolated checkouts before execution.
- Proposed provider: native VS Code Copilot, exact model `gpt-5.6-luna`, effort `high`, exact VS Code `1.122.1`.
  This proposal does not establish account access or model availability. Confirm both in the owned profile first.
- Tasks: `dev-git-inspect`, `dev-refactor`, `dev-search-recovery`, `completion-idle`, `provider-empty-recovery`,
  `provider-error-recovery`, `stream-cancel-recovery`, `reload-continuation`, `background-isolation`.
- One sample per task per variant: 18 planned task observations. Each campaign permits at most 100 requests and two
  hours, with a ten-minute attempt timeout. Total authorized exposure would be at most **200 requests and four hours**.
  Hitting a limit yields incomplete/budget evidence; it does not authorize more calls. Gate mode disables failure
  reproduction; the configuration's reproduction allowance is not permission to retry.
- No monetary estimate or hard dollar ceiling is available from the native provider's request cap. Missing cost stays
  missing. Confirm the account's charging policy and an acceptable spend/usage ceiling before authorizing this plan;
  use an approved account-level limit if a dollar ceiling is required. Do not represent 200 requests as a dollar cap.
- Requires an authenticated, isolated Copilot test profile with the selected model and an explicit request/spending
  decision. No credentials should be copied into task text, manifests or Git. Corporate network policy must allow
  the selected provider. Neither Docker nor PostgreSQL/Redis is required.

The validated command shape is:

```sh
pnpm test:live:core --model-id gpt-5.6-luna --effort high --vscode-version 1.122.1 --max-requests 100 --samples 1 --root <new-absolute-campaign-root> --profile-dir <owned-profile> --id <variant-id> --dry-run
```

Before spending, declare allowed variant differences and the pairing window in the existing experiment manifest.
Require stable build/source digests, identical task/host/model/grader identities and complete retained evidence. Export
both final reports and run the existing paired reporter. Keep infrastructure, cancellations, missing usage and failed
attempts visible. Decision: fix a demonstrated harness defect; keep only a complete compatible comparison; otherwise
record inconclusive. Do not interpret one observation per task as broad capability evidence.

## Integration rows are a separate decision

This core suite does not replace managed-agent playbook Runs A–F. In particular, billing-limit acceptance needs a
provider reporting real nonzero cost; UI acceptance needs factual rendered-webview actions; shared-storage and reload
rows need their exact mailbox/identity receipts. See the [acceptance ledger](harness-acceptance-status.md).
Choose the provider/profile and budget for those experiments independently; this 200-request proposal does not
authorize their additional usage.
