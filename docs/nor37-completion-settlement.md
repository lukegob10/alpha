# NOR-37 completion settlement

Reference: Alpha 2.1.23, `530d737ec07ba6c4feac0f6745960de224496944`, inspected September 5, 2026.

## Observed failure

The completion gate incremented its rejection counter every time it was read. Both ordinary assistant completion and
`attempt_completion` therefore charged internal revalidation against the model's repair allowance. Running commands and
pending mutation receipts were also returned as model-repairable failures. A retained candidate could become three model
requests followed by a Resume boundary while the original operation was still healthy.

The existing generic exploration detector could credit distinct successful reads without resolving a completion blocker.
Counting completion candidates alone did not bound an intervening stream of unrelated work.

These are reproduced mechanisms in the offline fixture, not an attribution of the user's production experience or a
claim about live-model speed.

## Owning behavior

`Task.getCompletionGateDecision()` no longer consumes retry allowance. It remains an asynchronous durable decision: the
provider may reconcile verification evidence and mailbox receipts. It is not a pure snapshot API.

`waitForCompletionGateDecision()` retains the candidate outside `WorkspaceMutationGate`. Running commands, their tracked
verification publishers, and active children use their operation-owned timeout/cancellation. A command lasting over
60 seconds does not create another model request or a Resume boundary. The existing wait lease carries cancellation and
steering; Task's existing request-control helper disposes its listeners and timers. A standalone mutation reservation
without a tracked publisher, or an unavailable durable read, yields an explicit unverified outcome after 30 seconds.
Neither outcome marks the task or command successful or discards its obligation.

Commands starting and finishing during a durable decision invalidate that observation. The final commit retains the
workspace mutation gate, lifecycle prepare/rollback, transcript barrier, queued-guidance check, and exactly-once terminal
transition. A transcript queue identity check also detects a save that both starts and finishes during the final gate.
There is no runtime wait inside that final mutation boundary.

`CompletionRecovery` is ephemeral accounting derived from durable debt. Each missing file/check has its own allowance,
keyed by the file's content receipt rather than aggregate change-set version. Three rejected completion candidates or
eight explicitly associated verification attempts that leave the same debt unresolved produce a useful unverified outcome. Unrelated edits and new
obligations cannot reset existing debt. New relevant content, accepted checks, and real user guidance reopen the necessary
work. Failed optional checks remain debt even when required checks have otherwise passed.

Investigation can discover callers and dependencies outside the initial receipt scope. It is neutral to completion's
repair counters and continues through the existing exploration/repetition handling. A successful check that satisfies
other covered debt is also neutral to untouched blockers. The tracker retains at most 128 debt entries, preserving already
tracked unresolved keys under cap pressure. Novel reads cannot reset a completion rejection allowance; there is no new
general read/tool cutoff or a tool-authorization boundary.

Verification diagnostics are bounded Task-memory observations. NOR-33 supplies command/configuration/scope/association
reason codes and actual pytest validation receipts. NOR-37 displays the remaining version/check/association issue and
distinguishes unavailable evidence from corrective actions. Reload preserves the existing durable obligations; historical
diagnostic strings are not a new persisted contract. Current receipt waits, child waits and pending child-result consumption
take precedence over earlier command diagnostics, preserving healthy operation settlement and the standalone receipt deadline.

## Validation and measurement

The existing Stage Three completion fixture keeps the real Task loop, scheduler, completion tool, durable store, and
workspace mutation gate. Controlled promises and fake timers cover command/evidence settlement, a publisher queued at
the mutation gate, steering callbacks, cancellation, late command admission, orphan receipts, more than eight necessary
reads outside the initial scope, unrelated concurrent edits, sequential validation of nine debts, storage-cap pressure,
and resumed user guidance. Long virtual waits include the real ownership heartbeat.

Two source-restoration checks run the new regressions against the exact reference implementation and restore the working
files in a `finally` block. The selected command/receipt tests reproduce three requests instead of one. Five internal gate
reads consume the entire rejection allowance before the first actual candidate is rejected. A supplemental investigation
fixture exposed the reference implementation's safety-guard exhaustion on distinct unrelated reads; the final fix keeps
investigation neutral and bounds explicitly associated unsuccessful checks rather than imposing a general read cutoff.

Focused commands:

```sh
pnpm --dir src test -- core/task/__tests__/stageThreeCompletion.integration.spec.ts --maxWorkers=1 --minWorkers=1
pnpm --dir src test -- core/agent/__tests__/CompletionRecovery.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts
pnpm --dir src test -- core/task/__tests__/completionDiagnostics.spec.ts
pnpm --dir src test -- core/task/__tests__/Task.spec.ts core/task/__tests__/Task.persistence.spec.ts core/agent/__tests__/AgentTurnEngine.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
```

`getCompletionStageMetrics()` exposes bounded redacted candidate, rejection, repair-tool and runtime-wait counters plus
first-candidate, persistence and completion/blocked timestamps, before/after usage snapshots and the last reason code. Gate-read spies distinguish internal observations
from actual repair feedback. NOR-36 can combine these observations with its explicit phase-tagged normalized usage and
tool events. Missing provider tokens or byte measurements must remain unavailable, never estimated as savings.

The comparative workload must fix provider scripting/cache state, use the same ready and delayed-evidence scenarios, and
measure only first candidate through durable completion: p50/p95 wall time, runtime wait separately, extra model turns,
repeated checks, request/result bytes, and observed token usage. A serialized measurement window is required before wall
time claims. The deterministic acceptance thresholds are one retained candidate, zero model recovery turns or duplicate
checks for healthy settlement, and exactly one durable completion. An incomplete baseline is not a successful-completion
latency sample. No comparative p50/p95 or live-token improvement is claimed here.

Combined NOR-32/NOR-33/NOR-34 acceptance and managed-agent certification must run after integration. The orchestrator owns
the sequential VS Code 1.122.1 gate in the integration worktree without spaces; parallel host launches and this worktree's
space-containing path caused shared runner failures before suite loading. This document does not substitute focused
coverage for that exact-host gate.
