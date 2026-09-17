# Focused live Copilot file-tool probes

`apps/vscode-e2e/src/suite/file-tools-live.test.ts` sends real model requests through Alpha's VS Code LM adapter and
normal tool scheduler. It uses the existing dedicated Copilot profile, request-budget guard, completion-review helper,
and persisted transaction checks. It does not replace the model response or invoke file tools directly.

The three probes cover the GPT-5.6 Luna tool surface:

- **Patch bytes:** read and patch a UTF-8 BOM/CRLF file without a final newline. Compare every saved byte, including
  literal dollar replacement tokens and HTML entities. Require the model to submit the mixed LF/CRLF patch argument
  that exposed a parser bug during the initial live run.
- **Partial patch:** request one four-file patch with an intentionally invalid second edit and an ignored fourth
  file. Require an error receipt with `applied`, `error`, `applied`, and `skipped` entries; verify that independent
  valid writes succeed and the mismatched/ignored files remain unchanged.
- **Search modes:** request one batch containing an invalid regex, literal files-only search, occurrence counts,
  default multiline snippets, and a count search exceeding capture limits. Require partial batch success, actual
  diagnostics, `.alphaignore` filtering, compact output, and explicit truncation.

Each case allows at most 12 actual model requests and 180 seconds to complete. Only the relevant file tools and
completion are enabled. Every accepted tool call must have one persisted result. Fixture contents are synthetic;
per-case JSON evidence records the actual model, requests, tool transactions, and final file hashes. The workspace
must be a runner-owned disposable directory, and fixture creation refuses to overwrite existing files.

Build the current extension and compile the suite, then run only this file:

```powershell
pnpm bundle
pnpm --dir apps/vscode-e2e test:copilot --vscode-version 1.136.1 --profile-dir F:\alpha-vscode-e2e-runs\20260906\profiles --workspace F:\alpha-vscode-e2e-runs\file-tools-20260915\workspace-01 --artifacts-dir F:\alpha-vscode-e2e-runs\file-tools-20260915\artifacts --init-profile --model-id gpt-5.6-luna --reasoning-effort high --file file-tools-live.test --run-id luna-file-tools-01
```

Use a fresh workspace and run ID for a repeat. The example reuses an already authenticated profile and initializes
only missing owned roots. See [live profile setup](vscode-live-test-profiles.md) for first-time authentication.
This live target is supplemental to the VS Code 1.122.1 compatibility contract; it is not the full smoke suite.

Luna normally exposes `apply_patch`. These live probes do not claim coverage of the separately selected `edit`,
`search_replace`, `edit_file`, or `apply_diff` paths; their byte-preservation regressions remain covered by focused
unit tests. One passing live sample demonstrates these observed tool contracts, not a general solve-rate or billing
improvement.

## Observed run: September 15, 2026

The final run, `luna-file-tools-03`, passed all three cases with real Copilot `gpt-5.6-luna`, high reasoning effort,
on VS Code **1.136.1**. It used nine model requests: four for byte preservation, three for partial patch reporting,
and two for search modes. Each task completed once, and all tool calls had exactly one persisted terminal result.
The full suite and the VS Code 1.122.1 smoke gate were not run as part of this focused live verification.

The earlier evidence is retained. Run 01 revealed a test expectation error: independent valid patch hunks still apply
when another hunk fails preflight. Run 02 passed partial-patch and search checks but exposed a real parser defect:
CRLF patch separators leaked carriage returns into replacement lines, yielding doubled CRLF endings. The diff preview
guard rejected that write and preserved the original file. `parsePatch` now recognizes both LF and CRLF separators;
the file-edit projection still restores the original file convention. The new regression failed before the fix, and
all 79 focused parser/application/tool tests passed afterward. Extension and E2E lint/type checks and the bundle passed.

Local evidence is retained under `F:\alpha-vscode-e2e-runs\file-tools-20260915\artifacts\luna-file-tools-03`:
`run-result.json`, `host-preflight.json`, and the three per-case JSON files. Build hashes are recorded in
`F:\alpha-vscode-e2e-runs\file-tools-20260915\source-build-03.json`. These receipts describe one bounded successful
sample, with no claim of broader model reliability or exact-host certification.

## Read-continuation integration: September 16, 2026

The three cases passed again with the shared reader and scheduler allowance changes, using Copilot GPT-5.6 Luna/high
on VS Code 1.136.1. The rerun used nine model requests (4/3/2) and is recorded under
`F:/alpha-vscode-e2e-runs/read-evidence-20260916/artifacts/filetools-final`.

The reusable runner is in
[`live-file-tool-support.ts`](../apps/vscode-e2e/src/suite/live-file-tool-support.ts). The four additional
[read/repair/review probes](../apps/vscode-e2e/src/suite/read-evidence-live.test.ts) cover named-function repair,
batched selections, gap-free continuation, and access-control review. Use the profile command above with
`--file read-evidence-live.test`, a fresh owned workspace, and a new run ID. The helper retains plain-text and tool-based
completions, along with request counts, tool results, timing, and file hashes.

The [pagination regression tests](../src/core/tools/__tests__/readFileTool.pagination.spec.ts) exercise the deterministic
continuation contract through the reader and scheduler, including output limits, stale cursors, and Unicode fragments.
