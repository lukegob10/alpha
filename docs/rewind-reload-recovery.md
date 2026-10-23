# Conversation history and recovery

Task identity, canonical lifecycle, and transcript writers remain extension-owned. Intentional history removal must be
durable before crash repair decides which missing tool transactions to restore.

## Fresh chats, forks, and resume

A new chat receives its supplied prompt and applicable configuration/instructions with empty conversation history.
A fork creates a new identity with the chosen source-history boundary and starts idle until followed up. Resume restores
the existing saved conversation; compaction stays within that identity. Checkout/worktree choice is independent of history
inheritance.

Model-facing fresh creation and history forks require the corresponding explicit human request. A request for a new chat
does not authorize transcript copying. Saved declarations or Full Access cannot supply missing fork intent.
Fresh handoffs carry a concise objective, ticket/source references, decisions, and constraints rather than the old
transcript or compaction summary. Managed-child history inheritance retains its separate captured contract.

## Durable rewind

`Task.commitConversationRewind` writes `task_rewind.json` atomically before either transcript changes. The receipt contains
pending UI/provider projections and removed canonical call IDs scoped to lifecycle run and turn. Accepted calls still get
terminal lifecycle receipts; exclusions suppress only deliberate provider-history restoration.

Both projection writers must acknowledge success before pending projections are removed. Failure leaves the receipt
available and fails the caller rather than claiming rewind completed. Resume finishes pending projections before reading
history or repairing canonical transactions. Recovery after success is a no-op.

Completed receipts retain cumulative exclusions. Later rewinds cannot forget earlier removal from the same lifecycle;
a successor turn reusing a call ID cannot inherit an older exclusion. Retained calls remain eligible for missing-result
repair. When rewind deliberately removes a stored result but retains its call, a host-authored error receipt preserves
pairing without restoring deleted content. A result missing before rewind remains eligible for crash repair.

Old tasks without receipts retain their previous reader behavior. Historical UI fields and retired variants remain
readable. Malformed receipts fail closed without replacing their bytes. Receipt-based recovery cannot retroactively
identify deletions made before the format existed.

## Cancellation and ownership

Callers join task cancellation before replacing history or restoring files; an abort flag is not a termination receipt.
Checkpoint restoration and prompt restart use `awaitTaskCancellationBoundary`. The task serializes rewind/recovery for
foreground and background instances. Artifact cleanup runs only after both transcript receipts commit, with existing
idle/current-reference checks. A stale task instance cannot adopt another instance's rewind result.

## Validation

```sh
pnpm --dir src test core/message-manager/index.spec.ts core/message-manager/index.artifacts.spec.ts core/task-persistence/__tests__/TaskRewindStore.spec.ts core/task/__tests__/Task.rewind-recovery.spec.ts
pnpm --dir src test core/task/__tests__/Task.persistence.spec.ts core/task-persistence/__tests__/ThreadHistory.spec.ts core/task/__tests__/Task.post-eof-cancellation.spec.ts
pnpm --dir src check-types
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

Cases cover rejected writer receipts, crashes between projections, repeated recovery, removed/retained calls, successor
call-ID reuse, cumulative exclusions, stale completion, and fresh/fork authorization. Use deterministic failures and
temporary files rather than timed process termination. Host-adapter changes also require minimum-host compatibility.
