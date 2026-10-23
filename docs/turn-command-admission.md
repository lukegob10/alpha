# Turn-scoped Stop and steering admission

Direct steering and Stop target the observed active turn. A delayed operation cannot start or interrupt a successor.
Alpha enforces this in its existing TypeScript host and durable task queue.

The composer attaches its observed canonical `expectedTurnId` to Stop and direct steering.
The host rejects a mismatched turn before resolving attachments and checks again afterward.
The task checks direct steering at entry, after queue readiness, inside the serialized receipt mutation,
and after persisting its delivery claim. Stop checks the captured task before native cancellation begins.
A delayed request must never interrupt a successor turn.

`expectedTurnId` remains optional for historical callers. A tokenless direct-steering request captures the
current canonical turn at host dispatch, protecting attachment-resolution delays. A historical caller that
was already stale before dispatch cannot be distinguished without a token. Direct task/provider callers
that omit the token retain their existing admission behavior.

Once input has been durably admitted, a later failed handoff retains it in the existing FIFO and reports
accepted queued delivery. Input rejected before admission stays in the composer. Ordinary queue-for-next-turn
intent and explicit queued-message steering retain their existing semantics; they do not inherit the direct
composer request's stale-turn restriction. Eager goal invalidation happens when accepted input is applied,
so rejected requests cannot invalidate a successor's continuation.

Non-checkpoint transcript deletion joins cancellation and persistence before locating the rewind target.
It verifies that the same task instance still owns the identity after joining. This prevents late writes from
the interrupted loop from racing a deliberate deletion; canonical rollback and reload recovery are owned by
the shared message-manager and lifecycle boundaries.

Deterministic coverage: `webviewMessageHandler.spec.ts` uses controlled attachment and termination promises;
`Task.queued-steering.spec.ts` covers hydration, serialized admission, and claim-persistence races;
`AlphaProvider.native-stop-ownership.spec.ts` checks stale Stop before native cancellation;
`ChatView.spec.tsx` checks the composer and Stop wire tokens. Shared schema tests retain tokenless compatibility.
