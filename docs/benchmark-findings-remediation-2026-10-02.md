# Benchmark findings remediation — 2026-10-02

This correctness and operational hardening pass addresses the eleven findings in
`artifacts/harness/evaluation-2026-10-02-144109/findings.md`. The original results and fixtures remain baseline evidence.
Acceptance requires focused regression coverage, the affected package checks, exact VS Code 1.125.0 integration gates,
and comparable measurements for performance changes. Observed provider and shared-host symptoms require attribution;
their disappearance in one run does not prove a fix. Final execution counts, failures, gate receipts and live results are
tracked separately in `artifacts/harness/remediation-2026-10-02/findings.md` and `validation-results.json`, so recording
results does not change the source identity of a frozen sweep.

Source baseline: `6f3893db51522b704e827740be52efe5ea6771bc`, clean working tree. Codex CLI behavior reference:
`c5d242fa7907bff1b7a7e26e95febc548c0a6963`, retrieved 2026-10-02; early process completion and completed-response usage
are the relevant contracts. Alpha retains its existing execution and approval architecture.

| Finding                                                 | Severity           | Closure                                   | Owning boundary and validation                                                            |
| ------------------------------------------------------- | ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1. Command completion promise cycle                     | High, must-fix     | Implemented                               | ExecuteCommandTool; completion, cancellation and output joins; navigation host/UI gates   |
| 2. Credentials in evaluator image / missing attestation | Critical, must-fix | Credentials fixed; identity scope limited | Docker build context, runtime configuration and existing campaign evidence                |
| 3. Platform-dependent private seals                     | High, must-fix     | Migration verified                        | Shared fixture digest contract; deliberate compatibility migration; LF/CRLF/binary checks |
| 4. Fresh database initialization / configuration drift  | High, must-fix     | Fresh init verified                       | Executable script bytes, clean PostgreSQL storage, Redis and campaign aliases             |
| 5. Strict execution receipts                            | High, must-fix     | Receipts implemented                      | Existing harness receipt descriptors; strict admission, without editing old receipts      |
| 6. Retained-state transaction cost                      | Medium, should-fix | Copy cost reduced; total latency mixed    | AgentControlStore; preserve isolation, external refresh and validation; matched benchmark |
| 7. Live readiness / stalled-request attribution         | High, should-fix   | Evidence fixed; cause unknown             | Existing live preflight and provider failure evidence; separately budgeted probe          |
| 8. Auxiliary request accounting                         | High, must-fix     | Implemented                               | Existing provider/task boundary, request budget and privacy-safe usage projection         |
| 9. Canonical command categories                         | Medium, should-fix | Projector verified                        | Existing evidence projector; aliases, unknown names and redaction tests                   |
| 10. Mutable grader authority                            | Critical, must-fix | Independent checks implemented            | Existing prepared fixture and grading boundary; selector/test mutation regressions        |
| 11. Shared-host memory spike                            | Medium, advisory   | Allocation reduced; cause unknown         | Attribute output allocations; preserve complete output and receipt semantics              |

Runtime, evaluator, Docker, persistence, provider accounting and evidence paths are in scope. Unrelated frontend cleanup,
stale-script deletion, new dependencies, release versions and a replacement harness are out of scope.

## Implemented contracts

1. Command cleanup returns void. The controlled completion-barrier regression failed before the fix and passes after it.
   Final output, physical settlement, cancellation and observers remain joined.
2. Docker accepts explicit build inputs and excludes nested environment files, dependency trees, local indexes, history,
   service data and artifacts. Only the two tracked non-secret evaluator environment defaults are included. Credentials
   enter through optional runtime environment injection. The image builds the checked-out public fixtures and extension;
   it no longer fetches an inaccessible moving external eval repository. IPC captures the exact host, installed entrypoint
   and manifest digests and process identity before benchmark dispatch. This scope does **not** attest every loaded file.
   The legacy API exporter preserves available installation receipts and continues to refuse complete experiment pairing
   when broader component identities are missing.
