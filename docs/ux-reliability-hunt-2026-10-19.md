# Extension UX reliability investigation

Date: October 19, 2026, America/New_York. Mode: operational hardening. Fifteen new investigation agents reviewed the
failure paths below, following the earlier six-agent managed-return investigation. Existing migration, navigation, and
managed-agent changes in the working tree were preserved.

The intended outcome is ordinary chats that finish, deliver their data, display their own current state, and preserve
saved configuration. The fixes prevent specific failures at their owning boundaries. A timeout that resets a view or a
retry that conceals a failed operation is not a substitute for those invariants. This audit does not establish that all
providers, historical configurations, or event orderings have been exhausted.

## Findings and closure

Each fixed behavior has a controlled regression or old-state fixture. Severity describes the affected path, not its
frequency in the installed population. “Must-fix” and “should-fix” refer to the importance of shipping the completed
patches; they do not mean the listed implementation remains outstanding.

| ID    | Severity / priority | Confirmed failure and correction                                                                                                                                                                                                                                                                                                                        | Owning boundary / regression                                                                            |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| UX-01 | High / must-fix     | A recognized legacy `consecutiveMistakeLimit: null` profile failed current validation before its migration and could be removed by the next save. Normalize this known old representation before validation.                                                                                                                                            | `ProviderSettingsManager`; `ProviderSettingsManager.upgrade.spec.ts`                                    |
| UX-02 | Medium / should-fix | Modes were bound before legacy profile IDs existed, leaving dangling references or selecting another provider. Assign IDs first and repair only invalid executable-mode references; preserve valid choices.                                                                                                                                             | `ProviderSettingsManager`; upgrade fixtures and idempotent reopen                                       |
| UX-03 | High / must-fix     | UI transcript saves moved the old file away before replacement, so a concurrent reopen saw missing history. Use the existing atomic replacement option, retaining the old canonical file until commit.                                                                                                                                                  | `taskMessages.ts`; `taskMessages.atomic-replace.spec.ts`                                                |
| UX-04 | Medium / should-fix | A second cold reader rejected a chat that another reader had successfully migrated. Read the newly present, validated canonical authority under the existing locks. Missing, invalid, and conflicting authority still fails closed.                                                                                                                     | `apiMessages.ts`, `ProviderTranscriptStore`; migration and conflict tests                               |
| UX-05 | High / must-fix     | Asynchronous state assembly could combine the old chat's transcript/configuration with the newly selected chat's identity. Capture selection together and reject publication after its navigation or view ownership changes.                                                                                                                            | `AlphaProvider` state publishers; `AlphaProvider.task-state-navigation.spec.ts`                         |
| UX-06 | Medium / should-fix | An older buffered partial update could replace a newer update before the animation frame flushed. Coalescing now respects the publication sequence.                                                                                                                                                                                                     | `ExtensionStateContext`; controlled out-of-order incremental updates                                    |
| UX-07 | High / must-fix     | Stale incremental metadata or a delayed assembled snapshot could restore running controls after completion, including background views. Reject obsolete visible publications before metadata and use canonical transcript revisions for ordering; retain same-revision lifecycle transitions and authoritative removals.                                | `ExtensionStateContext`; foreground, background and late-snapshot metadata tests                        |
| UX-08 | High / must-fix     | Editor chat panels had no reload serializer or persisted chat identity. Register native panel restoration and persist a validated, versioned selection after accepted editor hydration. Restore through existing task ownership with explicit input required for cold execution.                                                                        | Editor panel adapter, provider history admission, shared editor-state schema, webview persistence tests |
| UX-09 | Medium / should-fix | Worktree auto-open could run before its command registered during slow settings import, or after extension disposal. Schedule it after registration and give its timer a subscription owner.                                                                                                                                                            | `extension.ts`; `extension-lifecycle.spec.ts`                                                           |
| UX-10 | Medium / should-fix | A late finalization write failure left Stop permanently reusing its rejected receipt. A fresh explicit Stop can retry finalization against the original boundary without repeating process abort or terminal events.                                                                                                                                    | `Task` cancellation receipt; `AlphaProvider.stop-finalization-retry.spec.ts`                            |
| UX-11 | High / must-fix     | Approval transport, validation, or persistence failures could leave a requested approval pending after its tool ended. Settle inside the approval owner before errors can be caught by tool handlers; preserve error/effect-fence semantics and exactly one terminal decision. Cancellation before a request opens must not publish an orphan decision. | `ToolScheduler`; `ToolScheduler.approval-failure.spec.ts`                                               |
| UX-12 | Medium / should-fix | A queued deletion was shown before persistence accepted it, allowing a deleted draft to return after reopen or later input to overtake a failed deletion. Use the existing durable mutation transaction and retain FIFO ownership until commit.                                                                                                         | `MessageQueueService`, API and webview deletion callers; deletion durability tests                      |
| UX-13 | High / must-fix     | Replaying a committed agent event applied its old lifecycle transition before deduplication, potentially completing a successor turn or restarting a spent follow-up. Validate/deduplicate before mutation; preserve explicit rollback receipt readmission.                                                                                             | `AgentControlStore`; `AgentControlStore.lifecycle-replay.spec.ts`                                       |
| UX-14 | High / must-fix     | Closed tool-call ID reuse merged independent turns into one history span, causing context exhaustion despite a fitting recent transaction. Calculate boundaries per open/closed occurrence without changing persisted IDs or provider state.                                                                                                            | `condense/index.ts`; exact recent-tail and actual context-management regressions                        |
| UX-15 | Medium / should-fix | An old terminal output reader could clear a replacement command's busy/stream state after physical shell exit allowed reuse. Mutations now require the same process owner.                                                                                                                                                                              | `Terminal`, `TerminalProcess`; success/error reader barriers                                            |
| UX-16 | Medium / should-fix | Execa could spawn after cancellation through its supported prelaunch process-ownership hook. Skip spawning and use the existing cancelled finalization path. Stock UI frequency of this exact synchronous timing was not demonstrated.                                                                                                                  | `ExecaTerminalProcess`; shell and argv prelaunch cancellation tests                                     |
| UX-17 | High / must-fix     | A rejected Stellar/Vertex Gemini certificate setup promise was retained forever, so correcting the file and retrying the same handler still failed. Evict only the identical failed setup promise; retain successful setup and concurrent sharing.                                                                                                      | Provider adapters; `gateway-setup-retry.spec.ts`                                                        |
| UX-18 | Medium / should-fix | Stellar wrapping lost retry timing, permanent-failure classification, and cancellation identity. Reuse the existing shared error handler.                                                                                                                                                                                                               | `stellar.ts`; rate-limit, quota, and cancellation tests across adapter surfaces                         |
| UX-19 | Medium / should-fix | Failed or timed-out single-completion LM streams retained their iterator/request. Cancel failed consumption and close the iterator without awaiting stalled cleanup.                                                                                                                                                                                    | `vscode-lm.ts`; failed/timeout completion tests                                                         |
| UX-20 | Medium / should-fix | Prompt enhancement created disposable providers but never disposed them, retaining model/configuration listeners after repeated use. The helper owns disposal on success, failure, and unsupported completion.                                                                                                                                          | `single-completion-handler.ts`; provider lifecycle tests                                                |

