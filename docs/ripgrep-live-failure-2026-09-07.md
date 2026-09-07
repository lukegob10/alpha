# Live task startup failure: missing host ripgrep

## Incident and owning layer

The user's 2026-09-07T00:43:33.144Z generic operation-failed message belongs to task
`01a07952-02dc-7205-a19d-acda8afe40ca`, running a review-and-small-enhancement request in Project Manager V2.
Its normal-profile lifecycle and turn journals both record **Could not find ripgrep binary**. The turn failed before
its first model request. This is distinct from the earlier ownerless shared-storage lock incident; retrying Copilot
authentication or removing another storage lock would not repair it.

The shared resolver in `src/services/ripgrep/index.ts` owns binary discovery for file listing, search and checkpoints.
Its internal-host fallback knew flat `bin/rg.exe` layouts, but not the host's `bin/<platform>-<arch>/rg.exe` layout.
The extension's bundled package had JavaScript but no executable on this machine, and the normal Windows PATH had no
ripgrep. Codex's injected PATH did have a binary, masking this defect in earlier host tests.

Read-only filesystem inspection confirmed these installed layouts:

- VS Code 1.136.1: `resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe`.
- VS Code 1.122.1: `resources/app/node_modules/@vscode/ripgrep-universal/bin/win32-x64/rg.exe`.

Both installations place `resources/app` below a commit-named directory. Resolve relative to the actual `vscode.env.appRoot`,
not a guessed installation root. Primary sources checked on 2026-09-07:
[vscode-ripgrep packaging](https://github.com/microsoft/vscode-ripgrep) and the
[exact VS Code 1.122.1 adapter](https://raw.githubusercontent.com/microsoft/vscode/1.122.1/src/vs/base/node/ripgrep.ts).

## Correction and regressions

The resolver now checks the current platform/architecture subdirectory and the legacy flat layout in normal and unpacked
module roots. It retains bundled-package and PATH precedence, avoids probing unrelated host architectures, and does not
copy binaries, change dependencies, or suppress startup errors.

Eleven new real-filesystem regressions failed before the fix and passed afterward: ten modern-layout cases across Windows,
macOS and Linux targets/module roots, plus rejection of a different architecture's host executable. These use empty PATH
and disable runtime package discovery, so the developer environment cannot satisfy the assertion accidentally.

The first post-fix live attempt exposed an independent harness defect: Luna emitted five permitted Git commands in one
assistant response, but approval matched only the last call; Windows drive-letter casing could also reject the correct
workspace. The harness now matches commands within the latest assistant batch using native path equality. Exact command
allowlists, phase scope, rejection of forged roles/stale turns, and conflicting/outside workspace rejection remain intact.
Two focused regressions failed before that correction and passed afterward. This is test-harness code, not a relaxation
of Alpha's production tool policy.

## Live evidence, not scripted acceptance

These runs reused the signed-in persistent 1.136.1 profile and exact Copilot `gpt-5.6-luna`, effort `high`.
Each host inherited the normal Windows Machine + User PATH, not Codex's injected PATH. The process-local PATH was restored
after execution. No credentials, normal user data, or persistent environment settings were copied or reset.

| Run ID                        | Outcome                   | Guarded requests | Evidence                                                                                                  |
| ----------------------------- | ------------------------- | ---------------: | --------------------------------------------------------------------------------------------------------- |
| `live-rg-repro-1361`          | Failed before fix         |                0 | Same missing-ripgrep startup failure                                                                      |
| `live-rg-fixed-1361`          | Failed after resolver fix |                2 | Reached live model; exposed command-batch harness defect                                                  |
| `live-rg-verified-1361`       | Passed                    |                2 | 42 checks: actual Git inspection, complete tool receipts, unchanged HEAD/index/tracked/untracked data     |
| `live-review-verified-1361`   | Passed                    |               15 | 74 checks: review, fix, tests, one local commit, uncommitted follow-up; four completed turns in one task  |
| `live-refactor-verified-1361` | Failed strict trace check |               15 | Model repeated a successful commit under a new call ID; second command returned exit 1, nothing to commit |

Retained evidence root: `F:/alpha-vscode-e2e-runs/20260907/artifacts/`. Each run has `workflow-result.json`,
`run-result.json`, host/preflight receipts and bounded canonical trace projections. Original failures remain retained.
Passing runs verified actual host/model/effort, host exit and ownership, and completed evidence capture. The workflow
checks independently examine repository behavior and persisted trace transactions, not merely the assistant's claims.

The refactor trace contains the successful first commit receipt before the second, newly generated command. There is no
evidence here of the scheduler replaying one accepted call. The turn completed, but
`devRefactorExtract_no_unexpected_tool_errors` correctly rejected it; later independent outcome assertions were not reached.
Do not silently deduplicate arbitrary shell effects or convert that command's error into success. One harness limitation
worth addressing separately is that this phase asks for a clean final tree but does not allow a read-only `git status`
command. It does not establish why the model chose to repeat its commit.

## Normal Project Manager profile verification

After rebuilding, the existing F5 Project Manager window was reloaded and Alpha activated. An activation attempt during
the build had encountered the temporarily absent `src/dist/extension.js`; after the completed build and reload, the panel
loaded again. Avoid clearing/rebuilding the bundle while asking the user to test that development host.

A bounded read-only review was submitted through the actual Alpha input, preserving the user's saved Luna Max profile.
Task `01a07963-a68a-74a7-b6c4-5d8e8220ba8c` successfully initialized its checkpoint/shadow repository, then failed model
selection and exhausted its provider retry budget. This was **not** another missing-ripgrep or ownerless-lock error.

The same window's Copilot log records `GitHub login failed`, `no Copilot token source`, and unavailable language models
without that token source. Other providers' available models must not be mistaken for Copilot availability. The Alpha
settings panel also reports that the saved model is unavailable in this window. The dedicated authenticated test profile
is independent of this normal profile; passing there does not restore this window's credentials.

The user was asked to sign in through Copilot in the normal Project Manager development window and leave it open.
No authentication/permission dialog was automated, no credentials were transferred, and no provider settings were changed.
At this checkpoint the actual-window workflow is **blocked pending user sign-in**, not passed. Its journals are retained
in normal Alpha task storage. After sign-in, rerun the same bounded review and inspect its actual terminal/result receipts.

Follow-up: the user subsequently confirmed that the normal extension works after signing into Copilot. This is user-reported
normal-profile acceptance, distinct from automated matrix evidence. The next engineering change is the repeatable
[on-demand live harness gate](live-harness-gate.md).

## Validation and limits

- Four focused extension test files: **41 passed** (resolver, file listing, ripgrep parity, file search).
- Extension typecheck and lint passed; harness typecheck and lint passed.
- Harness unit suite on the final compiled source: **309 passed, 2 platform-specific skips**.
- Extension bundle and webview build passed.
- Exact `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` passed with the normal Windows PATH: activation (2),
  modes (2), and scripted VS Code LM contracts (4). The final host exited at 2026-09-07T00:56:05.636Z. Its log explicitly
  selects the 1.122.1 internal universal target binary. Expected injected transport failures and nonfatal host warnings
  exist in the log; a passing gate is not a claim of zero log errors.

This evidence closes the reproduced binary-discovery defect, not every possible agent failure. The exact-host smoke uses
a deterministic LM fixture: live Copilot on 1.122.1 remains separately blocked by the previously captured bundled-provider
exception. Ownerless-lock crash prevention is also separate. See [live development suite](live-development-suite.md) and
[storage incident](ownerless-lock-incident-2026-09-06.md). Do not treat these bounded live samples as a general 100% guarantee.
