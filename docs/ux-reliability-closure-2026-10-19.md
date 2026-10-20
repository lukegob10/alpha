# Codex convergence: reliability finding closure

Date: October 19, 2026, America/New_York. Mode: follow-up audit. The user authorized closing all findings from the
[twenty-finding investigation](ux-reliability-hunt-2026-10-19.md), with Codex CLI as the behavioral reference. Alpha's
existing security protections, skills, HTML previewer, Tickets, scheduled tasks, and other tools remain integrated with
the same harness. Codex's sandbox architecture is outside this change.

The current source reference is Codex commit `8196bcdc189ad2c189d631b321fa54b8e09b9bb0`; the
[source comparison](codex-convergence-reliability-2026-10-19.md) identifies exact upstream code and tests, permitted
fallback distinctions, and intentional native-adapter/privacy differences. It does not claim full product parity or
access to the private Codex IDE frontend.

## Findings closed in code

| Area                         | Confirmed gap and correction                                                                                                                                                                                                                                                                                                                                                                              | Owner and regression evidence                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid saved profiles       | Schema-invalid entries could disappear during unrelated saves. Retain their original value and stable identity in the same SecretStorage document, expose safe availability metadata, and prevent execution until explicit valid repair. Rename, deletion, export, import, and reopen preserve that contract.                                                                                             | `ProviderSettingsManager`, retained-profile and import/export fixtures.                                                                    |
| Profile identity and routing | Duplicate IDs, invalid reimports, and broad catch/fallback paths could route to another profile. Reject ambiguous ID/mode targets, preserve stable IDs through imports, remap dependent global references together, and propagate explicit unavailable errors through child and history routes. Healthy name-based selections and genuine documented legacy fallbacks remain supported.                   | Retention review fixtures, `SubagentModelRouter.profile-availability.spec.ts`, `AlphaProvider.unavailable-profile-admission.spec.ts`.      |
| Provider admission           | An unavailable selected profile or a failed ContextProxy projection could leave an older provider's settings executable. Validate saved availability before replacing existing work and derive new task/global-resume settings from the selected saved profile. Explicit API provider fields overlay that selection; captured task snapshots and legacy context-only/stub profiles retain their contract. | Public create/history admission tests establish failure before the fix, including actual Task constructor configuration.                   |
| Profile deletion             | The public API only removed projected metadata; the webview could activate a different profile when deleting an inactive one. Use one durable deletion path, revalidate captured identity, preserve unrelated selection, and obtain replacement settings in the same storage transaction. Project settings, identity, and metadata together before updating only the still-owned Task.                    | API/host deletion, delayed confirmation, held/rejected projection, and cached settings regressions.                                        |
| Fresh setup identity         | Separate managers could expose different IDs for the same never-saved default profile. Give only the fresh default a deterministic identity. Existing persisted identities and mode bindings are retained.                                                                                                                                                                                                | Two-manager default lookup, first-save, and reopen fixtures.                                                                               |
| Automatic import feedback    | A retained unavailable selection could still produce an unconditional import-success notification. Surface warning counts and repair guidance without resetting the configured import source. A configured file remains authoritative on each activation.                                                                                                                                                 | Automatic-import warning and activation fixtures.                                                                                          |
| Prompt improvement           | UI cancellation did not reach the owning request. Add an optional provider signal, bounded correlated host ownership, direct cancellation dispatch, and success/error/cancelled replies. Both composer and Settings preview cancel on explicit intent, edits, option/scope changes, and disposal; cancellation preserves the user's draft.                                                                | Both frontend callers, host request/Stop/disposal, helper races, and all production provider completion paths.                             |
| Late LM admission            | A response arriving after cancellation could escape iterator cleanup. Close the late response owned by that cancelled request in both chat and single-completion paths, retaining successor isolation and existing deadlines.                                                                                                                                                                             | Controlled late-admission regressions fail before the correction.                                                                          |
| Pending Worker review        | Genuine pending review could block accepted guidance. Use the existing wait/control lease and captured logical turn ownership so human guidance can continue through tool results and a reply. Final completion still waits for review; Apply/Discard, mutation leases, Goal accounting, and Stop retain their authority.                                                                                 | Deterministic barriers and actual Task/provider human-input, read-only tool/result, repeated steering, completion, and cancellation cases. |
| Fresh input after reload     | Native restoration preserved both chats and drafts, but a fresh human message took a queue-only path that never released the explicit-resume fence. Authorize resume only after fresh human input is durably admitted, retain FIFO order, and let the installed resume ask observe that authorization. Passive restore, receipt retries, approvals, and Stop retain their existing boundaries.            | Controlled Task/host queue regressions and the two-process native editor reload lane.                                                      |
| Input during handoff         | A child could commit its return while input awaited receipt lookup or its per-ID admission lane, leaving the request aimed at the stopped child. Resolve the observed committed destination again and preserve the original receipt across that route change, including after the temporary child alias is removed. Lifetime failures and persistence errors retain their own meaning.                    | Controlled legacy handoff barriers for receipt lookup, a held per-ID lane, and alias removal; existing queue/Stop tests.                   |
| Incident evidence            | A stuck chat without an error row lacked an accessible support export. Extend the existing local report and add `Alpha: Export Chat Diagnostics`. Include bounded lifecycle/receipt and cached setup evidence with backend identity; hash custom identifiers and paths.                                                                                                                                   | Schema/redaction/bounds, read-only getter, command/manifest, and existing evidence collector regressions.                                  |