These are fixed implementation paths, not evidence of twenty observed extension-host process crashes. Most reported
“crash-like” symptoms are stale ownership or state ordering: working indicators, disabled controls, missing history,
stuck approvals, or work/data appearing in the wrong lifecycle. The previous managed-return fixes remain in place.

## What this says about infrequent updates

There is direct evidence for upgrade friction: UX-01 and UX-02 affect specific older saved profiles, and UX-04 affects
concurrent legacy history migration. Restarting alone does not repair incorrect persisted profile bindings. The new
targeted migrations preserve recognized old configuration and repair dangling references idempotently. They cannot
reconstruct a profile that an older build already overwrote.

Certificate setup cache poisoning is a separate setup/runtime defect. Streaming cleanup, terminal ownership, stale
projection, and event replay do not require an old installation. No cohort telemetry or affected-user sample was
available to rank these causes or establish general sign-in expiry from skipped releases. A fresh-profile smoke pass
alone is insufficient evidence for upgrade compatibility; the old-state fixtures are part of this change.

## Codex and other harnesses

The [upstream research](ux-reliability-upstream-2026-10-19.md) pins current Codex CLI/app-server commit
`091008729d5572712ac08964a9602eb71cf31428`, plus current Cline and Roo source revisions. It distinguishes inspected
public engine code from the private Codex IDE frontend.

The relevant verified patterns are per-thread runtime status, typed completed/failed/interrupted outcomes, listeners
registered before pending-input checks, queued child delivery, generation fences before asynchronous cancellation or
navigation, and one persistence/finalization owner. Alpha keeps these invariants in its existing TypeScript execution
kernel and native VS Code adapters. No parallel runtime, copied Rust code, new approval bypass, generic reset watchdog,
or production dependency was added.

## Coverage ledger

