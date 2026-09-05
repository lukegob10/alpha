# Command mutation observations across repository transitions

NOR-32 corrects the observation contract investigated on September 5, 2026 against Alpha 2.1.23,
commit `530d737ec07ba6c4feac0f6745960de224496944`.

`VerificationScope.ts` observes working content for command mutation receipts. A repository initialization changes the
observation backend, but that alone does not establish a content mutation or an unknown scope. Git snapshots contain
selected Git-visible paths; non-Git snapshots contain the complete bounded working tree. These scopes are not interchangeable.

## Evidence and transition rules

- Every workspace snapshot carries its canonical root and directory identity. Capture and comparison reject a retargeted
  workspace alias, replacement directory, or different workspace even if the paths and bytes look identical.
- The command finalizer passes the baseline to final capture, retaining the complete bounded working-tree scope of a
  non-Git baseline even when repository metadata appears. The observation kind identifies this content scope. This
  observes initialization together with edits, additions, deletions, commits, or new ignore rules. Metadata-only
  initialization produces an empty content receipt. The existing `.git` and `node_modules` inventory exclusions remain.
  Callers that independently captured a Git final snapshot can also compare against a complete non-Git baseline: the
  comparison captures its own complete bounded inventory. Passing the baseline at final capture additionally freezes
  ignored-file evidence at that earlier boundary and detects subsequent changes to it.
- Git-to-Git observations retain the existing dirty-path fingerprints and HEAD tree comparison. Staging or committing
  already observed bytes does not invalidate their verification. New content committed during execution remains visible.
  A `.git` file, linked worktree, or relocated Git directory is supported when Git still identifies the same workspace root
  and the necessary commit objects remain available.
- Git-to-non-Git transitions remain explicitly unknown. A dirty-path baseline does not prove the old bytes or inventory of
  clean files after repository metadata disappears. A new final snapshot cannot repair that missing evidence.
- Changed final observations, unsupported or escaping paths, symlinks/special files, unavailable Git objects, and exceeded
  observation bounds remain errors. The receipt layer retains its existing actionable phase and unknown-scope handling.

The observations are bounded evidence at command boundaries, not attribution of every external write to a process. Final
state checks reject detected concurrent changes. Complete snapshots with identical working bytes produce no content mutation.
Git snapshots can conservatively require verification for HEAD changes whose clean baseline bytes were not captured.
Git observation retains its existing Git-visible scope; the transition fallback does not broaden every ordinary Git command
into an unbounded filesystem walk.

## Persistence and recovery

Workspace snapshots are ephemeral; no saved-task schema changes or migration are required. The same comparison is used by
foreground and background command completion. Existing receipt code records content mutations or releases the exact physical
execution reservation for a proven no-op, preserving cancellation and terminal-result ownership.

A successful initialization does not clear historical unknown-scope obligations. Saved tasks that already contain
`scopeUnresolved` debt retain it across reload and subsequent successful commands. Only the new command's reservation can be
settled by its receipt. No automatic repair is inferred from current files when the original before/after evidence is missing.

## Regression coverage

`src/core/agent/__tests__/VerificationScope.repository-transitions.spec.ts` uses real temporary Git repositories to test the
transition contract, bounds, workspace identity, concurrent edits, and preservation of historical unknown debt after reload.
Existing command-outcome, provider-ledger, primary-verification, and persistence suites cover receipt lifecycle integration.

```sh
pnpm --dir src test -- core/agent/__tests__/VerificationScope.spec.ts core/agent/__tests__/VerificationScope.repository-transitions.spec.ts
pnpm --dir src test -- core/task/__tests__/stageThreeCommandOutcome.integration.spec.ts core/agent/__tests__/AgentControlStore.primary-verification.spec.ts core/webview/__tests__/ClineProvider.primary-verification.spec.ts core/task-persistence/__tests__/stageThreeVerificationRecovery.integration.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```
