# Zoo extension reliability: patch-level comparison

Reviewed September 9, 2026, America/New_York, against Zoo
`313ca59cbf0f809cf8066f51cd44510c63c850ef` and Alpha `127978c916897dd532b80ddfdb789f00f5a308fb`
with its existing working changes. This supplements the [initial comparison](codex-zoo-agent-runtime-review.md).

Implementation follow-up: the [compaction/recovery implementation](compaction-recovery-implementation.md) fixes the
archive-counting failure and resume hydration, with deterministic regressions and six passing live Copilot attempts.
The review below preserves the original findings; broader rendering and presentation work remains separate.

## Correction to the original review

The first review concentrated on the known compaction failure and compared a small set of runtime abstractions.
It underexamined Zoo's recent bug-fix history, persistence changes and webview behavior. Finding equivalent abstraction
names in Alpha did not establish that Alpha covered the same failure cases. Zoo's shared extension ancestry makes its
concrete fixes particularly useful for the reported symptoms.

This pass inspected the actual patches and current source for eight relevant Zoo changes. Several are missing or only
partially covered in Alpha. The source differences below are established; their connection to the user's observed
freeze, empty-response warning or inability to restart still requires reproduction. No upstream success is treated as
proof that Alpha will improve by copying the patch.

## Primary guidance: compaction and recovery

Zoo's useful contribution here is its concrete compaction and recovery behavior. Adopting its orchestration core is
unnecessary. Alpha's existing kernel, context manager and persistence boundaries should own any resulting changes.
The broader extension findings below remain secondary to the reproduced automatic/manual compaction failure.

### Compare the context that each implementation actually installs

