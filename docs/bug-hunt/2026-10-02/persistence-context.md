# Persistence and context lane

Status: **READY** — locally verified; all lane edits frozen for coordinator integration.

Mode: full-surface review. This pass improves proven persistence/context defects; it does not certify the entire repository.
All pre-existing uncommitted changes are preserved. Final builds, certification, packaging, live providers, and exact
VS Code 1.125.0 gates belong to the coordinator. No other lane's production files are edited here.

## Ownership and coverage

| Surface                                                                                       | Owner                | Coverage                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| Transcript/history/inbox and atomic storage                                                   | transcripts subagent | reviewed; history refresh/disposal edited; malformed UI reader flagged                              |
| Context management, condense, tokens, folded files                                            | compaction subagent  | reviewed; compaction integrity/error output/folded preparation edited                               |
| Tickets excluding TicketPanel, skills, commands, configuration, mentions, custom instructions | preparation subagent | reviewed; catalog/YAML/recovery/command precedence edited; portable moves/cancellation gaps flagged |
| Remaining prompt fragments, mode/approval/role projection                                     | lane parent          | reviewed; captured-mode catalog edited                                                              |

## Confirmed findings

Ten bounded findings fixed (six High/must-fix, four Medium/should-fix):

| Severity | Finding                                                     | Closure   |
| -------- | ----------------------------------------------------------- | --------- |
| High     | Readable ticket destroyed by oversized recovery             | fixed now |
| High     | Raw provider payloads exposed in compaction diagnostics     | fixed now |
| High     | Delayed metadata refresh overwrites completed save          | fixed now |
| High     | Duplicate/reversed tool transactions accepted by compaction | fixed now |
| High     | Incomplete/stale/disposed skill catalogs published          | fixed now |
| High     | User descriptions corrupt or inject skill YAML              | fixed now |
| Medium   | Watcher debounce runs after disposal                        | fixed now |
| Medium   | Folded bounds/cancellation violated                         | fixed now |
| Medium   | Command listing disagrees with invocation                   | fixed now |
| Medium   | Mode catalog mixes captured and live guidance               | fixed now |

### High, must-fix: skill catalog publication races

Closure: fixed now. Three controlled-promise regressions showed readers losing the entire catalog during refresh,
an older scan overwriting newer discovery, and a disposed manager being repopulated. Discovery now uses a private map
and publishes only the newest complete generation while the manager remains live. No persistent cache was added.

### High, must-fix: generated skill YAML changes valid user text into metadata

Closure: fixed now. Three fail-before cases cover `Build: lint and test` breaking YAML, `#` deleting description text,
and multiline descriptions injecting metadata. Existing `matter.stringify` now serializes descriptions and mode data.

### High, must-fix: oversized ticket recovery destroys the readable source

Closure: fixed now. Journal text could exceed the 100 KB store limit while still passing parsed-ticket validation
(unknown sections ignored), then recovery wrote an unreadable target and removed the valid source. A real filesystem
UTF-8 canary reproduced successful destructive recovery before the fix. Recovery now checks bytes before mutation;
the regression verifies the source and journal remain intact and no target is created. Baseline ticket batching and
cancellation changes are preserved.

### Medium, should-fix: listed global command overrides disagree with invocation

Closure: fixed now. Discovery showed built-in `/init` despite direct invocation selecting the global override. One
fail-before test demonstrated divergent content/source. Discovery now applies the documented global-over-built-in
precedence. The parent corrected only the new mock's `fs.readdir` overload typing after subagent freeze and reran it.

Preparation validation: 296 passed / 1 existing skip across 20 services/mentions files; 92 passed / 2 existing skips
across 8 custom-instruction/skill/ticket prompt files; 73 touched tests passed across 3 files after formatting.
All six touched files passed focused ESLint and diff inspection. The one command regression passed again after the
test-only overload correction. Pinned upstream inspected: `skills/src/parser.rs`, `loading_tests.rs`, `invocation_tests.rs`,
`ext/skills/src/loader/metadata.rs`, `host_tests.rs`, and `codex-home/src/instructions/tests.rs`. Alpha keeps parsed YAML,
snapshot catalogs, native source/mode handling, project migration, mentions, bundled protections, and ticket security.
Ticket storage has no direct Codex equivalent; command precedence is Alpha's existing explicit service contract.

### High, must-fix: history refresh can overwrite a newer completed save

Closure: fixed now. `TaskHistoryStore.invalidate` bypassed its mutation lock. A blocked read of active metadata could
publish after completion saved `completed` and `tokensIn:42`, reverting the cache to `active` and `tokensIn:0`.
Both strict effect-fence and tolerant refresh reproduced. The existing `withLock` now owns the read and publication
together; no persistence schema or lock framework was introduced. A third regression proved filesystem-watch debounce
reconciled after disposal (Medium, should-fix). The timer is now instance-owned, cleared on dispose, and checks disposal.

