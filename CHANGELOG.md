# Changelog

## 2.1.24

### Patch Changes

- Let approved commands run when bounded workspace observation is unavailable, while preserving explicit incomplete-scope reporting and cancellation semantics.
- Keep ordinary primary edits proportionate to the request instead of forcing inferred verification recipes or dependency scans.
- Repair public batch file reads and reduce lifecycle persistence amplification by coalescing compatible response fragments.

## 2.1.22

### Patch Changes

- Fix tasks incorrectly stopping as unverified after committing already-observed workspace changes, including initial commits and commands that finish in the background.
- Detect edits, additions, and deletions committed during a command through bounded Git tree comparisons, while retaining stale-snapshot checks and observation limits.

## 2.1.21

### Patch Changes

- Include the exact skill file and base directory when loading skills, including slash commands and inherited mode-specific skills, so linked references can be resolved without guessing a workspace-relative path.
- Clarify skill-relative file handling while preserving file-read approvals, ignore rules, and the selected skill's instructions.

## 2.1.20

### Patch Changes

- Route immediate follow-up answers using the current transcript boundary, including fast suggestion clicks and host-invoked replies before presentation effects settle.
- Retain all agent-harness and incremental-persistence improvements from 2.1.19.
- Align the default-model UI test with the existing shared Anthropic default contract; provider defaults are unchanged.

## 2.1.19

### Patch Changes

- Make assistant-message presentation preview-only so the canonical tool registry and scheduler own execution.
- Stabilize captured policy-scoped tool catalogs and defer discovery of large MCP tool collections.
- Reuse bounded task-scoped environment snapshots and deltas while cancelling obsolete request preflight work.
- Run eligible, automatically approved nonrecursive directory reads in bounded parallel batches, preserving policy checks, cancellation, and ordered results.
- Retain recent complete working steps during safe context compaction, including tool transactions and opaque provider state.
- Require current change-scoped verification for applicable edits and bound stagnant completion attempts while preserving ordinary answers and reviews.
- Replace duplicate full-history sidecar writes with compact durable receipts, fresh authoritative-file integrity checks, bounded persistence queues, and cleanup that still completes after a failed save.

## 2.1.18

### Patch Changes

- Add Claude Fable 5.1 to the Anthropic setup and expose Low, Medium, High, XHigh, and Max reasoning for Fable 5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8, and Opus 4.7.
- Send the selected effort with adaptive thinking for chat and single completions, defaulting unsupported saved settings to High.
- Use Sonnet 5 for new Claude setups and hide retired Claude models from new selections while retaining their saved model IDs.
- Enable Fable 5.1's thinking binding compatibility control so history edits and context compaction can discard invalidated thinking instead of failing the request.

## 2.1.17

### Patch Changes

- Add GPT-6 Astra to the OpenAI provider with selectable Low, Medium, High, XHigh, and Max reasoning levels.
- Add Gemini 3.8 Flash to the Gemini provider with selectable Low, Medium, and High thinking levels.
- Initialize both models with Medium reasoning, omit unsupported sampling parameters, and replace unsupported saved Astra reasoning settings with its default.

## 2.1.16

### Patch Changes

- Keep managed-agent completion verification available after system sleep, extension-host stalls, or transient owner-heartbeat failures by deferring stale-looking live leases for a confirmation scan.
- Recover a compromised runtime lease with a fresh fencing token only when the durable agent tree and mailbox claims still match the current host, while continuing to reject a writer after another host has recovered or adopted its work.

## 2.1.15

### Patch Changes

- Make steering interrupt the entire active model step, including provider pacing, retry waits, request preflight, and automatic context compaction, so stale work cannot admit an obsolete model call.
- Preserve composer drafts and queued messages until the extension acknowledges queue or steering admission, and keep Stop responsive while other webview operations are still running.
- Drive chat controls from task-scoped live lifecycle metadata, tolerate malformed historical request records, and show recoverable feedback when an active turn has produced no output for a while.
- Include the Windows managed-agent transaction-lock promotion retry from v2.1.14 for users upgrading from the affected v2.1.12 build.

## 2.1.14

### Patch Changes

- Retry transient Windows failures while atomically promoting the managed-agent transaction lock, preventing a disappearing competing lock from blocking completion verification.

## 2.1.13

### Patch Changes

- Open long chats promptly by presenting cached task state immediately, progressively mounting older transcript rows, and moving the expensive global refresh off the focus critical path.
- Show immediate busy feedback when opening a task and prevent duplicate task-opening requests while the selected chat loads.
- Admit completed-task follow-ups before prior lifecycle durability settles, prevent duplicate submissions, preserve truthful lifecycle ordering, and avoid redundant full-history writes.
- Share VS Code Language Model discovery across matching handlers and defer fallback token estimation until it is actually needed.

