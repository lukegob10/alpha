# Managed-agent lifecycle and workspace ownership

Managed agents run through the shared Task, turn engine, scheduler, cancellation receipts, and persistence store.
Independent chats retain separate lifecycle authority. A role, model choice, prompt, or message cannot widen authority.

## Settings and lifetime

`subagentsEnabled` controls new admission while retaining controls for existing agents. `maxConcurrentSubagents` is a
positive safe integer excluding the root, defaulting to three. Model/effort defaults and custom agent definitions select
within the captured provider; they cannot substitute credentials or another provider.

`wait_agent` defaults to 30 seconds, with a 10-second minimum and one-hour maximum. Timeout ends the wait, not the agent.
Explicit Stop/interruption, parent cancellation, provider failures, and individual tool deadlines retain their owners.

Generic per-child execution timers, fixed research windows, cumulative child/tree token/cost ceilings, and separate nesting
limits are retired. Old settings are removed idempotently or ignored on update/import. Historical manifests, digests,
usage, and stop reasons remain readable; reload does not reinstate retired limits. Goal budgets and ordinary provider/tool
limits remain separate.

## Authority and approvals

Host-verified `spawn_agent` requests capture the parent's effective tool catalog and permission snapshot at the immutable
step boundary and launch without a separate delegation approval. Commands, ordinary tools, protected writes, and MCP
actions still follow inherited action approval for every role. A finalized approved agent can receive follow-ups without
another delegation prompt; legacy records needing authorization migration retain their approval path.

The effective child grant intersects captured, invoking-step, ancestor, and live ceilings. Current settings may narrow a
frozen grant. Full Access skips ordinary review only where both live and captured policy permit it. Explicit command
denials, source-qualified MCP grants, disabled tools, Plan restrictions, `.alphaignore`, protected files, and workspace
scope remain enforced. MCP snapshots contain identity/grants, not server credentials.

`runtimePolicy.authorityModel: "parent"` and captured execution mode distinguish current inheritance from older manifests.
They participate in policy digests. Older manifests retain their narrower authority without rehashing or silent expansion.
Compatibility callers without an invoking catalog retain a conservative tool surface. Role wording is task guidance;
it is not an independent security boundary.

Ticket operations bind to the logical parent project, including from private Worker checkouts. Background commands use
their process-owning provider and cannot acquire foreground interactive terminals. Passive messages neither supply human
approval nor start recipient turns or grant ancestor/peer lifecycle control.

## Context and cancellation

Each child has its own persisted history and uses normal request/compaction boundaries. Native full-history inheritance
requires provider compatibility; legacy conversation projections exclude parent tool traffic and opaque reasoning state.
Forked partial/final assistant answers retain their phase through reload and nested forks. Child history never becomes a
shared mutable parent transcript.

Shutdown closes admission and signals owned tasks before draining work. Direct Stop joins the captured child cancellation
boundary. Provisional launches remain owned until acceptance or durable cleanup; failed cleanup retains its evidence and
shutdown obligation. Lifecycle effects persist intent before dispatch and publish one terminal result. Accepted guidance
during final persistence continues through the existing turn loop.

## Worker isolation and integration

`ManagedSubagentWorktreeService` owns private checkouts, captured changes, exact-file/write-scope checks, conflicts, and
Apply/Discard recovery. Absolute command directories inside an owned worktree are accepted; traversal and physical
symlink/junction escapes are rejected. Git commands use ordinary command approval and task authorization.

Successful completed Workers integrate already-approved in-scope effects before terminal publication, under the shared
workspace mutation gate and original-content checks. Current parent mode and reductions in captured approval authority
are rechecked. Conflicts, partial/cancelled work, reduced permissions, and older proposals retain recoverable Review/Apply.
Integration failure cannot be reported as an applied success.

Plain folders use an artifact-owned private Git database outside the source workspace; Git must be installed, but the
user folder need not be a repository and receives no Git metadata. Private snapshots preserve file bytes independently of
global line-ending conversion. Windows short storage under `~/.alpha/worker-git` retains validated ownership metadata.
Nested artifacts keep that database alive until dependent checkouts/proposals are released. Cleanup removes dependents
before their database, and unknown ownership records are preserved. Existing artifacts without optional private metadata
remain readable.

## Validation

```sh
pnpm --dir src test core/agent/__tests__/SubagentRuntimeLimits.spec.ts core/webview/__tests__/AlphaProvider.worker-integration.spec.ts
pnpm --filter @alpha-code/core test src/worktree/__tests__/managed-subagent-worktree.non-git.spec.ts
pnpm certify:managed-agents:automated
pnpm --filter @alpha-code/vscode-e2e test:smoke:1380
```

Apply minimum-host compatibility coverage to host-adapter changes. Use the
[certification guide](certification/managed-agent-milestone-certification.md) for the remaining tracks and evidence rules.
Scripted certification does not establish live-provider capacity, quality, or speed.
