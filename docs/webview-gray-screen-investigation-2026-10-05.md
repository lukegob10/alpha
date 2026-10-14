# Gray webview after API work: investigation

Date: 2026-10-05. Reference host: VS Code 1.125.0. React dependency: 18.3.1.

The reported incident involved a gray screen after API data retrieval and analysis appeared to finish. Refresh restored
the screen. Investigation assumed the Alpha chat webview; the affected surface, task ID, and incident timestamp were
not confirmed. Available local VS Code logs contain earlier extension-host stalls, but no renderer exception could be
matched to this incident. The original triggering exception remains unknown.

## Additional user-supplied review

A subsequent screenshot of an Alpha incident review reports successful loading of `skill-builder`, three failed reads
of missing package/script/test paths, and confirmation that an ignored `.agents` package was absent from the worktree.
The agent returned a blocked review without changes. The screenshot also reports one `write_stdin` result with exit
code 2 and empty output, followed by normal lifecycle completion: 12 tool calls, zero retries, and completed turn/task
records. These statements were not matched to a raw task trace in the inspected local task stores.

The review explains the file-availability blocker. It supplies no webview exception or evidence connecting that blocker
to the gray panel. Normal runtime completion does not establish that the UI continued rendering afterward. Whether the
review describes the original data/API task or a separate investigation remains unconfirmed.

Current `src/core/tools/ManageCommandTool.ts` copies the retained command's exit code into polling results and retrieves
only output that has not already been delivered. Consequently, exit code 2 with empty polling output does not by itself
establish that the polling adapter failed or that the command never produced output. The preceding command and matching
session receipt are needed to identify this failure. No additional runtime fix was made from the screenshot alone.

The crash-handler defect below remains independently reproduced; its involvement in the reported incident is still
unproven.

## Reproduced defect

`webview-ui/src/App.tsx` wraps the chat and its providers in `components/ErrorBoundary.tsx`. The boundary used the
truthiness of its displayed error text as its failure state:

- An error with an empty message and stack caused the boundary to render the failed child again. A deterministic
  regression test failed before the fix because the error escaped instead of producing the fallback screen.
- An error without a stack initially produced the fallback, but asynchronous diagnostic enhancement replaced its error
  text with `undefined`. A second regression test failed because the boundary automatically retried its child and lost
  the fallback screen.

These are failures in UI crash containment. They can happen independently of task execution and persistence, so an
apparently completed task does not rule out a later rendering failure. They demonstrate a possible route to an empty
panel, not the cause of the reported incident.

## Corrected contract

The boundary now records failure separately from diagnostic text. Missing diagnostics cannot reset that failure or
retry the child. It preserves the original error and component stack if source-map enhancement fails, handles thrown
strings, null, and undefined, and contains failures in diagnostic reporting. Existing successful source-map reporting
and fallback presentation are preserved. Task lifecycle, persisted formats, and extension/webview wire shapes do not
change.

The primary external reference is React's
[Component / Error Boundary documentation](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary),
retrieved 2026-10-05. It specifies fallback state separately from the caught value and explains that JavaScript can throw
values other than `Error`. This renderer-only change does not alter Codex-aligned agent behavior.

## Validation

- Both focused reproduction tests failed before the fix for the intended reasons.
- Nine focused webview test files passed: 263 tests covering the boundary, chat completion/scrolling, row isolation,
  MCP responses, Markdown, code/diagram rendering, and extension-state projection.
- `pnpm --dir webview-ui check-types` passed.
- ESLint passed for the two touched TypeScript files; focused formatting and `git diff --check` passed.
- `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` passed: all 13 suites and 42 tests, with no pending or failed
  tests. Every runner receipt confirmed actual VS Code 1.125.0. Runs used disposable owned profiles and scripted
  providers, with the VS Code LM fixture for its contract suite. The gate also completed the production builds.

To attribute the original incident, retain its task ID and time together with the webview console exception. The current
local logs are insufficient to establish that this reproduced defect was the triggering path.