## 2.1.12

### Patch Changes

- Require `read_file` calls to include a path in the tool schema exposed to VS Code Language Models, preventing empty calls and avoidable retries.
- Show immediate progress when continuing a completed task, suppress stale new-task controls and duplicate submissions, and restore the draft if resume admission fails.
- Reuse retained task history during completed-task follow-ups to remove redundant transcript reads and writes while preserving the lifecycle finalization boundary.

## 2.1.11

### Patch Changes

- Validate the extension and VS Code Language Model contract on exact VS Code 1.122.1.
- Keep completed-task follow-ups in the same task, restore drafts after resume failures, and prevent stale streams from interfering with later turns.
- Reduce tool-call and completion latency by coalescing streaming persistence, removing fixed delays, and bounding provider-side waits.
- Harden cancellation, lifecycle persistence, checkpoint execution, dependency security, and the release regression gate.

## 2.1.10

### Patch Changes

- Keep completed model turns distinct from completed tasks so follow-up prompts continue in the current task.
- Preserve the active composer and task controls while a completion review boundary is pending, preventing submitted follow-ups from disappearing or freezing the UI.
- Mark task history complete only after the authoritative task lifecycle reports completion, including when delayed snapshots arrive out of order.

## 2.1.9

### Patch Changes

- Converge the extension agent loop on explicit turn, step, item, tool, retry, cancellation, and terminal lifecycle contracts.
- Persist deterministic tool receipts and preserve truthful failed, incomplete, and cancelled outcomes across provider and task recovery paths.
- Add joinable task cancellation with fail-closed checkpoint and Goal Seek rollback handling.

## 2.1.8

### Patch Changes

- Preserve VS Code LM stateful-response markers across tool turns so Copilot Responses models can match tool outputs to their original function calls.

## 2.1.7

### Patch Changes

- Add `xai/grok-4.6` to GCP Vertex AI through its OpenAI-compatible partner-model endpoint, with global-region metadata and Grok-specific capabilities.
- Reuse the existing Vertex project, location, gateway URL, PEM CA bundle, Helix token refresh, streaming, and per-model routing settings while preserving the native Gemini and Anthropic transports.
- Refresh an expired Helix credential once before a Grok stream starts, and cover endpoint construction, request shape, routing overrides, legacy settings, streaming, and non-streaming behavior.

## 2.1.6

### Patch Changes

- Make VS Code's live Language Model API response authoritative so account-, plan-, policy-, or window-unavailable models are never exposed as clickable choices.
- Preserve exact selectors and display names for current Copilot GPT-5.3-Codex, GPT-5.5, GPT-5.6 Luna/Sol/Terra, Anthropic Claude, Gemini, MAI, Raptor, Kimi, and Grok models while continuing to exclude Mythos.
- Correct Claude context and reasoning metadata, and offer standard versus extended / 1M context only when the selected live model advertises the larger tier.
- Add model refresh, unavailable-selection guidance, exact-selector initialization, and clearer errors for missing Copilot authentication in an Extension Development Host.
- Keep VS Code LM requests on the public VS Code 1.122.1 API, move token estimation off the generation critical path, and report the VS Code 1.128 requirement when Copilot cannot expose GPT-5.6 on an older host.
- Normalize tool and non-tool providers onto one persisted completion boundary, promote streamed assistant text in place instead of rendering a duplicate final, and let queued follow-ups continue the same task safely.
- Reduce extension/webview churn with incremental transcript, queue, and todo updates protected by independent ordering domains.

## 2.1.5

### Patch Changes

- Keep the VS Code Language Model provider selectable before account-specific discovery completes by merging live selectors into a current GitHub Copilot catalog fallback.
- Add and deduplicate current GPT-5.3-Codex, GPT-5.5, GPT-5.6 Luna/Sol/Terra, and Claude model selectors while removing the unsupported Mythos entry.
- Add explicit standard and extended context-window selection for compatible Copilot models, including the correct 200K Luna and 272K GPT-5.5/Sol/Terra standard tiers and the provider-adjusted 1M tier.

## 2.1.4

### Patch Changes

- Remove slow full-state, MCP connection, and credential-store work from the new-task submission path so a submitted task opens and starts promptly in managed corporate environments.
- Prevent stale mistake-recovery state from intercepting completion feedback, queued guidance, or otherwise productive turns, and include the failed tool and bounded error details in future recovery guidance.

## 2.1.3

### Patch Changes

