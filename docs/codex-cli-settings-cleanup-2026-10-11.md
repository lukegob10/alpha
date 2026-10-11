# Codex alignment and settings cleanup

Implementation started October 11, 2026 (America/New_York).

## Scope and references

The user authorized two implementation sets: the five source-mapped Codex CLI gaps and applicable findings from
“Settings Codex alignment and provider…”. Work is native TypeScript integrated into Alpha's existing VS Code extension
and shared harness. Codex sandbox architecture is excluded. Alpha's embeddings/codebase search, Tickets, scheduling,
skills, HTML preview and other built-in tools remain supported.

- Clean starting checkpoint: `14fc29614911d0d3b88670135a8a5c11abb75103`.
- Integration branch: `codex/cli-settings-cleanup-20261011`.
- Current upstream reference: `27065a91ccbf5ba8532844be3777fcf83b77820d`, committed October 11 at 17:43:08 UTC.
- Historical audit: [Codex comparison](codex-cli-divergence-audit-2026-10-11.md), pinned to `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`.
- Settings findings: [provider and alignment review](settings-review-2026-10-10-codex-alignment.md), originally pinned to `cc7ba33601286a751477832b01de7b6f8de0dd9c`.
- Settings source chat: `01a12900-e971-7300-b086-be3e8b696f6d`.

The historical reports describe evidence at their recorded snapshots. Each implementation must recheck current source
and tests, identify native ownership, and document intentional differences.

## Parallel ownership

Eight new chats each own a separate managed worktree based on the checkpoint. Each lead is instructed to use two or
three subagents, review their combined work, run focused checks and commit a reviewable result. Three additional
read-only reviewers in the coordinating chat independently check lifecycle, provider and tool-policy contracts.

| Set       | Work area            | Lead chat ID                           | Ownership                                                                        |
| --------- | -------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Alignment | MCP pagination       | `01a12c44-021b-7860-a1f2-db438e107396` | Complete bounded tool/resource/template discovery and cancellation               |
| Alignment | Command matching     | `01a12c44-109b-7c62-814d-30e261edb8c5` | Executable/argument tokens, deny precedence, persisted policy compatibility      |
| Alignment | Message phases       | `01a12c44-1919-71c3-a561-85112f3972f0` | Ordered response identity/phase, persistence, replay and legacy histories        |
| Alignment | Explicit-only skills | `01a12c44-22c2-7ca3-9932-28aa81ddf9ae` | Portable metadata, override precedence, explicit resolution and frozen snapshots |
| Alignment | Persistent goals     | `01a12c44-2b61-7323-892b-3004758f73c2` | Native state/accounting, safe idle continuation and user control                 |
| Settings  | Profile rename       | `01a12c44-3737-7fe0-a7f6-78869f6dd785` | F2: metadata-only rename and edit-buffer preservation                            |
| Settings  | Provider parameters  | `01a12c44-41e3-7de2-9986-d7d753bcceeb` | F3/F4/F7: output cap, temperature and verbosity applicability                    |
| Settings  | Agents and approvals | `01a12c44-4f44-7c31-aea7-3fb89931eed7` | F1/F5/F6, justified F8 cleanup, relevant scope terminology                       |

Shared files must be reconciled by ownership: message phase work changes response normalization/history, while provider
parameters change request construction. Profile rename changes metadata operations/edit-buffer refresh, while the
Agents group changes navigation and form wiring. The coordinator reviews merged contracts and runs integrated gates.

## Integration acceptance

- Preserve canonical turn sequencing, task/session IDs, ordered tool transactions and exactly-once terminal events.
- Keep user steering, pause, cancellation, explicit approval and disposal authoritative over automatic continuation.
- Preserve saved profiles, credentials, tasks, unknown legacy fields and older policy/history representations.
- Keep tool visibility, applicability, execution and captured policy consistent.
- Use realistic observable regression cases; avoid model-name guessing, fixture-specific behavior and weakened assertions.
- Use only exact VS Code 1.125.0 for host validation. Final host/live runs are serial and coordinator-owned.
- Do not change release versions, publish, push, remove unrelated worktrees or introduce a parallel runtime.

## Validation ledger

This is a live implementation coordination record, not a claim that the eight work packages are complete.

- Starting checkpoint: lint, type checks, exact-host smoke and automated managed-agent certification passed.
- Starting full unit run: four stale lookup assertions still classified restored `codebase_search` as retired.
- Coordinator corrected those expectations and added positive availability checks; the two focused files passed
  **34 tests**. This retains production tools and existing Plan write restrictions.
- Live Copilot availability was verified before implementation with a real read-only Alpha task on VS Code 1.125.0,
  actual `gpt-6-luna` / `max`, two task requests plus one readiness request.
- Work-package checks, independent reviews, integration commits and final gates will be recorded when they run.
