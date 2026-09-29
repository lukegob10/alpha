# Alpha 3.1.1 startup investigation

Investigated on 2026-09-28 against release commit `16590f9c123a19c096a185c78185d5c97e35b5df`.
Evidence includes console screenshots from another Windows PC, installed dependency source, regression tests,
and local timing comparisons. The affected PC's CPU profiles are unavailable here; the user supplied Copilot's
summary of them, which points to synchronous prompt preparation and capture/clone/hash traversal. That summary
reports a sampling gap during the 13.5-second pause and does not establish an agent/process loop or exact blocker.
Inspecting the existing 3.1.1 VSIX maps its reported `Js` symbol to `redactTaskPrivatePaths()` and `DNa` to
`replaceLiteral()` in `src/core/tools/taskPathPresentation.ts`. That path performs escaped literal replacements
over at most four normalized private-path variants for managed workers. It is distinct from the OS metadata probe;
the minified stack alone cannot attribute the unsampled pause to either function. No path-redaction policy was removed.

## Checkpoint initialization

The shadow Git repository successfully initialized in 24,823 ms. Its phase log reports:

| Phase                      |  Duration |
| -------------------------- | --------: |
| Nested repository scan     |    792 ms |
| Git init                   | 15,038 ms |
| Worktree configuration     |  1,209 ms |
| Initial snapshot           |  7,769 ms |
| Snapshot: git add          |  3,787 ms |
| Snapshot: index validation |  1,231 ms |
| Snapshot: initial commit   |  2,751 ms |

The configured checkpoint deadline is 20 seconds. `scheduleCheckpointInitializationTimeout()` in
`src/core/checkpoints/index.ts` disables checkpoints and settles the shared promise with `undefined` at that deadline.
`finishCheckpointInitialization()` refuses to publish a late result once the promise has settled. The service's
`initialize` event logs success independently of that task-level decision, explaining the successful Git log followed
by a persistent disabled-checkpoint banner. This is the current timeout contract, not a failed Git command.

The previous fix removed the separate successful-path Git availability probe. That probe is absent in this trace, so
the fix is active. It did not guarantee that the remaining Git initialization would finish within 20 seconds.
The expensive phase in this sample is `git init`, before staging workspace content. The phase's elapsed time includes process
launch, filesystem/Git work, and any delay before JavaScript can process completion. The screenshot does not establish
which accounts for the 15 seconds.

Later screenshots show a 42,554 ms new-repository initialization (19,787 ms nested scan, 14,447 ms Git init,
6,991 ms initial snapshot) and a 24,028 ms existing-repository initialization. VS Code attributes portions of the
unresponsive intervals to `alphainc.alpha`. Existing-repository worktree configuration lookup was missing from the
phase breakdown; it now has its own timing label. Git itself is called through asynchronous simple-git.

The final cancellation is explicitly `source=webview_stop`. The screenshot therefore does not show the checkpoint
timeout autonomously stopping the agent. Increasing the checkpoint timeout can accommodate this observed run, but
does not explain or improve the underlying delay. Checkpoint lifecycle policy is unchanged: adopting an initial
snapshot after the deadline would be unsafe if workspace mutations had already proceeded without checkpoints.

### Confirmed synchronous Windows probe

`getSystemInfoSection()` called `os-name` while constructing every system prompt. Its installed dependency
`windows-release@6.1.0` invokes `execaSync("wmic", ...)`, falling back to synchronous PowerShell/CIM.
This blocks the extension-host event loop, including unrelated task, Git, ripgrep, and streaming callbacks.
The shared prompt section now uses native `os.platform()` and `os.release()` on Windows. All task surfaces using
this section receive the fix; non-Windows descriptive OS naming is unchanged.

Local Windows measurements on 2026-09-28, three samples in one Node process, no model/provider/network workload:

| Operation (ms)                |  Sample 1 |  Sample 2 |  Sample 3 |
| ----------------------------- | --------: | --------: | --------: |
| Previous `osName()` call      | 2995.3867 | 2527.0882 | 2442.8158 |
| Native Windows version string |    0.1202 |    0.0193 |    0.0335 |

