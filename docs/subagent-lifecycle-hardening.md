# Subagent lifecycle hardening

Reviewed against Codex CLI commit `8531184b49bcb160175a84e140b659a83a426df7`, retrieved October 22, 2026.
The earlier review used `f3a90545aed3188ee1e5c119ec89a742de399cdc`; all reported findings were rechecked against
the current Alpha working tree before implementation.

## Reference and scope

Codex's [tree shutdown](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/core/src/agent/control/runtime.rs)
closes admission and signals cancellation before draining work. Teardown membership remains owned after registry removal.
Its [spawn cleanup](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/core/src/agent/control/spawn_guard.rs)
retains provisional ownership until acceptance or complete cleanup. Its
[message-wake regressions](https://github.com/openai/codex/blob/8531184b49bcb160175a84e140b659a83a426df7/codex-rs/core/tests/suite/agent_message_wake.rs)
distinguish explicit follow-ups from passive messages and preserve finishing-turn ownership through persistence.

Alpha keeps its shared TypeScript kernel, existing tool scheduler, native Task cancellation receipts, provider ownership,
and durable control store. No parallel runtime, automatic root-message wake feature, or Codex sandbox implementation is
introduced. Alpha's stronger parent verification, recursive cancellation, workspace protections, and native tools remain
intentional extension contracts. Conversation-only forks continue excluding parent tool traffic and opaque reasoning state.

## Reverified changes

| Boundary                   | Correction                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider shutdown          | Signal owned Tasks before draining queued operations; join native cleanup and admitted child finalizations before closing persistence. |
| Direct child Stop          | Join the captured child cancellation boundary and preserve cancellation rather than prematurely publishing failure.                    |
| Partial batch admission    | Terminalize provisional child records on failure, release reservations after durable cleanup, and retain evidence when cleanup fails.  |
| Guidance during completion | Continue accepted agent/steering input through the existing turn loop when final persistence yields to that input.                     |
| Lifecycle tool effects     | Record durable intent before dispatch; conditional follow-up approval remains before the effect boundary, including late cancellation. |
| Captured command denials   | Evaluate explicit inherited denials before automatic-approval opt-outs.                                                                |
| Forked assistant context   | Read canonical text-block phases, retaining independent partial/final answers through reload and nested forks.                         |
| Scheduled-task shutdown    | Retain scheduler ownership through admitted task creation, full task-tree teardown, and terminal writes.                               |
| Unverified command cleanup | Retain failed process-tree cleanup as a shutdown obligation; ordinary command failures still settle normally.                          |
| Budget equality            | Treat reported usage equal to a child/tree ceiling as exhausted before another request starts.                                         |
| Grouped child attention    | Preserve canonical awaiting-input attention in grouped rows and count each child once.                                                 |
| Interrupted waits          | Project steering interruption through the existing cancelled presentation.                                                             |
| Completed-group recovery   | Recover a completed aggregate when every durable child row is already completed.                                                       |
| Certification discovery    | Include managed lifecycle suites in existing tracks and assert their discovery in a tooling regression.                                |

Regression tests use controlled promises and actual Task/provider/scheduler boundaries. Each new failure case was run
before its production fix. The implementation extends existing ownership and projection paths without changing public
or persisted schemas.

## Confirmed follow-up work

- **Legacy delegated-child handoff:** parent metadata and the visible result can commit before the matching provider-history
  result. Cold recovery can then substitute a generic interrupted result. Repair requires an idempotent, call-matched
  handoff receipt before generic transcript recovery; moving the existing writes alone is insufficient.
- **Compaction token spending:** summary inference preserves cost but discards input/output usage counters. Token budgets
  therefore exclude that spending, while current cost accounting, request pacing, cancellation, and timeouts still apply.
  A compatible repair must preserve normalized usage on existing success/error receipts, include failed and cancelled
  attempts exactly once, and distinguish cumulative spending from the smaller active context.

These two findings remain open. Stale degraded-state refreshes and cancellation during mailbox acquisition remain
unproven integration concerns, not confirmed defects from this pass.

## Validation

Focused extension/webview regressions and owning suites run with `--maxWorkers=2 --no-cache`. Required final gates are
extension and webview typechecks, exact VS Code 1.138.0 smoke, managed-agent automated certification, and minimum-host
compatibility where applicable. The final chat records actual results and any environmental limits; listing a gate here
does not claim it passed. Live-model capacity, quality, and speed are not established by deterministic fixture results.