Fail-before `pnpm --dir src test core/task-persistence/__tests__/TaskHistoryStore.lifecycle.spec.ts`: 3 expected failures.
After: lifecycle/history/cross-instance suites 39 passed. Entire persistence folder: 24 files, 177 passed / 1 skipped.
Final capped lifecycle run: 3 passed. Focused ESLint with zero warnings and Prettier check passed.

Reviewed authoritative API history, v1/v2 receipt/conflict handling, atomic replacement, agent inbox, human queue
receipts, metadata/index mutations, task/UI readers, canonical assistant history, frozen child instructions, completion,
and handoff persistence. Existing joined writes, provider metadata, recovery, inbox retry, and queue ACK rules retained.

Pinned upstream evidence: `codex-rs/rollout/src/recorder.rs`, `writer_lock_tests.rs`,
`core/src/context_manager/history_tests.rs`, and `core/src/session/rollout_reconstruction_tests.rs` (queued input order).

### High, must-fix: compaction integrity accepts duplicates and reverse tool transactions

Closure: fixed now. The old presence-only map accepted result-before-call and duplicate call/result IDs, including
duplicates within one message. Three regressions failed before the fix. The pure gate now requires each unique call
exactly once followed by its single result; invalid history remains unchanged and summarization is refused.

### High, must-fix: summarizer diagnostics copy raw error payloads

Closure: fixed now. Thrown provider errors copied `response`/`body` objects into logs and returned diagnostics, including
credential and prompt canaries in the regression. The repair retains bounded message text, integer HTTP status, and a
validated scalar error code, and omits explicit raw payload copying. One fail-before regression failed as intended.
Provider message text itself remains provider supplied; a complete arbitrary-string secret scrub is not claimed.

### Medium, should-fix: folded context overruns its bound and continues reads after Stop

Closure: fixed now. Fixed wrapper estimates and omitted separators produced 528 characters for a 350 limit, and 233
for a 231 limit. A cancelled blocked parser continued to the next file (two reads). Three fail-before regressions proved
those failures. Exact wrapper/separator accounting now bounds the optional folded output; caller cancellation stops
subsequent reads. The active tree-sitter parse cannot itself be interrupted. Mandatory context was not truncated.

Condense fail-before commands:
`pnpm --dir src test core/condense/__tests__/foldedFileContext.spec.ts core/condense/__tests__/index.spec.ts -t 'charges|stops later|thrown provider'`
(4 expected failures), and `pnpm --dir src test core/condense/__tests__/recent-tail.spec.ts -t 'malformed complete-looking'`
(3 expected failures). Final `pnpm --dir src test core/condense/__tests__ core/context-management/__tests__ --maxWorkers=2`:
293 tests across 13 files passed. Five touched files passed ESLint and formatting. Original CRLF preserved in
`foldedFileContext.ts`; command-local `core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol` diff check passed.

Reviewed context policies/fallback, effective history/rewind, complete-step tails, opaque provider state accounting,
mandatory budgets, tokenizer deadlines/cache, stream completion, cancellation, and folded preparation. Pinned upstream
`compact.rs` and `compact_tests.rs` verified initial-context/user-history rebuilding, complete summary streams, and
metadata retention. Alpha retains non-destructive archives, provider-neutral compaction, and exact recent tails.

### Medium, should-fix: mode catalog rereads live settings during captured prompt preparation

Closure: fixed now; integration validation pending.

`Task.getSystemPrompt` supplies captured `customModePrompts` to `SYSTEM_PROMPT_FRAGMENTS`, but the modes catalog read
`context.globalState` after asynchronous preparation. A settings change can therefore combine captured custom guidance
with newer catalog guidance in the same request. The catalog now accepts the captured prompts; system prompt generation
passes the same input, including an explicit empty snapshot. Standalone catalog callers retain the previous fallback.
No authority, persisted format, prompt text, or executable mode policy changes.

Fail-before: `pnpm --dir src test core/prompts/sections/__tests__/modes.spec.ts` failed 1 of 2 tests: requested
`CAPTURED_MODE_GUIDANCE` but returned `LIVE_MODE_GUIDANCE`. Added a parent prompt test for forwarding the snapshot.

Upstream inspected at `cb6da58876afed3ede0ab11084f67dd5394ecb48`:
`codex-rs/core/src/session/step_context.rs` captures one immutable settings version before request preparation;
`context/world_state/collaboration_mode.rs` and its tests retain developer-mode instruction transitions independently.
Alpha keeps its native prompt-fragment projection and own Code/Plan controls.

## Handoffs and missing host coverage