A zero-delay timer scheduled before each old call was delayed by approximately the same 2.4–3.0 seconds.
With the native replacement, timer latency was 3.7–15 ms. This proves removal of a local blocking operation,
not a guarantee that all checkpoint initialization on the other PC will complete within 20 seconds.
The regression test asserts that Windows prompt construction never invokes `os-name`, including repeated calls.

To repeat the operation/timer comparison, run this JavaScript with `node --input-type=module` from `src/`
(PowerShell can pipe a literal here-string into `node --input-type=module`):

```js
import os from "node:os"
import osName from "os-name"
for (let sample = 0; sample < 3; sample++) {
	for (const [name, read] of [
		["os-name", osName],
		["native", () => `Windows (kernel ${os.release()})`],
	]) {
		const start = performance.now()
		const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0))
		read()
		const callMs = performance.now() - start
		console.log({ sample, name, callMs, timerMs: await timer })
	}
}
```

The profile summary is consistent with this prompt-path finding but is not direct attribution of the full pause.
A rerun on that PC after the fix can establish whether the checkpoint deadline still expires. If so, standalone
Git timings in its AppData shadow-repository location can distinguish native process/filesystem cost from delayed
completion callbacks. Antivirus or corporate policy overhead remains an unproven hypothesis.

### Repeated snapshot hashing

`AgentStepContextBuilder` produces metadata and digests from one immutable context; each previously traversed and
hashed the whole snapshot independently. `getStepContextDigests()` now reuses its frozen result only for contexts
deeply frozen by `createStepContext()`. A weak map releases entries when contexts become unreachable. Legacy or
structurally typed inputs still recompute, even when their outer object is frozen; nested mutation cannot produce
stale hashes. Sanitization, immutable capture, provider request copies, and digest values are unchanged.

Run `pnpm exec tsx src/core/agent/benchmarks/StepContext.benchmark.ts` from the repository root. It builds the same
1,706,762-byte synthetic request 13 times, discarding three warmups. Node 24.14.1, Windows, same process conditions,
no provider/network activity. Ten measured samples in milliseconds:

| Version | Samples                                                                                  |  Median |
| ------- | ---------------------------------------------------------------------------------------- | ------: |
| Before  | 16.1927, 14.9654, 17.8054, 14.4009, 17.0742, 14.5492, 13.8992, 15.7438, 13.2780, 15.4134 | 15.1894 |
| After   | 8.3048, 8.4402, 7.3383, 8.6476, 7.7071, 7.6310, 8.8449, 9.9598, 7.9980, 7.5286           |  8.1514 |

Both versions produced context digest `52807c5858d3a6367d8be0569e80803698c01bb33f1fc9dd6b8b2ac59d94429b`.
This removes duplicate CPU work as contexts grow; the measured milliseconds do not explain the remote 13.5-second
stall. The focused test covers digest reuse and mutable legacy callers; existing retry/child/compaction tests cover
their independent context boundaries.

## Task and tool messages

- **Unknown `id`, `model`, and `reasoning_effort` parameters:** the display parser checked a global parameter-name
  list that had drifted from the actual ticket and agent schemas. Typed execution arguments already survived this
  projection. Both streaming and final display projections now preserve the argument names, without the false
  warning and repeated 110-name console dump. Existing schema and tool validation remain authoritative.
- **`head` is not recognized:** the command ran in `cmd.exe` but used Unix syntax. The actual shell was already
  reported correctly. The common environment section now includes brief dialect-specific guidance for cmd and
  PowerShell; this guides future commands but cannot guarantee the model never emits an invalid command.
- **Ripgrep exit 1/2/255:** exit 1 can mean no matches; exit 2 in the screenshot explicitly reports guessed missing
  `.html`/`.scss` files while the `.ts` component contains an inline template. These are command results for the
  agent to handle. Execa previously copied the entire command/output into the shared host console as well (83 kB
  in one screenshot). Ordinary nonzero exits now retain tool output and exit status without this duplicate dump.
  Unexpected process-start failures still log bounded error code/signal metadata.
- **Streaming preview drain timeout:** this is a bounded UI-preview wait, not a task-completion decision. The
  canonical tool result path continues after the preview is fenced. Its existing recovery guard remains in place;
  removing synchronous host blocking addresses one concrete source of delayed callbacks.

## Startup messages

