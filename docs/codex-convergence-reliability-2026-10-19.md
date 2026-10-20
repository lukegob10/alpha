# Codex convergence: reliability closure

Date: October 19, 2026, America/New_York. This note closes the source comparison behind the reliability follow-ups.
It is a bounded audit of the listed contracts, not certification of full Alpha/Codex equivalence.

The behavioral target is current Codex CLI and its public app-server engine. Alpha keeps its TypeScript execution
kernel, VS Code 1.138.0 adapters, provider-neutral interfaces, built-in tools, skills, HTML previewer, Tickets, and
scheduled tasks. Codex's sandbox architecture is outside this convergence target. Neither Cline nor Roo is a target for
this closure.

## Current reference

`git ls-remote https://github.com/openai/codex.git HEAD` returned
[`8196bcdc189ad2c189d631b321fa54b8e09b9bb0`](https://github.com/openai/codex/commit/8196bcdc189ad2c189d631b321fa54b8e09b9bb0)
during this follow-up. A separate ignored sparse checkout at
`artifacts/ux-reliability-hunt/upstream/codex-8196bcdc` was verified with `git rev-parse HEAD`. The prior
`091008729d5572712ac08964a9602eb71cf31428` cache and research record were preserved. Links below pin the refreshed
revision; they do not depend on a moving `main` branch.

Official [app-server events](https://learn.chatgpt.com/docs/app-server#events) and
[`codex doctor`](https://learn.chatgpt.com/docs/developer-commands#codex-doctor) documentation were fetched again.
The public sources establish engine and CLI behavior. They do not expose every implementation detail of the private
Codex IDE frontend.

## Closure decisions

| Decision                                      | Scope                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed in the prior hunt; source reviewed      | UX-01 through UX-20, detailed below. Their existing regression and aggregate reports remain the validation authority.                                                                                                                                                                                                                 |
| Already aligned at the shared owner           | Per-thread runtime status, subscribe-before-check input delivery, queued child-result ownership, typed terminal outcomes, and the main turn cancellation contract. This review found no basis to replace those owners.                                                                                                                |
| Actionable mismatch at this follow-up's start | Preserve arbitrary invalid saved profile data without executing it; expose an unavailable explicit selection; propagate caller cancellation through additional single completions; include bounded current installation/setup/receipt context in the existing support report. The owning implementation tracks close these contracts. |
| Unverified by this research                   | New closure implementations' command outcomes, manual editor interaction/reload, real-provider cancellation, complete historical upgrade coverage, and whole-product parity. Source presence alone does not pass these checks.                                                                                                        |

## Configuration: preserve data and respect explicit selection

Current Codex establishes three distinct rules:

1. Config edits parse the existing TOML document before applying targeted changes and atomically writing it. A parse
   error is returned before the write. Existing unrelated configuration survives targeted migration acknowledgements.
2. An explicitly selected provider that is absent from the configured provider map produces a missing-provider error.
   The default `openai` selection is used when no provider is supplied, not as repair for a supplied invalid ID.
3. Model selection has a deliberate fallback policy. The ordinary manager preserves a supplied model ID. A static
   provider catalog can choose its default only when `allow_provider_model_fallback` is enabled. Falling back to model
   metadata also preserves the requested model slug; metadata is not a different execution target.

Sources:
[config/edit.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/edit.rs),
[config/mod.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/mod.rs),
[models-manager/manager.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/models-manager/src/manager.rs).

The inspected tests make those distinctions concrete:

- `core/src/config/edit_tests.rs`: `blocking_record_model_migration_seen_preserves_table` retains existing notice data.
- `core/src/config/config_loader_tests.rs`: `returns_config_error_for_invalid_user_config_toml` checks the structured
  error for the actual bad document. Explicit `ignore_user_config` is separately tested; it is not silent corruption
  repair.
- `models-manager/src/manager_tests.rs`: `static_manager_preserves_supported_requested_model_when_fallback_is_allowed`,
  `static_manager_falls_back_from_unsupported_requested_model_when_allowed`,
  `static_manager_preserves_unsupported_requested_model_when_fallback_is_disabled`,
  `dynamic_manager_preserves_requested_model_when_fallback_is_allowed`, and `get_model_info_tracks_fallback_usage`.

Tests: [config edits](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/edit_tests.rs),
[config loading](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/config/config_loader_tests.rs),
[model selection](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/models-manager/src/manager_tests.rs).

The prior Alpha fixes already normalize the recognized historical null mistake limit and assign durable profile IDs
before building mode bindings. The remaining mismatch at the start of this follow-up was that other schema-invalid
saved profiles could disappear from the reader's filtered map and a subsequent write. Retaining the original object
separately from validated executable profiles is appropriate: retention must not grant execution authority. Selected
unavailable profiles must remain visible as unavailable and must not trigger a different provider behind the user's
back. A deliberate migration or authorized model fallback is a separate operation.

## Single completions: cancellation follows the operation owner

The current Codex response stream owns a `consumer_dropped` cancellation token. Dropping the consumer cancels its
upstream mapper even before a provider completion event arrives. The interceptor test starts an open stream, verifies
ordered transformed output, drops the consumer, and waits for upstream cancellation. Task abort similarly signals its
token before joining work for the bounded grace period and aborting the remaining task.

Sources and tests:
[client_common.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/client_common.rs),
[`interceptors_forward_before_completion_in_order_and_cancel_upstream`](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/model_request_tests.rs),
[tasks/mod.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/tasks/mod.rs).

`core/tests/suite/abort_tasks.rs` checks that interruption produces terminal aborted state and preserves the call plus
aborted result in subsequent history. `abort_lifecycle.rs::abort_lifecycle_finishes_before_terminal_event` uses a
controlled barrier to verify the abort callback finishes once before the terminal notification, for interruption,
conditional interruption, and shutdown.

Tests: [abort transactions](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/tests/suite/abort_tasks.rs),
[abort lifecycle](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/tests/suite/abort_lifecycle.rs).

The prior Alpha fixes dispose prompt-enhancement providers and close failed/timed-out VS Code LM iterators. The missing
contract was caller cancellation of that operation. A signal must reach discovery, provider request and consumption;
the shared helper also needs to settle if an adapter ignores the signal. Pre-cancelled work must not start, replaced
UI requests must not publish late results, and cleanup must not wait indefinitely for an uncooperative iterator.
There was no verified one-to-one public Codex prompt-enhancement feature in this audit. This is alignment with the
engine's cancellation ownership, adapted to Alpha's existing additional feature.

## Diagnostics: useful local evidence without collecting conversation contents

Codex's public CLI has a local doctor report and a redacted machine-readable representation. Its output redaction
checks URL credentials, query/path secrets, credential-shaped identifiers, and environment-variable diagnostic fields.
Tests include `redact_detail_sanitizes_urls`, `redact_detail_sanitizes_secret_url_path_segments`, and
`redact_detail_preserves_missing_env_diagnostics`. The desktop test
`failed_handshake_does_not_expose_sensitive_log_fields` verifies that a diagnostic classification does not copy a raw
private log error into the report.

Sources and tests: [doctor/output.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/cli/src/doctor/output.rs),
[doctor/desktop_tests.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/cli/src/doctor/desktop_tests.rs).

Separate app-server diagnostics expose process memory and registered gauges. Tests check the live-thread gauge and
that this RPC requires the experimental capability. This is aggregate operational evidence, not a task transcript:
[request processor](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/src/request_processors/diagnostics.rs),
[server diagnostics tests](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/tests/suite/v2/server_diagnostics.rs).

Codex also has a separate optional rich feedback mechanism: a bounded log ring, bounded attachments/tails, and a log
consent flag. It must not be described as universally redacted. In this revision,
`feedback_diagnostics.rs::collect_from_pairs_reports_raw_values_and_attachment` intentionally tests raw proxy values,
and `feedback_diagnostics_attachment_text` includes them only when logs are allowed.

Sources and tests: [feedback/lib.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/feedback/src/lib.rs),
[feedback diagnostics](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/feedback/src/feedback_diagnostics.rs),
[bounded daemon-log tests](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/feedback/src/daemon_logs_tests.rs).

Alpha already has bounded, allowlisted task evidence in `diagnosticsEvidence.ts`, `SettlementDiagnostics.ts`, and its
incident surface. The remaining support gap was enough current environment/setup/lifecycle context to distinguish a
stale loaded build, bad saved configuration, or missing input receipt. Extending the existing local report is the
appropriate owner. Retaining Alpha's stricter no-raw-prompts/no-credentials/no-provider-history export is deliberate
privacy behavior. This follow-up does not authorize uploading evidence or adding fleet telemetry.

## Review of the previous twenty fixes

The following are fixed code paths from the prior hunt. The review inspected the owning Alpha changes and current
Codex contracts. “Aligned” describes the named invariant, not an assertion that the storage schemas, UI, or runtime
implementations are identical. This research agent did not rerun their tests.

| Previous IDs        | Decision                                        | Reason and remaining scope                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-01, UX-02        | Fixed; aligned preservation/selection invariant | Known old values and valid selection survive migration. General invalid-object retention is the separate follow-up above.                                                                                                                                           |
| UX-03, UX-04        | Fixed; aligned persistence invariant            | Atomic UI replacement and following newly committed canonical history avoid a transient missing history or stale fallback. Alpha's receipt store remains its own implementation.                                                                                    |
| UX-05, UX-06, UX-07 | Fixed; aligned state ownership                  | Captured chat selection and ordered publications prevent an older producer from changing newer lifecycle controls. Sequence and transcript-revision adapters are specific to VS Code messaging.                                                                     |
| UX-08               | Fixed; native host adapter                      | A serializer restores saved panel identity through the shared task host. Cold panel presentation requires explicit input rather than starting execution merely because a view was reconstructed. Exact visual reload acceptance remains a separate validation item. |
| UX-09               | Fixed; native activation/resource owner         | Worktree auto-open runs after command registration and its timer is disposed. This is VS Code host behavior, not a competing Codex lifecycle.                                                                                                                       |
| UX-10               | Fixed; aligned cancellation ownership           | A fresh explicit Stop can retry failed finalization without re-aborting processes or republishing terminal effects. Failed persistence remains an error; this does not claim Codex's identical retry implementation.                                                |
| UX-11               | Fixed; aligned terminal request ownership       | Approval errors settle the opened request once, retain tool error/cancel distinctions, and fence effects when publication fails. Alpha's existing approval/security authority remains intact.                                                                       |
| UX-12               | Fixed; aligned durable input ownership          | A queued deletion commits before the draft is released; later input cannot overtake a possible rollback. Alpha's durable queue and receipt schema remain authoritative.                                                                                             |
| UX-13               | Fixed; aligned replay ownership                 | Deduplication precedes lifecycle mutation, so replay cannot close a successor turn or restart an old follow-up. This is Alpha's persistence contract, not a claimed matching upstream receipt format.                                                               |
| UX-14               | Fixed; aligned history integrity                | Closed call-ID occurrences no longer merge independent steps; existing IDs and provider state are preserved. This is provider-neutral compatibility, not permission to drop incomplete transactions.                                                                |
| UX-15, UX-16        | Fixed; aligned process ownership                | Old output readers cannot clear a replacement command; cancelled prelaunch work cannot spawn. Physical process and terminal adapters remain native Alpha code.                                                                                                      |
| UX-17, UX-18        | Fixed; aligned provider boundary                | Repaired setup can be retried and typed retry/cancellation metadata survives wrapping. TLS file handling is an Alpha provider capability, not an upstream sandbox adaptation.                                                                                       |
| UX-19, UX-20        | Fixed; aligned cleanup invariant                | Failed single-completion streams and disposable providers release their owned resources. Caller cancellation is the separate follow-up above.                                                                                                                       |

Current reference anchors for these common invariants are
[per-thread runtime status](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/src/thread_status.rs),
[subscribe-before-check input delivery](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/session/input_queue.rs),
[queue-only child results](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/core/src/agent/control/completion.rs),
and the cancellation/configuration sources above. The prior hunt's exact Alpha regressions and validation ledger
remain in `docs/ux-reliability-hunt-2026-10-19.md` and its machine-readable evidence.

The native reload run additionally exposed a fresh-human queue path that did not release Alpha's passive-restore fence.
The current upstream [queue processor](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)
requires a resumed thread before an explicit queue start and rejects an already active/pending turn.
Its [queue tests](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/tests/suite/v2/thread_queue.rs)
include `idle_queue_dispatch_preserves_client_id`, `cold_thread_resume_dispatches_a_persisted_queued_submission`, and
`interrupt_preserves_queue_and_queue_start_can_resume_a_non_head_item`. Metadata reads do not resume the thread; an
explicit resume is a separate host operation. Alpha deliberately treats native panel reconstruction as presentation,
while fresh durable human input authorizes the existing Task to continue. That adapter distinction must not strand
accepted input or turn a duplicate receipt into permission to replay drafts after Stop.

## Deliberate distinctions and verification limits

- A new default when selection is absent, a metadata fallback, and an explicitly permitted model fallback are different
  from silently changing an invalid saved profile's execution target. Do not remove the former to implement the latter.
- Restoring a VS Code panel is a presentation operation. Codex separately tests managed daemon restart recovery with
  loaded threads and goals in
  [daemon_update_recovery.rs](https://github.com/openai/codex/blob/8196bcdc189ad2c189d631b321fa54b8e09b9bb0/codex-rs/app-server/tests/suite/v2/daemon_update_recovery.rs).
  That deliberate managed restart policy is not evidence that opening any saved chat should replay queued input.
- Exact provider deadline values are configuration, not established parity from matching an abort interface. Alpha's
  caller deadline and provider stream deadline must retain distinct ownership and cannot relabel cancellation success.
- Alpha's extra tools retain the shared lifecycle, cancellation, persistence, approval, and policy rules. No separate
  runtime or source copying is needed for them. The sandbox exception does not relax Alpha's security or path scope.
- Source-inspected implementation, a deterministic passing test, exact-host acceptance, and manual/live acceptance are
  separate evidence classes. A pending manual/live integration row is not an unimplemented code defect by itself.

No Codex/Rust tests, third-party tests, production live-provider requests, or broad repository gates were run by this
research agent. The integrating agent owns code closure and command outcomes. Nothing in this note establishes all
historical upgrade paths, installed-user failure frequency, proprietary frontend behavior, or universal parity.