These are bounded failure mechanisms and operational gaps, rather than a count of observed extension-host process
crashes. No generic reset watchdog, provider substitution on invalid input, automatic task replay, parallel execution
engine, or production dependency was added.

## Durable contracts

- Opaque invalid profile values stay in SecretStorage and existing user-requested export/import flows. Metadata and
  diagnostics must never receive those values. Retention is not permission to execute them. Profile-ID ambiguity must
  fail before mutation or provider dispatch; it must not be converted into a missing-profile fallback.
- Cancellation belongs to a specific enhancement request, panel, and optional Task. A stale Stop, old reply, or another
  composer must not cancel or overwrite a successor. Shared credential/certificate work may finish for another caller;
  the cancelled caller cannot continue to a model request. Existing provider timeouts remain independently owned.
- Worker review remains an Alpha feature governed by its existing policy and mutation gate. Human guidance cannot
  silently approve a proposal or complete a task with review still pending. Normal guidance can make multiple model
  steps using the existing execution loop.
- Passive panel restoration does not authorize queued execution. Fresh human queue admission can authorize the owning
  Task after persistence succeeds; retained drafts keep FIFO order. Replaying an existing receipt after Stop is not new
  human authorization, and approval/review barriers remain in force.
- Input admission follows an observed delegated handoff through asynchronous receipt checks and the queue's existing
  admission lane. A request captured for a child must retain its receipt when the committed parent takes ownership;
  Stop and persistence failures remain distinct from that route change.
- Diagnostics use the existing user-initiated local export. They do not acquire profile storage locks, consume queues,
  settle receipts, start a turn, send model requests, upload files, or add telemetry. Profile availability is explicitly
  identified as cached evidence. Prompts, credentials, file contents, provider history/payloads, and raw logs are excluded.
- A configured auto-import file remains an explicit configuration source. Repairing a locally retained profile does not
  secretly disable that source; a repeated invalid import must explain the warning so the source itself can be repaired.

## Validation and closure ledger

Focused red/green evidence is recorded by each owning test file and the aggregate result. Shared types, provider and
history behavior, webview edit buffers, managed lifecycle, exact-host compatibility, and package contents are affected.
The existing managed-agent matrix selects the new routing, review, profile, and cancellation regressions; its manual
integration rows are not relabeled as passing because a unit or ordinary host test succeeds.

The native editor reload lane is `apps/vscode-e2e/src/runEditorChatReload.ts`. It uses two normally closed, distinct VS
Code 1.138.0 processes with the same isolated profile and a local deterministic provider. The intended assertions are
native restoration of two chat identities and queued drafts, no model calls before fresh renderer input, no cross-chat
delivery, stale-restore navigation fencing, and cleanup. Its result is claimed only if the real runner completes.
This lane does not establish abrupt-crash recovery or interrupted active-provider recovery.
Its first real run found the fresh-input queue deadlock above after restoration and stale-navigation checks succeeded;
that failure is retained separately from the final rerun evidence.

The managed non-Git host lane also exposed a fixture synchronization error: its scripted parent assumed one
`wait_agent` call returned both Workers' replies. Codex and Alpha return on the first available activity, and the
public raw Task completion event can precede mailbox publication. The fixture now waits again for missing reply IDs
within a strict request bound, retaining both-reply, exactly-once completion, and isolation assertions. This correction
does not change production wait semantics; the initial host failure is retained in the validation history.

Machine-readable final outcomes, exact commands, source fingerprints, test reports, host evidence, and the resulting
VSIX hash belong in `artifacts/certification/codex-convergence-reliability-validation.json`. A completed successful
command is required for a passing claim. This separate evidence preserves the original pass's provenance.

- **Fixed now:** the code mechanisms above and their deterministic regression coverage. Existing twenty fixes remain
  in place. The source comparison is anchored to Codex rather than other extension harnesses.
- **Flagged for follow-up:** no known code defect from the listed investigation is deliberately deferred. Validation
  failures or additional concrete defects found during integration must be resolved or explicitly recorded before
  completion; this statement does not assert that unexamined defects do not exist.
- **Not verified by source/unit evidence:** installed-user failure frequency, all historical settings, OS/remote-host
  combinations, non-cooperative paid providers, abrupt crashes, and the certificate's explicit manual/live rows. Native
  reload success is determined by the runner evidence rather than inferred here.
- **Out of scope:** sandbox replacement, security weakening, a new runtime, copying upstream source/prompts, release
  version changes, external telemetry, and reconstructing previously overwritten profiles or never-saved panel IDs.