3. `canonical-file-tree-v1` normalizes CRLF only in valid UTF-8 text and preserves binary and invalid UTF-8 bytes. The
   earlier finding incorrectly described the public loader as already canonical; both owners used raw bytes. The shared
   contract now owns loading, generation and verification. The private companion migration proves equivalence against
   frozen public definitions and legacy seals before changing only the 28 public seal records. Original bytes are backed
   up under `F:/alpha-vscode-e2e-runs/remediation-20261002/seal-backups`. Holdouts, answers and graders are unchanged.
4. Executable shell scripts use LF. A fresh real PostgreSQL contract checks that both databases are created from the
   repository's actual script. Test Redis defaults match port 6380; the campaign normalizes the existing `openai-native`
   configuration alias to its OpenAI Compatible transport.
5. Existing harness lanes emit normalized service, Docker and broad unit receipts, retaining exact source inventories.
   Hard gates still reject missing, inconsistent, skipped or stale evidence. Telemetry's empty test script remains
   explicitly uncertified; existing platform/declared skips are retained as coverage limits.
6. The control store reuses the schema-parsed transaction draft and clones opaque payload/metadata values explicitly.
   No-op comparison, external refresh, full read/write validation, locks, leases and persistence fences remain intact.
   In the matched 5,000-agent diagnostic workload, median copy time fell from about 118–124 ms to 39–46 ms. Total latency
   is mixed: single-writer reserve/settle 1588→1535 ms; two-writer 2885→3008 ms. This is not a general throughput claim.
7. Live preflight makes one cancellable, tool-free readiness request per host launch, outside task-solving counts, with
   its own receipt and one-request cap. Main stream timeouts emit a stable request failure code, and workflow/attempt
   results preserve `request_timeout` beside the original lifecycle classification. A later healthy main request stops
   attribution to an older timeout. The original provider stall's root cause remains unknown.
8. Main and reasoning-summary requests carry separate purposes. Summary attempts and late/cancelled usage use captured
   step/request identities. Both purposes consume the same task request cap; reports retain their separate counts and
   usage provenance (`provider`, `estimate`, `unknown`). Readiness probes are reported separately. This corrects the
   original main-only budget, so new all-request totals must not be compared directly with old main-only counts.
   A subsequent capture audit found that the final E2E exporter omitted these additive fields. After sealing the complete
   frozen live pass, a synthetic journal regression reproduced that independent consumer defect. The exporter now retains
   only validated purpose/provenance enums and the stable timeout code, with unknown values and legacy absence still
   redacted. Original captures and live failures remain unchanged; a separate digest-matched original-journal audit records
   the available provenance. This reporting-only repair does not change model prompts, task execution or scored inputs.
   The strict outcome-proof consumer validates the same additive fields with exact enum and event-type checks. Its
   synthetic regression rejects unknown values, unrelated-event fields and unrecognized keys while preserving legacy
   omission. The initial consumer rejection remains an execution receipt; admission rules were not relaxed generically.
9. Evidence categories include `exec_command` and `write_stdin`, preserving legacy names, unknown categories and redaction.
10. Acceptance test selection and original bytes are captured before exposing the workspace. The existing grader runs
    copied edited source with original checks in an owned sibling snapshot, then verifies original check digests in both
    contexts. Added model tests remain work product. Selector redirection and modified/deleted originals fail; valid
    source fixes still pass. Snapshot copy and cleanup are bounded and reject linked paths. This is fixture integrity
    enforcement within Alpha's existing workspace/policy protection, not a new OS sandbox.
11. Execa disables duplicate process-output buffering and reads bounded binary chunks through one streaming UTF-8 decoder.
    Alpha retains complete command output and receipts. Three counterbalanced 16 MiB no-newline trials returned identical
    output digests: median peak RSS 231→110 MiB, median wall 213→148 ms. This isolated allocation result does not identify
    the cause of the original 2,793.68 MiB Alpha/Copilot/built-in shared-host peak.

No prompts, solutions, task selection, original grader checks, timeouts or security policies were tuned to live answers.
The original 31/32 result remains baseline evidence. Final validation uses the same full local task selection and exact
VS Code 1.125.0 signed-in profile, with the corrected accounting and independent acceptance boundary above.
