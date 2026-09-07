# Extension agent-loop audit revalidation — 2026-09-06

The September 4 audit's eleven original findings remain fixed in the revalidated paths. Six adjacent issues were
reproduced and assigned to separate Astra xhigh tasks with Luna Max implementation or review support. The parent task
reviewed the fixes and integrated them against one frozen working-tree baseline, preserving the existing evidence and
blocked-handoff work. This is a bounded follow-up, not a claim that the extension is free of other bugs.

The source baseline was `6a5c3a5745aa5339e9f2e27025bcc8ae42cf6c65` plus the checkout's existing uncommitted changes.
Each issue task committed that inherited state separately; only its subsequent fix was integrated into the original
checkout. No CLI or VS Code shim files, dependency versions, release versions, or lockfiles are part of this work.

## Latest run

The primary run stopped because replacement of its authoritative transcript failed with `EPERM`, followed by failure to
persist provider pacing metadata. It made no completed enhancement. The Explorer child had independently reached its
configured cumulative input-token limit; the primary continued afterward. Project command failures were environment or
import failures and did not justify framework-specific harness behavior.

See [the incident investigation](latest-run-transcript-contention-2026-09-05.md) for timestamps, bundle identification,
source reachability, and reproduction. The logs do not identify the lock holder or its duration. Bounded rename retries
repair the reproduced transient-contention failure, but cannot establish that this particular incident would have cleared
within the retry allowance.

## Confirmed adjacent issues

| Issue                                                | Owning boundary and resulting behavior                                                                                                                                                                                                                                                                | Regression evidence                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transient transcript replacement aborts the turn     | The shared atomic writer retries only `EPERM`, `EACCES`, and `EBUSY`, using the same synced temporary file. Strict failures preserve the old transcript and propagate after six attempts.                                                                                                             | Atomic writer faults and durable transcript receipt/reload tests; eight original failures.                                                                                             |
| Default diff editing overwrites dirty source buffers | The diff provider owns a separate editable temporary preview and retains the caller's raw baseline. Source writes occur through the existing guarded save boundary after approval. Denial leaves source data alone and retains unapproved user preview amendments.                                    | Real disk and controlled editor tests across preview, update, approval, denial, cancellation, and tool callers; an additional exact-host preview fixture.                              |
| Patch deletion ignores concurrent changes            | Deletion retains the parsed baseline, checks file identity/content and dirty documents around approval, and reports conflicts, denial, and cancellation through structured receipts.                                                                                                                  | Multi-target approvals, same-content replacements, dirty buffers, cancellation, and actual scheduler receipt tests.                                                                    |
| Managed-agent admission errors are marked successful | `delegate_task` and `spawn_agent` set existing error metadata when admission fails. Scheduler history, events, and returned results agree.                                                                                                                                                            | Real registry/scheduler integration cases; seven original failures and successful controls.                                                                                            |
| Generated images overwrite changed destinations      | The tool captures binary destination state before approval/generation and validates the actual PNG/JPEG output path. Exclusive creation protects missing destinations; existing files are compared through an open handle. Output candidates participate in scope validation and mutation accounting. | Controlled generation, concurrent edits/creation, custom editors, path policy, binary/partial writes, cancellation, receipts, and suffix accounting. No live image service was called. |
| Failed turns present an unexplained resume boundary  | The primary recovery boundary emits a persisted, localized explanation unless that attempt already has a visible error. It preserves intentional blocked handoffs and does not copy raw diagnostic text into the new message.                                                                         | Failed/incomplete/exhausted outcomes, pacing persistence, retries, deduplication, reload, and repeated webview hydration.                                                              |

The fixes use shared persistence, preview, tool metadata, and recovery boundaries. They do not change provider selection,
task-specific prompts, child token budgets, framework evidence rules, or approval authority.

## Original audit recheck

Historical details remain in [the September 4 audit](extension-agent-loop-bug-audit-2026-09-04.md).

| Findings      | Revalidated contract                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01, E06      | Failed/incomplete/exhausted primary turns retain a resumable input boundary; ordinary-text and tool completion share the open-todo policy.                                                                                                            |
| E02, E07, E08 | Direct saves and patch moves protect their baseline; native writes retain literal content, including empty strings and final-newline differences; failed saves remain errors. The new normal-preview/deletion/image findings extend those boundaries. |
| E03           | Explicitly unsuccessful compaction outcomes retain the prior active history.                                                                                                                                                                          |
| E04           | MCP adapters forward cancellation and the hub settles local aborts even when the transport ignores its signal.                                                                                                                                        |
| E05, E09      | MCP errors retain error receipts; embedded image/text/binary resources retain their supported representation and limits.                                                                                                                              |
| E10, E11      | Oversized matching lines are reported as incomplete matches; rendered output, retained data, regex work, and cancellation remain bounded.                                                                                                             |

