# Harness quality: acceptance evidence, command control, and workflow continuity

This change implements three focused improvements in the extension's existing execution kernel. It does not introduce
a sandbox, a replacement agent loop, or another browser engine. Competitor assessment scores remain forecasts; these
changes alone do not establish an 85–88 measured score.

## 1. Optional acceptance checks with reusable evidence

`update_todo_list` accepts an optional `work_plan` containing an objective, constraints, resource/evidence notes, and
executable checks. Existing calls without a plan remain valid. Null preserves the plan, and trivial work does not need one.

A check names its exact command, working directory, and relevant source/test/configuration/dependency files. Command
admission records the input hashes and persists a running receipt before process launch. Settlement records the actual
exit outcome and checks that the inputs remained unchanged. Completion rechecks the declared inputs, so a passed check
can be reused without another model/tool execution. Unrelated edits do not invalidate that check.

Missing, failed, stale, or unavailable declared checks reject successful completion through the existing completion gate
and bounded repair policy. Pending commands and evidence publication retain their runtime waiting state. Paths must pass
the existing bounded workspace reader and ignore policy. A newer execution or user request cannot be overwritten by a
late result from an older command. Interrupted and external/live checks become stale on reload; external/live checks are
also invalidated by new user feedback.

This is evidence for **declared inputs and coverage**. Alpha cannot infer a complete dependency graph or prove that an
agent-selected test covers every requirement. External/live checks must use `reusable: false`. Check plans and notes are
task data, not permission grants. Plans have at most 16 checks, 64 distinct input paths, and 12,000 serialized characters.

## 2. Task-owned command controls and application feedback

Background `execute_command` responses expose an execution ID. `manage_command` uses the existing terminal registry and
command evidence to wait, request a stop, or send literal input where the terminal provider supports it. It cannot act on
another task instance's command. Waits wake on output/settlement, time out within 30 seconds, propagate cancellation,
and remove listeners and timers. Returned output uses the existing bounded output receipts.

Input and stop retain command approvals and recheck ownership after approval. Input uses the workspace mutation gate;
waiting does not hold that gate, because command evidence settlement needs it. A stop request is not reported as proof
of exit. Interactive input is supported by the VS Code terminal provider; Execa reports it as unsupported.

The VS Code terminal's background abort path now sends its interrupt even after foreground streaming has ended. Task
cancellation also finds owned background processes through the existing registry. Worker tasks receive the same command
control within their existing authority ceiling.

Application inspection continues through Alpha's existing VS Code browser adapter. The live exercise waits for the
server's observed URL, verifies HTTP behavior, opens the page, clicks a button, reads the changed page, and stops the
original command. It does not treat a running process as proof of readiness.

## 3. Durable task and skill continuity

The optional working record is stored in existing task history metadata and projected through the existing environment
context. Unchanged records are omitted from subsequent context deltas and restored after compaction. Reload restores
the objective, constraints, notes, and skill identities without mutating the saved input record.

Successful skill loads retain bounded name/path/instruction-digest identities. The skill prompt permits sequential
composition of relevant skills and resolves resources relative to the selected skill. Saved identities are not a copy
of the instructions: relevant instructions must be reloaded if absent after compaction. Skills cannot widen policy or
override the user's scope. Long skill catalogs are bounded in the model projection, with an explicit omitted count;
the saved identities remain available in task metadata.

The principal additions are one shared data schema, one evidence helper, and one command tool. Existing task history,
completion policy, mutation gate, terminal registry, environment deltas, skill loader, and browser adapter remain owners
of their respective behavior. No production dependency or saved-task migration is added.

## Verification

Deterministic coverage includes failed checks and repair, scoped invalidation, changed inputs during execution, ignored
and outside paths, late results, repeated completion without rerunning commands, completion/admission races, task reload,
compaction projection, skill identity retention, bounded command waits, cancellation, denied input, ownership races,
and background terminal input/abort.

The live suite is `apps/vscode-e2e/src/suite/harness-quality-live.test.ts`. It uses real Copilot requests and saves request
counts, timing, tool transactions, working records, and file hashes. Its cases cover a failing invoice check and
repair, server readiness and termination, browser interaction, and a two-skill workflow. Command and browser probes are
independent, so host browser problems do not hide command-control evidence. The first case requires exactly two model
command calls (baseline failure and repaired success) and independently reruns an unchanged test oracle. All cases
compare the working record with saved task metadata. This is a narrow correctness exercise, not a product benchmark.

Validation on Windows with Node 20.19.2 and pnpm 10.8.1, completed September 16–17, 2026:

| Check                                                    | Observed result                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Extension suite, `pnpm --dir src test -- --maxWorkers=4` | 9,344 passed, 42 existing skips; 586 passing files                                                                            |
| Webview suite                                            | 1,828 passed, 3 existing skips                                                                                                |
| Remaining workspace suites                               | Core 167, types 321, IPC 3, CLI 493, shim 407, web evals 33, build 1 passed; CLI has 2 existing skips; telemetry has no tests |
| E2E runner unit suite                                    | 374 passed, 2 skipped                                                                                                         |
| Repository lint / type checking / `pnpm knip`            | Passed                                                                                                                        |
| Extension and webview builds                             | Passed                                                                                                                        |
| `test:smoke:1221`                                        | 10 real-host tests passed: activation, modes, LM tools, resume, cancellation, and error recovery                              |
| Strict deterministic managed-agent certification         | 1,963 passed, no skips, source stable throughout the run; 26 matrix rows passed                                               |