| Message                                                               | Attribution and action                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403 for `chunk-BYCUR9qn.js` and `mermaid-bundle.js`                   | Both filenames are in Alpha 3.1.1. Vite's emitted preload helper prefixes dependencies with `/`, resolving against `vscode-webview://.../assets/` instead of the extension resource URL. Fixed with a relative Vite base.                                                                               |
| Missing description for `DialogContent`                               | Alpha's release announcement has a title and introductory paragraph but no accessible dialog description. Fixed by connecting that paragraph with `DialogDescription`.                                                                                                                                  |
| `local-network-access` unrecognized feature                           | VS Code 1.122.1's webview host adds this iframe permission. No Alpha change.                                                                                                                                                                                                                            |
| Marketplace tunnel failure / Dev Containers version lookup            | VS Code's marketplace/version lookup, not Alpha's webview resource loader. No change.                                                                                                                                                                                                                   |
| `devhub.citi-vscode-extension-marketplace` activation: socket hang up | Named third-party extension. No change.                                                                                                                                                                                                                                                                 |
| `punycode` deprecation                                                | Alpha's built extension includes a built-in `punycode` import from transitive `tr46@0.0.3`; it is a possible emitter, but the screenshot has no warning stack to identify the caller. This is a deprecation warning, not evidence of failed task execution.                                             |
| SQLite experimental warning                                           | The screenshot identifies only the shared extension host. No direct SQLite import was found in Alpha's source or built entry point. Exact emitter unproven; no change.                                                                                                                                  |
| `NODE_TLS_REJECT_UNAUTHORIZED=0`                                      | Alpha's sole setter is an opt-in debug proxy and returns immediately in normal installed/production mode. The installed 3.1.1 path is visible in this trace; this warning alone cannot identify which extension or inherited environment set the value. No change to user settings or other extensions. |
| Removed Git environment variables / selected ripgrep binary           | Expected Alpha isolation and binary-selection diagnostics.                                                                                                                                                                                                                                              |

## Resource fix and verification

The production Vite config previously used the default `/` base. The new `./` base makes the generated preload helper
resolve URLs using `import.meta.url`. This applies to the shared bundle used by sidebar, editor, and Tickets panels;
it requires no wider resource roots or weaker CSP. A deterministic Node test builds a lazy-import fixture using the
actual webview base configuration, executes Vite's emitted preload helper, and checks the requested resource URLs.
It reproduced the wrong `vscode-webview://alpha/assets/...` address before the fix and passes afterward.

The announcement test also failed before the fix because the dialog had no accessible description, then passed after
the existing introductory text was connected to the dialog.

Primary references inspected on 2026-09-28:

- [Vite base option](https://vite.dev/config/shared-options.html#base) and
  [module preload URL behavior](https://vite.dev/config/build-options.html#build-modulepreload).
- [VS Code 1.122.1 webview host](https://github.com/microsoft/vscode/blob/1.122.1/src/vs/workbench/contrib/webview/browser/pre/index.html),
  which sets `local-network-access` on the webview iframe.

## Validation

The focused extension run passed 290 tests covering system prompts, native argument parsing, command processes,
checkpoint lifecycle/timeouts, and real-Git shadow repositories. The full task suite plus snapshot/builder suites
passed another 271 tests, including preview stalls/cancellation and retry/child/compaction snapshots. Selecting only
preview tests initially exposed a pre-existing telemetry setup dependency in that file; running its full suite
supplied the setup and passed all those cases.

The preload URL test (one test) and announcement accessibility suite (three tests) passed. The preload and description
tests each reproduced their defect before the fix. Windows metadata, parameter display, nonzero-exit console, and
digest-reuse regressions also failed before their respective fixes.

Extension and webview typechecking and focused ESLint passed. `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221`
passed all 32 tests on VS Code 1.122.1, including its extension/webview build prerequisites. The gate exercised
activation, modes, approval/command behavior, tool search, tickets, asynchronous questions, plans, images,
compaction, and VS Code LM recovery.

`pnpm vsix` succeeded. `node scripts/verify-vsix-contents.mjs bin/alpha-3.1.1.vsix --check-source` verified all
1,671 archive entries, the absence of `.env` files, and 16 document assets against source. This is a local validation
package containing uncommitted fixes, not a newly published 3.1.1 release. Verification on the affected PC remains
necessary before claiming that its checkpoint warning and all long host pauses are resolved.