| Investigation agent       | Reviewed surface                                                                    | Closure                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hunt_turn_lifecycle`     | Turn engine and Task adapter terminal ownership                                     | No additional confirmed engine defect; 86 existing tests passed. Independently reviewed Stop and scheduler changes; a suspected optional-compaction failure was ruled out. |
| `hunt_stop_disposal`      | Cancellation, Stop, finalization joins, disposal                                    | UX-10 fixed; original failure remains observable and retries retain original ownership.                                                                                    |
| `hunt_input_delivery`     | Queue admission/claim/receipt, steering and deletion                                | UX-12 fixed. No new perpetual-delivery defect confirmed beyond the earlier wait/Stop fixes.                                                                                |
| `hunt_chat_routing`       | Foreground/background selection and async state publishers                          | UX-05 fixed.                                                                                                                                                               |
| `hunt_persistence_reload` | UI/provider history commits, legacy migration and conflict handling                 | UX-03 and UX-04 fixed.                                                                                                                                                     |
| `hunt_webview_hydration`  | Incremental coalescing, metadata ordering and editor selection persistence          | UX-06 and UX-07 fixed; frontend portion of UX-08.                                                                                                                          |
| `hunt_activation_setup`   | Activation ordering and editor reload contract                                      | UX-08 and UX-09 fixed.                                                                                                                                                     |
| `hunt_upgrade_config`     | Provider/profile migration, saved mode bindings, import/context compatibility       | UX-01 and UX-02 fixed. Unrecognized schema-invalid profiles remain a separate design risk.                                                                                 |
| `hunt_vscode_lm`          | LM discovery/streaming/error/cancellation and prompt enhancement ownership          | UX-19 and UX-20 fixed; main chat's existing phase deadlines and late-cancellation guards verified.                                                                         |
| `hunt_agent_handoffs`     | Agent control transactions, follow-up receipts, terminal replay and bounded runtime | UX-13 fixed. No second parent execution engine introduced.                                                                                                                 |
| `hunt_tools_approvals`    | Scheduler approval lifecycle and structured tool settlement                         | UX-11 fixed. Policy checks and effect fences remain enforced.                                                                                                              |
| `hunt_compaction_history` | Safe history boundaries, exact recent tail, exhaustion and recovery                 | UX-14 fixed; ordinary optional post-turn compaction errors already preserve completed answers.                                                                             |
| `hunt_terminal_processes` | Physical process exit, output closure, cancellation and terminal reuse              | UX-15 and UX-16 fixed; no real user command was killed by the tests.                                                                                                       |
| `hunt_provider_failures`  | Setup promise lifetime and retry/error classification                               | UX-17 and UX-18 fixed.                                                                                                                                                     |
| `hunt_upstream_reference` | Current Codex, Cline, Roo and official host documentation                           | Source comparison completed; no upstream test suites or private frontend internals executed/inspected.                                                                     |

### Fixed now

The twenty bounded failure paths above, regression fixtures, and native editor-restoration contract are implemented.
Individual reports provide details for [persistence](ux-persistence-hunt-2026-10-19.md),
[upgrade configuration](ux-reliability-upgrade-config-2026-10-19.md),
[provider failures](ux-reliability-provider-failures-2026-10-19.md), and
[long-chat history](ux-reliability-compaction-2026-10-19.md), and
[Stop finalization](ux-reliability-stop-disposal-2026-10-19.md).

### Closure follow-up

The user subsequently authorized closing the three remaining code/operational findings and reaffirmed Codex as the
behavioral reference. The [closure report](ux-reliability-closure-2026-10-19.md) records their implementation and the
additional defects reproduced during independent review. Saved invalid profiles now have a durable, non-executable
retention contract; both enhancement callers propagate cancellation through their provider requests; and the existing
local diagnostics report is available from the Command Palette with bounded setup and receipt evidence.

The [current Codex comparison](codex-convergence-reliability-2026-10-19.md) pins the newly verified upstream revision
`8196bcdc189ad2c189d631b321fa54b8e09b9bb0`. Alpha retains its native security protections and additional tools. Other
extension harnesses remain historical comparison material, rather than alternate behavioral targets. Installed-user
frequency still requires actual incident/cohort evidence; no fleet telemetry was introduced.

### Not verified

Original user incident logs, paid live-provider runs, installed-user failure frequency, all historical upgrade paths,
and all OS/remote-host combinations were not available. Automated failures are deterministic fault-injection or
controlled-ordering reproductions. Previously saved editor panels with no chat identity cannot have that missing
identity reconstructed; the restoration path must explain the condition and retain saved tasks.

### Out of scope

A replacement agent runtime, sandbox redesign, dependency upgrades, release version changes, broad formatting,
automatic deletion/reset of user state, and a guarantee of universal uptime.

## Aggregate validation

Focused red/green runs were performed per owning boundary before aggregate validation. The full extension run also
exposed four existing public ownership regressions for a permission hook whose step/run/turn/surface was replaced.
That coverage is now selected by the managed-agent certificate: failed approval settlement must distinguish loss of
the original owner from a real failure to publish under the current owner. The original run is retained separately in
the aggregate evidence rather than counted as a passing full suite. Focused runs overlap and must not be
added together as a unique-test total. The final source is frozen for the aggregate extension/webview/type/package,
managed-agent certification, exact VS Code **1.138.0** smoke, and installable-package checks.

Machine-readable aggregate outcomes are recorded in the ignored local
`artifacts/certification/ux-reliability-hunt-validation.json`; test/certification reports are linked there. Only a
successful completed command is a passed check. The managed-agent certificate's manual/live integration rows retain
their explicit pending status. Loading a new VSIX requires installing it and reloading the extension host; a built
package does not modify an already-running window.

That file records the original twenty-finding pass. Follow-up source and verification are recorded separately in
`artifacts/certification/codex-convergence-reliability-validation.json`, so the earlier passing source fingerprint is
not reused as evidence for later edits.