The managed-agent real-host acceptance also passed on 1.122.1 (nested Apply/discard, verification, projection, and
navigation). Its build initially encountered a transient Windows `ENOTEMPTY`; the unchanged build and host gate passed
on retry. The local VSIX passed `verify-vsix-contents.mjs --check-source`: 1,856 entries, required files present,
no packaged `.env`, and 16 document assets matching source. No version was changed or release published.

The initial aggregate workspace run exposed stale test fixtures and Windows resource contention. The corrected
extension suite passed in full with four workers, alongside the other passing workspace suites. No behavioral assertion
or test timeout was weakened. Six reviewed snapshot changes each update the same existing planning instruction.
The shared icon button also needed an explicit `type="button"`, exposed by the message-action regression test.

The certification's rendered completion-idle replay used the previously captured
`completion-idle/artifacts/live-after-02/completion-idle.json` fixture (VS Code 1.136.1). That is replay evidence only;
the fresh compatibility gate above ran on **1.122.1**. The certification matrix still identifies eight broader integration
areas outside its deterministic scope; a passing deterministic gate does not certify every real-provider scenario.

Local logs and certification evidence are retained under
`F:/alpha-vscode-e2e-runs/harness-quality-20260916/validation/`. Live run artifacts are under the sibling `artifacts/`
directory. Early runs are retained as failures: the updater lock, an out-of-scope skill read, host browser confirmation,
the fixture's inherited 30-second command timeout, Windows line endings, and a JSON prototype-comparison assertion.
None is counted as a successful live run. Two later development-host launches did not reach webview readiness while
using the workspace's active Vite server. Final live validation uses the locally packaged extension in the owned test
profile, with the loaded extension path asserted and bundle hashes retained in `validation/package-identity.json`.
This avoids depending on the development server.

### Live Copilot results

The packaged extension ran on VS Code **1.122.1**, using Copilot **gpt-5.6-luna**, reasoning effort **high**. These are
single successful samples per contract, not a before/after latency benchmark or a broad quality-score measurement.

| Contract                                                                                                     | Result                                                          | Model requests | Elapsed |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------: | ------: |
| Declared check fails, scoped repair succeeds, evidence persists                                              | Passed (`luna-1221-harness-6/acceptance-repair.json`)           |              8 |  45.4 s |
| Delayed server starts once, READY is observed, HTTP passes once, original execution stops with observed exit | Passed (`luna-1221-harness-7/command-session.json`)             |              6 |  37.7 s |
| Two skills compose, output is checked, constraints and identities persist                                    | Passed (`luna-1221-harness-6/skill-composition.json`)           |             10 |  50.9 s |
| Browser opens the real page, clicks Count0, reads Count1, and observes original server exit                  | Passed unattended (`luna-1221-harness-10/browser-session.json`) |              9 |  49.9 s |

The initial browser probe opened and read the real page, but its click timed out while waiting for the element to be
visible, enabled, and stable. Reopening required another host confirmation, and the server reached its configured
timeout. That run did not pass. The model reported the failure instead of claiming the click succeeded.

The final browser run used `host-browser-approvals.ts`, an exact-1.122.1 test fixture that validates ownership of the
profile and workspace. The host's audited tool-ID map grants only `open_browser_page`; its nonpersistent test context
handles the initial opt-in. The previous setting is restored in `finally`, including failed runs. It is never imported
by the shipped extension. The successful run required no manual page approval, and the temporary setting was absent
after teardown. This does not establish the cause of the earlier click timeout or justify suppressing actionability
checks. No click assertion, host implementation, or browser engine was replaced.

For normal Alpha use, VS Code owns confirmations for `lm.invokeTool` calls outside native Chat. The supported setup is
**Chat: Manage Tool Approval**, granting saved pre-approval to the specific browser tools the user wants to automate
(page opening, and navigation if needed). Alpha already honors those host grants. This is a one-time host setup, not a
new prompt for each page. Alpha's own auto-approval switch cannot replace that host grant through the stable API.
The test-only opt-in context and internal map format are not a production solution; this change does not silently
change the user's normal VS Code profile. See [VS Code approvals](https://code.visualstudio.com/docs/agents/run/approvals)
and [browser tools](https://code.visualstudio.com/docs/agents/run/browser-tools), consulted September 17, 2026.

## Reference basis

Primary documentation consulted on **2026-09-16**:

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model): proportionate verification and
  avoiding unnecessary repeated checks.
- [Codex skill guidance](https://learn.chatgpt.com/docs/build-skills): progressive instruction/resource loading.
- [Cursor browser tools](https://cursor.com/docs/agent/tools/browser): application feedback within the agent workflow.
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices): concrete verification and context management.

These informed behavioral goals; no vendor implementation or prompt was ported. The compatibility target remains the
unmodified **VS Code 1.122.1** host. Its installed source was also inspected to identify the browser capability and explain
the system updater mutex that blocked initial host launches.