- High, should-fix / flagged for follow-up: approved large handoff tails remain inaccessible in the attached evidence.
  `getDesignHandoffPrompt` consistently truncates after 24,000 characters (Task can further reduce this to 4,096), even
  after reload. Its `task:<id>:design-handoff` provenance path is synthetic; no inspected tool reads that source. The full
  plan remains stored, so this is missing implementation evidence rather than deletion of user data. Added a deterministic
  characterization to `sections/__tests__/design-handoff.spec.ts`: a final requirement after 3,000 lines is absent from
  both first/reloaded attachments; all three tests pass. Existing `.investigation.ts` observations are outside normal
  Vitest collection. Coordinator/core integration should attach the full approved plan through mandatory-context
  accounting and explicitly exhaust if it cannot fit, or provide an authorized complete retrieval path. This crosses
  Task preparation and compaction ownership, so the current bounded-prompt contract was not changed speculatively here.
- Prompt previews accept unsupported modes and `SYSTEM_PROMPT_FRAGMENTS` can still render a retired custom mode or
  default unknown modes to Code, while native tool filtering uses `restoreTaskMode` (Plan for unsupported values).
  Current Task restoration already normalizes modes; no proven authority bypass is claimed. Coordinator should consider
  a shared prompt/preview regression for stale UI requests and deliberate compatibility handling rather than changing
  legacy prompt tests speculatively.
- Real-host cases to add/run: change settings during blocked prompt preparation and confirm the dispatched request keeps
  its captured mode guidance, plus the replay/reload and Stop cases below.
- Strict UI history validates only the outer array; `[null]` can reach consumers. Flagged for compatibility-aware
  validation of historical and unknown message variants. Same-task cross-instance metadata merge/global-state migration
  admission remain not verified beyond existing coverage. Missing/invalid tool IDs need corruption/reload characterization.
- Proposed host cases: delayed history refresh overlapping completion save; provider disposal during pending filesystem
  debounce; Stop during folded preparation; malformed restored transaction refusal without history loss; compaction
  overflow retaining all mandatory input.
- Portable skill moves: `moveSkill` reconstructs `.alpha` source paths although creation now uses `.agents`; physical
  moves also retain explicit frontmatter restrictions. Flagged for a focused creation-to-move contract regression before
  changing migration behavior. Existing tests exercise `.alpha` moves. Cancellation during stalled extraction, Git
  mention preparation, and skill reads remains not verified: current mention checks mainly fence final publication.
- Proposed preparation hosts: watcher refresh overlap with a sampling request; disposal during skill load;
  punctuation-rich skill creation through UI; global `/init` list/invocation agreement; oversized recovery preserving
  the editor's readable source.

## Validation

Focused prompt regression command covering system, modes, approvals, ignore responses, tool use, and system information:
95 tests across 6 files passed. Design-handoff characterization: 3 tests passed with `--maxWorkers=2`.
Parent's five edited TypeScript files passed focused ESLint; four fix files passed Prettier and `git diff --check`.
Final parent prompt run: `pnpm --dir src test core/prompts/__tests__/system-prompt.spec.ts core/prompts/sections/__tests__/modes.spec.ts core/prompts/sections/__tests__/design-handoff.spec.ts --maxWorkers=2`
passed 54 tests across 3 files. Combined focused ESLint on all 18 changed TypeScript files passed. These reruns overlap
earlier commands; counts are command receipts, not summed unique tests. Final `pnpm --dir src check-types` passed after
the new command fixture correction and concurrent core fixture fixes. Final owned diff check passed with command-local
CRLF whitespace treatment. No unrelated changes, dependency churn, generated files, or other-lane edits were introduced.
No new performance claim or live measurement is made.

The skill inventory helper ran read-only. Its counts include downloaded `.vscode-test` editor files; those outputs were
excluded from audit scope. The coordinator's filtered inventory in README remains the authoritative coverage map.

Initial `pnpm --dir src check-types` failed during concurrent lane edits: core-owned `AgentResponseFoundation.spec.ts`
(406,419), `AgentTurnEngine.spec.ts` (86), and `Task.spec.ts` (4820) lack required outcome fields. The new command fixture
also needed a typed mock correction. Parent corrected only that owned command test; core fixture repairs stayed with
their owner. The intermediate failures are resolved by the final successful typecheck receipt.

## Remaining closure priorities

1. Coordinator integration: full approved handoff evidence through mandatory-context budgeting or complete retrieval.
2. Compatibility-aware malformed UI/history validation and same-task cross-instance migration/merge audit.
3. Portable skill creation-to-move semantics and cancellation during stalled read-only preparation.

Rerun a focused contract-alignment/operational-hardening pass on these paths after integration. Final exact-host,
managed-agent, full-repository, and package gates remain coordinator-owned and are not claimed by this lane.