Zoo summarizes the conversation since the preceding summary, tags previous messages with `condenseParent`, and appends
a new summary. Its next request uses the latest summary plus subsequent messages; older messages remain stored for
rewind. It counts the actual wrapped summary, system prompt and tool definitions rather than treating summary output
tokens as the size of the next request. See
[summary construction and counting](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/condense/index.ts#L451)
and [effective history](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/condense/index.ts#L546).

Alpha summarizes an older prefix and retains recent complete steps verbatim. It counts summary, retained tail, system
and tools together, rejecting nonfinite or over-target results before installing them. Consequently, a successful
provider request containing nonempty text can still produce an unusable candidate. This is an important structural
difference, but the live failure's rejection branch has not yet been identified. See
[`summarizeConversation`](../src/core/condense/index.ts).

Zoo's return boundary does not enforce Alpha's finite/target checks. Its apparent ability to continue is therefore not
evidence that Alpha should remove those checks. Nor can Alpha simply discard an oversized tail: that tail was excluded
from the summarization request, so discarding it would lose information that neither retained context nor summary covers.

**Next comparison:** expose the existing rejection stage and candidate token breakdown, then replay the failing workload
through Alpha's current policy and a test-only Zoo-style whole-active-history summary policy. Hold model, usable input
budget, tools and workload constant. Compare accepted size, retained task facts, complete tool transactions, next-turn
correctness, total requests and time. Each policy needs a response appropriate to its own summary input; reusing a
prefix-only summary as if it covered the whole conversation would invalidate the test. Start with scripted fixtures;
use bounded live Copilot samples only after the deterministic comparison explains the branch being exercised.

### Keep recovery reversible and require progress before another request

Zoo retains original messages and tests removal of a summary, repeated condensation and subsequent user messages.
These tests are useful even though Alpha already has non-destructive markers: verify their interaction with Alpha's
retained tail and canonical provider transcript rather than adding another history mechanism. See
[rewind regressions](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/condense/__tests__/rewind-after-condense.spec.ts).

When summarization fails and the context still exceeds its allowance, Zoo can fall back to fractional truncation.
Its context-window error path retries up to three times and clears condensation progress in `finally`. See
[context management](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/context-management/index.ts#L292)
and [context-window recovery](https://github.com/Zoo-Code-Org/Zoo-Code/blob/313ca59cbf0f809cf8066f51cd44510c63c850ef/src/core/task/Task.ts#L4248).

Borrow the explicit fallback and cleanup scenarios. Keep Alpha's stronger token-budget truncation, tool-pair integrity
and no-progress/exhaustion checks. A retry must have a valid, durably installed changed context; repeatedly submitting
the same rejected context wastes requests. Recovery failure must release the turn and preserve history so the user can
submit another question or reopen the task. The resume read-before-write gap in finding A is directly relevant here.

### Focused regression matrix

| Case                                                 | Required observable result                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Nonempty summary with an oversized retained tail     | Precise rejection reason; original history preserved; bounded recovery                  |
| Summary failure followed by successful truncation    | Valid smaller context installed once; next request uses it                              |
| Summary and truncation both fail or make no progress | No repeated identical request; terminal state and usable follow-up                      |
| Two compactions, reload, then a new question         | Latest summary and required recent state restored; answer retains seeded facts          |
| Rewind across one or both summaries                  | Correct original messages reactivate without duplicate tool execution                   |
| Cancellation during summary, counting or persistence | Late result cannot replace history or reclaim the turn                                  |
| Eviction or read failure during reopen               | Existing bytes survive; abandoned task cannot rewrite them                              |
| Reopen immediately at completion                     | The specific completed turn and tool receipt are durable, not merely a nonempty history |

These tests distinguish progress from a spinner disappearing. Live acceptance must also verify the post-recovery answer
and final code result; a successful summary API request alone does not establish successful compaction or recovery.

## Additional findings and adaptation decisions

### A. Reopening a task can write before all history has loaded

Zoo [#1319](https://github.com/Zoo-Code-Org/Zoo-Code/commit/8d296deef53a1b6756016cc22e78f8a587093493)
changed resume to read UI and API history first, check cancellation after reads, then hydrate both without a standalone
write. It also changed history readers to distinguish missing/invalid/I/O failures, preserved finalized reasoning,
introduced message identifiers for merging snapshots, and tested eviction during the API-history read.

Alpha's [`resumeTaskFromHistory`](../src/core/task/Task.ts) still follows this order on its reopened-task path:

1. Read UI history and remove resume/reasoning/request rows.
2. Call `overwriteClineMessages`, which persists the modified UI history, and read it again.
3. Load API history afterward.

[`readTaskMessages`](../src/core/task-persistence/taskMessages.ts) returns an empty array for missing history, JSON
parse failures, invalid root shapes, and failures caught while reading an existing file. The resumed task can therefore
write an empty/modified UI transcript before API history recovery has succeeded. Resume also removes all trailing
reasoning rows, while Zoo now removes only incomplete trailing reasoning.

This finding concerns the reopened-task path. Alpha's retained completed-task follow-up avoids these disk reloads.
Alpha also has verified v2 provider-transcript recovery in `getSavedApiConversationHistory`, so a tolerant legacy API
reader alone does not establish loss of canonical API history. That protection does not make the earlier UI write safe.

**Priority P0: adapt the read-before-write invariant.** Read and validate both histories under the existing task owner;
check cancellation/ownership after each await; hydrate without saving; preserve finalized rows. A read failure must
preserve the existing bytes and report recovery failure. Distinguish opening an existing task from creating an empty
new task. Preserve Alpha's v2 transcript, generation guards and explicit rewind semantics. Do not transplant Zoo's
merge algorithm indiscriminately: merging old disk-only rows could resurrect deliberately rewound data in Alpha.

Regression cases: UI read failure; API read failure after UI succeeds; eviction during each read; finalized versus
partial reasoning; two messages with equal timestamps; explicit rewind; recovery from v2 when legacy API history is
empty. Assert byte preservation and no metadata rewrite before successful hydration.

### B. Long transcripts eventually mount every row in Alpha

Zoo [#153](https://github.com/Zoo-Code-Org/Zoo-Code/commit/ed868c675a9620aa9bfa5f57fa842ce1d8f7bd5a)
reduced its virtualized viewport buffers, supplied an estimated row height and item keys, and removed repeated large
history payloads. Zoo's current ChatView still uses React Virtuoso.

Alpha intentionally uses native scrolling with
[`useProgressiveTranscript`](../webview-ui/src/components/chat/hooks/useProgressiveTranscript.ts). It first mounts
80 rows, then prepends batches of 100 in idle callbacks until the entire transcript is mounted. Its existing scroll
tests explicitly exercise progressive growth. This limits initial work, not steady-state DOM size. Continued streaming
and expanding Markdown/code rows can therefore operate on an increasingly large mounted transcript.

**Priority P1: measure and bound steady-state rendering.** Compare 100, 1,000 and 5,000 mixed text, code, reasoning and
tool rows with new streaming updates. Record mounted row count after idle settles, input responsiveness, render/long-task
time and heap. Compare against a bounded-window candidate. Preserve exact bottom following, checkpoint jumps, expanded
rows, selection and keyboard access. Alpha chose native geometry/browser find deliberately; replacing it with Zoo's
component without addressing those contracts would regress UX. Consider bounded virtualization or explicit older-page
loading with transcript search. This is a concrete scaling concern, not a measured OOM reproduction yet.

### C. Audit higher-level presentation failures separately from persistence

Zoo [#1078](https://github.com/Zoo-Code-Org/Zoo-Code/commit/8cac2ac9705984df037caae347ed09aea669e2de)
separates failures scheduling/flushing a webview update from persistence and abort cleanup. Its Task tests cover rejected
state updates and pending flush failures. Unanswered asks and partial-message initialization still receive an immediate
publication barrier.

Alpha's `addToClineMessages` awaits `publishClineMessageCreated` before `saveClineMessages`. If that higher-level helper
rejects, the sequence never reaches the save. However, Alpha's actual `postMessageToWebview` already catches ordinary
webview delivery errors and returns when disposed. The missing local catch is therefore not proof that closing the
webview breaks persistence. Target state-construction or message-listener failures above that adapter, and alternate
host behavior, when reproducing this difference. It is not evidence of the live compaction failure.

**Priority P1 audit: make persistence independent of higher-level presentation failure.** Test a rejected state-build
or publication callback and require the UI transcript to remain durable. Preserve actionable failure reporting and the ordering required to expose unanswered
asks. Avoid a broad catch around task execution; isolate the presentation failure and keep canonical provider/tool
transactions authoritative. Test abort cleanup when the webview disappears as well.

### D. Some Alpha updates compute the history they later discard

The same Zoo [#1078](https://github.com/Zoo-Code-Org/Zoo-Code/commit/8cac2ac9705984df037caae347ed09aea669e2de)
adds `includeTaskHistory` to state construction so omitted history is never collected/sorted in the first place. It also
coalesces ordinary full-state updates with leading/trailing behavior and explicit flushes at interaction boundaries.

Alpha already improves the common message path with sequenced `messageCreated`/`messageUpdated` deltas and a smaller
task-state payload. Keep those. However, `postStateToWebviewWithoutTaskHistory` and
`postStateToWebviewWithoutClineMessages` still call full `getStateToPostToWebview` and discard fields afterward. That
builder calls `getState`, which obtains task history, and later obtains/filters it again.

**Priority P1: port construction-time omission.** Extend the existing builder options and prove omitted-history calls
do not call the history collector. Preserve full refreshes and sequence numbers. Measure remaining full refreshes
before adding a debounce; Alpha's message deltas should not acquire an unnecessary 500 ms delay. This saves local work,
not model requests by itself.

### E. Task-switch cost state is unbounded in Alpha's current ChatView

Zoo #1078 clears aggregated task costs on task switch and accepts a delayed result only for the current task. Alpha's
ChatView retains a Map, clones it and adds every received task ID; no reset or size cap appears in that component.
This is a smaller accumulation/stale-result concern across task switches, distinct from growth within one transcript.

**Priority P2: adapt bounded, task-aware retention.** Keep only relevant visible-task data or a deliberately bounded
cache. Account for Alpha's concurrent/background tasks rather than adopting Zoo's single-active-task assumption.
Test task A/B switching with a late A response and repeated task visits. Do not present this small map as the proven
cause of a large long-thread freeze.

### F. Zoo scopes tool parsing to a request, not just a task

Zoo [#1470](https://github.com/Zoo-Code-Org/Zoo-Code/commit/9d43817fdf30a33f93f8a5a2fd5d1fce5c934c9e)
replaced shared parser storage with WeakMaps keyed by an opaque request scope and removed provider-side use of a
shared finish-reason parser. Its regressions interleave stream fragments and exercise interrupted subtask recovery.

Alpha passes a task ID into its legacy preview parser, which protects different tasks but reuses the key across
requests in one task. OpenRouter, LM Studio and Qwen still call the default `processFinishReason` path. However, Alpha
executes calls from its per-response canonical accumulator; the legacy parser is used for incremental UI compatibility.
Alpha also has preview epochs. Those differences materially limit what can be inferred from Zoo's original bug.

**Priority P1 investigation: replay overlapping request lifetimes.** Start an unfinished preview, cancel/retry in the
same task, then deliver a late old fragment with a reused tool index/ID. Assert preview isolation, one canonical result,
and cleanup. If it fails, adapt request-owned parser state through the current step boundary. Do not create a second
execution parser or claim this explains the Copilot text-summary failure without evidence.

### G. Zoo's completion-persistence fix is substantially covered by Alpha

Zoo [#1452](https://github.com/Zoo-Code-Org/Zoo-Code/commit/2ecbf35a81628599e1f84ed22126f8be8744577b)
requires the assistant turn to be durably saved before public completion. It adds a generation-local persistence
promise, cancellable bounded retries and delegated-completion ordering. The restart E2E test checks the actual restored
completion turn, not only a nonempty history.

Alpha's `persistAssistantResponseBeforeEffects` already persists/retries the canonical assistant response before tool
execution, including `attempt_completion`; failed persistence stops effects. `finalizeTaskCompletion` and retained
follow-up admission have additional durability boundaries. Importing Zoo's extra promise into that path is not justified
merely because the field names differ. A compatibility flush path still polls a boolean, which is a targeted audit item.

**Adapt the tests:** fresh-host reopen at the public completion event; failed assistant persistence; cancellation during
retry delay and an in-flight write; immediate follow-up; terminal child disposal. The essential assertion is that the
specific completed turn and its tool receipt survive, not that history length is greater than zero.

Zoo also added a bounded transition model in `scripts/check-completion-persistence.ts` (depth 10, at most 1,000 states),
covering acceptance, write success/failure, retry, cancellation and parent reopening. This is a useful complement to
Alpha's deterministic implementation tests. A passing abstract model is not proof of the TypeScript implementation;
trace each modeled invariant to an actual test and persistence owner.

### H. Tool-row grouping can improve perceived verbosity without saving requests

Zoo [#1005](https://github.com/Zoo-Code-Org/Zoo-Code/commit/64d6e378f9f24fe0434ba89aba085ed98dd9948e)
groups nearby compatible tool asks across low-information metadata rows, with boundaries at user input, visible text,
errors, completion and other meaningful events. Alpha's ChatView still uses strictly consecutive grouping.

**Priority P2: adapt presentation grouping.** This could make several related reads/edits easier to scan while preserving
individual calls, approval scope, failures and request totals. Do not label it an API-call optimization or conceal
retries. Verify grouping never crosses task, turn, control-flow or approval boundaries.

### I. Approval visibility and input budgets are partially/already addressed

Zoo [#1448](https://github.com/Zoo-Code-Org/Zoo-Code/commit/dfed27dcd8293773b6d8d2da5bb47b898e782179)
keeps approval controls visible while scrolling. Alpha already puts action controls in a dock outside the transcript
scroller and separates floating scroll controls. Retain that implementation and borrow the regression case.

Zoo [#710](https://github.com/Zoo-Code-Org/Zoo-Code/commit/9a2e8d86649b61a7d9d1aaae037d8c6fd18d47de)
aligns Copilot's condensation threshold and UI context budget with usable input capacity. Alpha already caps its
configured/static window against the native limit. The remaining work is consistent, observable manual/automatic
budget resolution, as described in the first review. Merely lowering the limit does not explain a rejected nonempty
summary in Alpha's live test.

## Revised implementation order

1. Identify the observed compaction rejection branch with bounded diagnostics and a focused failing regression. Use
   the summary-only versus summary-plus-tail comparison above to test the relevant policy difference, preserving
   Alpha's acceptance and integrity requirements. Fix the demonstrated cause before further performance tuning.
2. Reproduce and fix resume hydration/read-failure handling at the existing persistence boundary. Extend compaction,
   cancellation, rewind and completion tests with the recovery interleavings above; then run bounded live recovery.
3. Reproduce higher-level presentation failure and preserve message durability/abort cleanup through it; ordinary
   webview delivery failures are already caught by Alpha's adapter.
4. Add a long-transcript rendering benchmark and choose a bounded rendering approach that preserves Alpha's scroll and
   search contracts. Port construction-time state omission; bound task-switch cost data.
5. Replay same-task cancelled/retried parser generations and adapt Zoo's request scoping only where Alpha's current
   accumulator/preview isolation leaves a demonstrated gap.
6. Add nearby tool grouping as a UX improvement.

These are bounded adaptations, not a Zoo codebase merge. Preserve the provider-neutral kernel, v2 transcripts, concurrent
task routing, policy enforcement, and exact VS Code 1.122.1 compatibility. Do not alter `apps/cli` or
`packages/vscode-shim`.

For every implementation: establish the focused failing regression, make the owning change, run touched-package tests,
lint/typecheck and the required exact-host gate. Use live Copilot after deterministic checks to exercise actual
compaction and recovery. Separate model request count, tokenizer calls, local serialization work, rendered rows and
wall time; none is a substitute for the others.

## Validation and limits

This turn inspected pinned commit patches, current Zoo implementations/tests and the corresponding Alpha paths. Only
review documentation changed. No production fix, measured speedup, reproduced OOM or passing runtime test is claimed.
No new live Copilot model requests were made. The existing automatic/manual compaction failure remains open.
