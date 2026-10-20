# Pending Worker review and human steering

Investigated on 2026-10-19 against Codex CLI commit
[`8196bcdc189ad2c189d631b321fa54b8e09b9bb0`](https://github.com/openai/codex/tree/8196bcdc189ad2c189d631b321fa54b8e09b9bb0).
The reference input queue subscribes before checking pending activity and fences mailbox delivery by the active turn and
cancellation. Its multi-agent wait yields to steering. Alpha retains its own explicit Worker Apply/Discard and security
boundaries; Codex sandbox behavior is outside this change.

## Confirmed failure

**P1:** A genuine `pending_review` or `conflicted` Worker proposal paused the parent's next provider request on a raw
promise. Human steering cancelled ordinary request/wait signals but could not release that review promise. Accepted
guidance therefore remained stuck until Apply, Discard, or Stop.

The first repair reproduced a related boundary: allowing only the first human-guided model step still paused its tool
result before the following model response. A separate native assertion established that the durable verification ledger
intentionally treats unapplied `required` evidence as advisory. Once human-guided work can continue, the Task completion
boundary must explicitly retain the unresolved review pause.

## Owning change

`Task.ts` reuses its existing agent-wait lease and request interruption catch to resume the existing turn loop. Fresh human
input grants continuation only for the captured canonical run and turn. Tool policy and approval remain unchanged;
an admitted Apply/Discard lease must drain before another provider request. The runtime grant clears on terminality,
Stop, and new/recovered turn admission and is never persisted.

The shared completion decision returns internal `review_pending` while a proposal or its admitted mutation remains
unsettled, including a review arriving during the durable decision read. Ordinary assistant completion, legacy
`attempt_completion`, and Goal completion use the same interruptible review wait. Further guidance can interrupt that
pause; it does not approve, apply, or complete a proposal. Lifetime cancellation also prevents wait readmission without
requiring the separate abort flag. No journal, wire, or persisted schema changed.

## Deterministic evidence

- Original barrier regression: four intended failures, two passing adjacent cases before repair.
- Finished native regression, with the whole-turn grant temporarily disabled: failed at the tool-result-to-next-request
  boundary. Restoring the grant passed.
- Final focused suites: **15 tests passed in two files**, covering real Task/provider/store/transcript execution through
  human guidance, a successful read-only `list_agents` call, model reply, further guidance, and Stop or normal completion
  after review resolution. Queue acknowledgement and completion occur once; wait and turn ownership are released.
- Adjacent completion/Goal/hooks/legacy-tool coverage: **144 tests passed in eight files** before the final additional
  native normal-completion variant. Adjacent steering/authorization/public hook-owner coverage: **147 tests passed in six
  files** at the same checkpoint. These overlapping runs are not additive totals.
- Targeted extension-package ESLint, touched-file Prettier, and tracked-file `git diff --check` passed.

The native fixture owns a saved proposal projection and resolves its metadata under the existing discard lease; it does
not claim to exercise a real worktree Apply/Discard operation. Root-level full-suite, managed-agent certification,
typechecking, and exact VS Code 1.138.0 validation run separately against the frozen combined source. No live-model or
exact-host result is claimed by this investigation.