- Focus ordinary user-facing mode selection on Plan and Code across chat, follow-up suggestions, slash suggestions, scheduled tasks, Goal Seek, Marketplace, and skill setup.
- Add a composer-scoped `Shift+Tab` shortcut for switching between Plan and Code, with guards for streaming, queued-message editing, composition, repeated events, and conflicting modifiers.
- Keep Code and Plan changes within the current task and provider configuration while resetting new-task drafts to Code.
- Preserve legacy and custom-mode tasks for compatibility without offering them in normal mode selectors or Settings setup.
- Keep mode configuration edits buffered in Settings until the user explicitly saves them.

## 2.1.2

### Patch Changes

- Add the internal Stellar provider with OpenAI-compatible chat completions, Helix token refresh, PEM CA trust, streaming controls, and custom model IDs.
- Refresh the built-in Anthropic, Gemini, OpenAI, Vertex AI, and VS Code language-model catalogs and capability metadata.
- Harden OpenAI-compatible and Vertex AI native tool-call handling across streaming and non-streaming responses.
- Keep queued steering messages scoped to the active task and preserve drafts when the task is not ready to accept them.
- Support organization-specific custom model selections without destabilizing the Settings edit buffer.

## 2.1.1

### Patch Changes

- Add model-controlled access to VS Code's integrated browser, including browser-only automatic approval for opening pages.
- Allow explicit chat requests to compact the current task context without starting a separate model turn.
- Bound unproductive recovery loops, enforce explicit-only delegation at execution time, and preserve same-task continuation.
- Replace virtualized chat scrolling with exact native scroll geometry to prevent long-conversation bottom bounce.
- Preserve the proven primary-agent loop while managed child work runs asynchronously.
- Freeze child instructions in the system layer and pass only bounded, sanitized parent context.
- Return managed child completions exactly once through native `wait_agent` tool results, including after reloads.
- Clarify blocking handoffs, background delegation, and reload-safe lifecycle controls.

## 2.1.0

### Minor Changes

- Add managed subagent lifecycle control, nested delegation, follow-up delivery, recovery, and monitoring UX.

## 2.0.7

### Patch Changes

- Eliminate end-of-chat scroll bouncing by converging bottom detection and correction on the physical scroller boundary.
- Preserve deliberate history browsing during late row measurement and nested code-block scrolling.

## 2.0.6

### Patch Changes

- Keep transcript wheel scrolling active when the pointer is over the floating bottom-navigation controls.
- Replace the full-width bottom-navigation bar with compact controls that no longer obscure completed-task output.

## 2.0.5

### Patch Changes

- Make the virtualized list the single owner of appended-message and viewport-resize following, and route streamed row growth through its built-in bottom-follow path.
- Add a 32px physical gap between the transcript scrollbar and composer while preserving the existing space below the newest message.

## 2.0.4

### Patch Changes

- Fix virtualized long chats opening away from the newest message and preserve the transcript viewport when recovery controls appear.
- Keep bottom-following stable while late Markdown, image, and row-height measurements settle without interrupting manual history browsing.

## 2.0.3

### Patch Changes

- Stabilize long-chat bottom following by coalescing streamed row-growth corrections into a single exact-bottom scroll.
- Add comfortable space beneath the latest response while preserving manual history browsing.

## 1.1.6

### Patch Changes

- [codex] Fix completed parallel task follow-up routing and refresh skill discovery from `.agents/skills`.

## 1.1.5

### Patch Changes

- [codex] Fix extension command auto-approval settings.
- [codex] Clean up GitHub Copilot Claude model handling, including Opus 4.7 reasoning support and duplicate picker entries.

## 1.1.2

### Patch Changes

- [codex] Package and publish the Alpha VSIX release for v1.1.2.

## 1.1.1

### Patch Changes

- [codex] Fix task lane mode and provider isolation when switching modes from tools or slash commands
- [codex] Ensure delegated child tasks use the provider profile mapped to the child mode
- [codex] Keep focused lane state aligned with that lane's provider settings

## 1.1.0

### Minor Changes

- [codex] Fix corporate gateway native tool event handling for orchestrator and mode delegation
- [codex] Ensure gateway streamed tool calls complete before task recovery logic runs

## 1.0.9

### Patch Changes

- [codex] Reissue the orchestrator native tool delegation fix from merged `main`
- [codex] Preserve streamed `new_task` arguments so orchestrator can create mode-specific subtasks

## 1.0.6

### Patch Changes

- [codex] Fix Orchestrator delegation recovery for mode-specific subtasks

## 1.0.5

### Patch Changes

- [codex] Fix orchestration delegation recovery loops
- Add scheduled task agents

## 1.0.4

### Patch Changes

- [codex] Fix release workflow automation

All notable changes to Alpha will be documented in this file starting from the Alpha rebrand baseline.

## Unreleased

- Reset release history for the Alpha-branded codebase.
- Removed the legacy marketing website app from the monorepo.
- Renamed internal packages to the `@alpha-code/*` scope.
- Renamed the CLI binary to `alpha`.