Read-only finders ran the owning Task/retry/completion, compaction/context, file-tool/provider, MCP, scheduler, and command
output suites. Those commands overlap; their counts must not be added as a count of unique tests. Findings were promoted
only after checking current source and reproducing the adjacent defect. A speculative closed-editor guard and ambiguous
delegation-group status mapping were not counted as confirmed bugs.

## Integrated validation

The parent runs combined checks and serialized VS Code 1.122.1 host gates. Isolated-worker results above are supporting
evidence, not substitutes for testing the combined checkout.

- `pnpm --dir webview-ui lint` and `pnpm --dir webview-ui check-types`: passed in the combined checkout.
- `pnpm --dir src lint` and `pnpm --dir src check-types`: passed after localization and integration.
- `pnpm --filter @alpha-code/vscode-e2e lint`, `check-types`, and `exec tsc -p tsconfig.json --noEmit`: passed.
- The combined source regression run passed **399 tests across 17 files, with 5 existing skips**. It covers four atomic
  persistence/receipt suites, eight preview/file-tool suites, two image suites, task tool surface, retry wiring, and
  task persistence. The new ownership suite additionally exposed a drive-C fixture assumption when integrated on F:;
  normalizing any Windows drive fixed both fixture failures, and all **22 ownership cases** pass.
- Prettier checks pass for every issue/localization file. The full translation checker still exits 1, but its findings
  match the frozen baseline exactly after sorting report lines. All new backend messages have complete locale coverage.
- The isolated cached host reports **1.122.1**, commit `8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`. The parent sets
  `VSCODE_EXECUTABLE_PATH` to that executable and `ALPHA_E2E_EXPECTED_VSCODE_VERSION=1.122.1`, preserving the real-host
  version assertion. Each host run uses a temporary workspace/profile; user windows remain open.
- The first `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` attempt bundled the extension and built the webview,
  then stopped before test execution because the `vscode-updating` mutex remained held after the host's 30-second wait.
  After the user closed and reopened VS Code, the mutex cleared and the cached host still reported 1.122.1. The
  `test:smoke:1221:run` retry passed **8 tests**: extension registration/version (2), modes (2), and VS Code LM contracts
  including cancellation and recovery (4). The retry used the successful combined builds; no host or updater code was
  altered.
- `pnpm --filter @alpha-code/vscode-e2e exec node out/runTest.js --vscode-version 1.122.1 --provider scripted --file diff-preview-ownership.test`:
  **1 passed**, exercising real dirty source documents, an isolated editable preview, approval with a user amendment,
  source refresh, conflict, and denial.
- `pnpm certify:managed-agents:automated`: **passed**, with **1,726 deterministic tests**, **26 passing deterministic
  rows**, and **1 real-host managed-agent acceptance test**. The declared **8 integration rows remain pending**; this
  scripted host scenario does not claim to satisfy all live-provider, multi-window, or live-UI acceptance.

The deterministic outcome, source binding, track counts, and explicitly pending rows are recorded in
[the generated certification evidence](../artifacts/certification/managed-agent-milestone-evidence.json). After this report
was finalized, `pnpm certify:managed-agents` regenerates that evidence against the final documented source snapshot. The
scripted host result is reported separately above because the deterministic evidence file does not record host execution.

## Remaining limits

- Persistent permission failures or contention beyond the bounded retry allowance still stop strict transcript saves.
- The preexisting non-strict delete-then-rename fallback remains a separate risk if its fallback rename also fails; it is
  not used by strict authoritative transcript or v2 receipt writes.
- Optimistic filesystem checks cannot atomically compare and mutate against arbitrary external processes. Existing image
  writes are not crash-atomic; incomplete writes and completed writes followed by post-processing errors are reported
  distinctly. The final external-process check/write or check/unlink interval remains.
- Normal preview saving now shares direct-save source undo/save-participant behavior. Unapproved user changes in a
  temporary preview remain available for recovery rather than being discarded during cleanup.
- Automated and scripted-host evidence does not establish live provider quality, remove the managed certification's
  explicitly pending integration rows, or change the contents of an already running user's extension host.
