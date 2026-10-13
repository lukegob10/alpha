# Settings UX review — October 10, 2026

This is a review and findings pass. Most settings still have live consumers. The main gaps are settings that promise
behavior the runtime does not implement, unsafe handling of draft or refreshed state, and an interface that still mixes
the old customizable-mode model with the current Code/Plan contract. No implementation changes were made for this review.

## Review organization and reference

The requested three review chats divided five sub-agents into two UX/state reviewers, two modes/instruction reviewers,
and one provider reviewer. Each chat integrated its own evidence; this report deduplicates that evidence and adds
independent source checks and validation from the original chat.

- [Settings UX and save behavior](settings-review-2026-10-10-ux.md)
- [Modes, instructions, skills, and slash commands](settings-review-2026-10-10-modes-prompts.md)
- [Codex alignment, providers, and authority](settings-review-2026-10-10-codex-alignment.md)

Alpha was reviewed in the existing working tree at base commit `b0423c06af2341c89948ec2a68f56ffd3e6f037a`.
There were extensive pre-existing implementation and test changes; those were preserved. Findings describe the current
working files, rather than claiming that every issue belongs to the base commit.

The shared current upstream checkout is pinned to OpenAI Codex commit
[`cc7ba33601286a751477832b01de7b6f8de0dd9c`](https://github.com/openai/codex/commit/cc7ba33601286a751477832b01de7b6f8de0dd9c),
retrieved October 10, 2026. Its public collaboration modes are Default and Plan; keeping Alpha's Code and Plan presentation
is a coherent choice. The upstream TUI clears restored instruction overrides when selecting server-owned mode presets.
See the current
[mode types](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/protocol/src/config_types.rs#L674)
and [TUI mode discovery](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/tui/src/collaboration_modes.rs#L100).

This is a verified native mapping recommendation, not a claim of identical products. Upstream retains some legacy
instruction overrides; it does not universally prohibit customization. Alpha should present its supported subset
truthfully. CLI source and tests were inspected; upstream Rust tests and the live Codex app/IDE UI were not run.

Official [developer settings](https://learn.chatgpt.com/docs/developer-settings#agent-configuration),
[configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic), and
[app settings](https://developers.openai.com/codex/app/settings/) were fetched during the review. They support presenting
common preferences separately from advanced agent configuration and making instruction and configuration scope clear.
They do not justify deleting Alpha's provider-neutral options or replacing its execution protections with Codex's sandbox.

## Priority findings

Severity and action are deliberately separate. High findings affect data integrity, user control, or access to settings.
Medium findings have bounded behavioral or clarity impact. Recommendations to reorganize a working control are advisory.
Detailed evidence, reproducers, confidence, and test limitations are in the three linked reports.

| ID  | Severity / action   | Finding and smallest useful follow-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | High / must-fix     | **Save can overwrite newer settings changed elsewhere.** `SettingsView.tsx:234` deliberately retains the edit buffer, but `:399` sends a full cached settings payload, and `webviewMessageHandler.ts:951` writes every received key. Preserve the edit buffer; save changed keys against an explicit baseline and handle conflicts on externally changed dirty fields.                                                                                                                                     |
| S02 | High / must-fix     | **Slash-command deletion can target a different file from the selected row.** The UI sends source identity at `SlashCommandsSettings.tsx:53`, but `webviewMessageHandler.ts:3245` resolves only by name before unlinking. `commands.ts:156` resolves project before global. Bind deletion to the selected source/file identity and reject a stale target.                                                                                                                                                  |
| S03 | Medium / should-fix | **Reset or import can leave deleted mode overrides in webview state.** `ExtensionStateContext.tsx:220` shallow-merges a complete incoming mode map with the old one; an authoritative empty map cannot clear it. The initial state also seeds built-in prompts at `:505`, so unrelated saves can record built-in defaults as explicit user overrides. Replace authoritative maps, distinguish omission from clearing, and prove that unrelated later saves cannot resurrect overrides.                     |
| S04 | High / must-fix     | **Renaming a provider profile can commit unsaved provider edits.** `SettingsView.tsx:720` sends the draft `apiConfiguration` to the rename operation; `webviewMessageHandler.ts:2074` saves and activates it. Make rename operate on the persisted profile, or explicitly resolve drafts through the existing Save/Discard boundary.                                                                                                                                                                       |
| S05 | High / must-fix     | **Settings section navigation lacks its keyboard behavior.** `common/Tab.tsx:85` puts inactive tabs outside the Tab sequence but implements no arrow-key navigation. Settings uses those controls at `SettingsView.tsx:978`. Use a complete accessible tabs implementation or ordinary keyboard-reachable navigation buttons. Verify both full and compact layouts.                                                                                                                                        |
| S06 | Medium / should-fix | **Changing worktrees in the current window bypasses unsaved-settings protection.** `WorktreesView.tsx:120` directly sends `switchWorktree`; `worktree/handlers.ts:202` invokes `vscode.openFolder` in the same window. Route this operation through the existing dirty-state guard before reloading the window. This is source-traced; a live window-changing reproduction was intentionally not performed.                                                                                                |
| S07 | Medium / should-fix | **The mode editor exposes ineffective behavioral fields.** Plan role and custom-instruction overrides are ignored by `system.ts:423` and `modes.ts:125`; the existing prompt test deliberately enforces this. Saved When-to-use overrides do not reach the canonical catalog in `sections/modes.ts:11`. Remove or clearly disable these editors without weakening Plan's canonical contract.                                                                                                               |
| S08 | Medium / should-fix | **Legacy Code overrides can hide the effective configuration from the editor.** `modes.ts:134` gives a saved custom Code definition precedence over the prompt component, while ModesView presents only the prompt component and built-in defaults. Show the effective source and scope, and provide a deliberate migration path for legacy overrides.                                                                                                                                                     |
| S09 | Medium / should-fix | **Output-token controls disagree with emitted requests.** `OpenAICompatible.tsx:169` displays undefined `includeMaxTokens` as true; `openai.ts:1310` requires explicit true. Both Chat Completions and Responses paths can also emit a negative `-1` limit that the UI describes as server-selected. Normalize inclusion/default semantics and omit the parameter for that sentinel; validate explicit positive limits. Actual server rejection was not tested.                                            |
| S10 | High / must-fix     | **Auto approval copy disagrees with eligible child launches.** `settings.json:261` says Auto asks for sub-agent launches, while the current host admits eligible Auto launches without a dialog. Describe the actual effective policy, including child restrictions; changing copy must not widen authority. This is a consent-description defect, not evidence of a child escaping its parent's policy.                                                                                                   |
| S11 | Medium / should-fix | **Important managed-agent settings are live but not editable in Settings.** Limits, budgets, delegation policy, and role/profile settings are buffered and serialized by SettingsView and used by the host, but have no rendered controls. Expose the supported subset in a coherent Agents/advanced area; do not delete them as dead code.                                                                                                                                                                |
| S12 | Medium / should-fix | **Include task history for enhancement loses speaker and instruction provenance.** `messageEnhancer.ts:109` treats every ask as user speech, treats the initial task's say/text as assistant speech, and omits say/user_feedback corrections. Project canonical user/assistant history with approval and tool messages excluded.                                                                                                                                                                           |
| S13 | Medium / should-fix | **Enhancement previews accept unrelated results.** `PromptsSettings.tsx:47` listens for every enhancedPrompt message without a request identity and can overwrite a newer unsent preview draft. Correlate request/result identities and preserve edits made while a request is outstanding.                                                                                                                                                                                                                |
| S14 | Medium / should-fix | **Skill-derived slash-command rows expose the wrong deletion operation.** The combined list includes skills, but their Delete action still routes to the command-file deletion handler. Preserve capability kind and identity, and use the owning skill operation or hide an unsupported action.                                                                                                                                                                                                           |
| S15 | Medium / should-fix | **Recursive Alpha rules and AGENTS discovery still depend on legacy Roo directories.** `custom-instructions.ts:299` and `:314` derive descendant .alpha/AGENTS directories from discovered .roo directories. Canonical-only descendants can be missed even with subfolder rules enabled. Reconcile advertised optional recursion with scoped, bounded discovery; preserve root-to-cwd AGENTS behavior and legacy compatibility. Codex alignment does not justify mixing unrelated descendant instructions. |
| S16 | Medium / should-fix | **MCP timeout presentation can be stale after external edits.** [McpView.tsx:186](F:/roo-fork/Alpha-Code/webview-ui/src/components/mcp/McpView.tsx:186) initializes timeout state once; the server row retains a stable name/source key and does not resync when server.config changes. Reconcile confirmed host values with a clearly bounded local draft/error state. This is source-confirmed; no live service or rendered-row reproducer was run.                                                      |
| S17 | Medium / should-fix | **The telemetry checkbox advertises a dormant operational feature.** `extension.ts:131` initializes an empty telemetry client list; `TelemetryService.ts:281` defaults to no clients; the webview TelemetryClient discards captures. The preference still has onboarding behavior. Remove or explain the unsupported telemetry surface while preserving saved-setting compatibility.                                                                                                                       |
| S18 | Low / should-fix    | **The worktree empty state masks the actual multi-root limitation.** [worktree/handlers.ts:68](F:/roo-fork/Alpha-Code/src/core/webview/worktree/handlers.ts:68) returns isGitRepo=false and isMultiRoot=true; [WorktreesView.tsx:134](F:/roo-fork/Alpha-Code/webview-ui/src/components/worktrees/WorktreesView.tsx:134) checks not-a-Git-repository first. Check the more specific limitation first or use a discriminated result. A deterministic current-handler fixture confirmed the wrong branch.     |
| S19 | Low / advisory      | **Language is active, but its scope is ambiguous.** The shipped interface has English resources, while `custom-instructions.ts:700` uses the preference as model response language. Rename/explain it as response language; do not classify it as unused merely because UI translations were retired.                                                                                                                                                                                                      |

These findings map to the detailed ledgers as follows: S01/S04/S05/S06/S17/S19 correspond to
UX-01/02/03/06/14/16; S02/S03/S07/S08/S12/S13/S14/S15 correspond to
MP-01/02/05+09/06/03/04/08/07; S09/S10/S11 correspond to F3/F1/F5. F2 independently corroborates S04.
S16 and S18 are additional checks by the original chat. The aggregate uses the stronger independently reproduced
impact assessment for profile renaming; the provider report alone rated its source trace Medium.

## Additional confirmed behavior and stale implementation

The following are separate bounded findings, rather than reasons to remove their otherwise active features.

| ID  | Severity / action   | Finding and smallest useful follow-up                                                                                                                                                                                                                                                                                                                                                                   | Detailed evidence                                                          |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S20 | Medium / must-fix   | **Save marks the form clean before persistence succeeds.** `SettingsView.tsx:478` dispatches independent writes, then `:492` clears dirty state without an acknowledgement. A failure can leave partial settings while Done permits exit. Correlate Save with success/failure and keep pending/dirty state until the authoritative result.                                                              | UX-04; actual component and injected host-write failure probes             |
| S21 | Medium / should-fix | **An external profile change discards unrelated global drafts.** `SettingsView.tsx:251` reseeds the whole buffer when the active name changes, bypassing user discard consent. Preserve global dirty fields and distinguish acknowledged profile actions from unsolicited refreshes.                                                                                                                    | UX-05; mounted component probe                                             |
| S22 | Medium / should-fix | **Enabling custom tools in the draft triggers executable module loading before Save.** `CustomToolsSettings.tsx:39` requests refresh as soon as its buffered prop changes; module imports execute initialization. Use committed enablement or a clearly explicit immediate action. Outer trust guards were not exhaustively audited, so this is a Save/Discard defect, not a confirmed security bypass. | UX-07; complete source trace, no arbitrary module executed                 |
| S23 | Medium / should-fix | **Custom-tool Refresh retains deleted tools and hides failed imports.** `custom-tool-registry.ts:57` adds to its old map; `webviewMessageHandler.ts:2026` ignores the load failure collection. Reconcile a scoped snapshot atomically and show partial failures, preserving descriptors for admitted calls.                                                                                             | UX-08; fake-filesystem registry and host probes                            |
| S24 | Medium / should-fix | **Custom-tool copy advertises an unsupported global path and automatic approval.** The effective global root is `~/.roo/tools`, while copy advertises `~/.alpha/tools`; canonical execution still asks through policy. Show effective roots and approval behavior. Adding a new root requires a deliberate compatibility change.                                                                        | UX-09; directory-function probe and policy source trace                    |
| S25 | Medium / should-fix | **Settings search omits many controls and keeps hidden conditional targets.** Search indexing retains unmounted registrations; selecting some results has no target. Separate complete search metadata from availability, and navigate to the enabling control when a child is hidden.                                                                                                                  | UX-10; registry/notification component probe and inventory                 |
| S26 | Medium / should-fix | **Search and several real sliders have no accessible name.** Associate labels or explicit ARIA names; connect search's popup/focus state with its semantics. The shared components support names, but callers omit them.                                                                                                                                                                                | UX-11; actual search and Radix notification probes, adjacent source traces |
| S27 | Medium / should-fix | **Checkpoint timeout text and thumb diverge after resync.** `CheckpointSettings.tsx:72` uses `defaultValue`; a 10-to-20 prop update changes the label while the thumb remains 10. Control the slider from the cached value.                                                                                                                                                                             | UX-12; actual component/Radix rerender probe                               |
| S28 | Medium / should-fix | **Enter preference copy understates supported send shortcuts.** It says the primary modifier is required, but Shift+Enter also sends in newline mode. Correct the copy or deliberately specify a compatibility change, rather than changing runtime accidentally.                                                                                                                                       | UX-13; current source and focused existing shortcut test                   |
| S29 | Low / advisory      | **Reverting to the saved value still leaves settings dirty.** Dirty state is latched against the previous draft rather than derived from the accepted baseline. Normalize and compare against that baseline; this also reduces unnecessary full-snapshot saves.                                                                                                                                         | UX-15; callback/mounted component probes                                   |
| S30 | Medium / should-fix | **Temperature is editable on request paths that ignore it.** VS Code LM and native OpenAI Responses routes do not consume the saved value, despite an editor that can remain visible. Gate by effective route and model capabilities; keep supported provider paths.                                                                                                                                    | F4; source-confirmed, no integrated UI-to-request reproducer               |
| S31 | Medium / should-fix | **Full Access overrides an editable MCP approval checkbox.** Unchecking `alwaysAllowMcp` cannot restore prompts because Bypass forces the effective grant. Disable/hide the overridden editor and display the effective policy.                                                                                                                                                                         | F6; current UI/policy trace and passing Bypass contract test               |
| S32 | Low / advisory      | **Verbosity has saved/helper plumbing without a provider request consumer.** An imported capability flag can reveal an ineffective editor. Stop advertising unsupported transport capability, or implement the supported route with request-level coverage; keep old values readable.                                                                                                                   | F7; source inventory, no end-to-end reproducer                             |
| S33 | Low / advisory      | **The former AutoApproveToggle is test-only residue.** It has no production caller and is not a stale visible control. Remove private residue after a full import audit; retain deprecated mode-switch fields as import/read compatibility data.                                                                                                                                                        | F8; static caller/consumer inventory                                       |

Additional scope advisories are recorded as A1–A3 in the Codex/provider report: a task reasoning selection is also
remembered for new tasks; Error & Repetition Limit is captured at task construction; Max Count/Max Cost are resettable
continuation checkpoints based on reported usage, not hard cumulative tree budgets. Label these scopes and units clearly.
The modes report also recommends source/override badges for skills and a measured investigation of large skill catalogs;
no catalog performance defect was established. Old full-system-prompt preview/copy handlers are compatibility-cleanup
candidates with no current webview caller found, not evidence that the active prompt generator is unused.

## Mode fields: what is stale and what still works

| Control                          | Current behavior                                                                       | Recommendation                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Code role definition             | Active user instruction when a legacy custom Code definition does not take precedence  | Keep as advanced additive customization; show effective provenance.                |
| Code custom instructions         | Active user instruction under the same precedence condition                            | Keep; clarify scope and that it cannot grant tools or approvals.                   |
| Plan role definition             | Stored, but ignored by the canonical runtime prompt                                    | Remove/disable the ineffective editor; preserve readers for old data.              |
| Plan custom instructions         | Stored, but ignored by the canonical runtime prompt                                    | Remove/disable; keep global/project guidance separate from Plan's contract.        |
| Short description, Code and Plan | Active text in the chat ModeSelector; independently verified                           | Keep if useful, or simplify as presentation-only metadata. It is not a dead field. |
| When to use, Code and Plan       | Saved/export-compatible metadata with no current effect on the canonical model catalog | Retire the normal editor; preserve historical records and compatibility readers.   |
| Global custom instructions       | Active user guidance across workflows                                                  | Give this a clear Personalization/Instructions location and scope description.     |

The mode page should not imply that users are replacing a whole system prompt. Code/global customizations are scoped
instruction parts; host policy remains the authority. Repository AGENTS.md and Alpha rule files remain meaningful sources.

## Controls to preserve and organization advice

Provider selection, profiles, model capabilities, reasoning controls, execution approval, compaction, skills, MCP,
terminal integration, checkpoints, worktrees, notifications, and task concurrency all have live consumers. The ten
support prompt templates also have current consumers, including enhancement, context condensation, editor actions,
terminal actions, and New Task. Their existence alone is not evidence of stale UX.

A coherent next organization would make these responsibilities obvious:

| Area                             | Responsibility                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Models and providers             | Provider profiles, model/reasoning selection, supported request options; advanced gateway fields remain available.   |
| Permissions                      | Effective Ask/Auto/Full Access policy and bounded exceptions, independent of model choice.                           |
| Personalization and instructions | Global/project guidance and any supported mode-specific additions; show source, scope, and when changes take effect. |
| Agents                           | Supported child roles, delegation choices, concurrency, timeouts, and budgets.                                       |
| Capabilities and workflows       | Skills, slash commands, MCP, and custom tools with correct capability identity and scope.                            |
| Context and advanced runtime     | Compaction and its template, terminal integration, checkpoints, and other justified advanced controls.               |
| General and workspace            | Input behavior, notifications, response language, worktrees, and presentation preferences.                           |

Prompt templates can be named more precisely and placed in an advanced area. The condensation template already belongs
with Context Management. Worktree and MCP management actions are immediate operations, while some adjacent preferences
are Save-backed; the UI should identify that distinction explicitly.

## Coverage and validation

All sixteen SettingsView sections were inventoried: providers, modes, skills, slash commands, auto-approval, MCP,
checkpoints, notifications, context management, terminal, prompts, worktrees, UI, experiments, language, and About.
The review also followed relevant host message handlers, typed settings, persistence, prompt composition, provider
request options, policy consumers, compatibility readers, and nearby tests. The linked reports contain the section
inventories and additional bounded UX findings.

The original chat independently ran:

| Command / check                                                                                                | Actual result                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --dir src test core/prompts/__tests__/system-prompt.spec.ts`                                             | 53 tests passed, including canonical Plan behavior despite saved overrides.                                                                                                          |
| `pnpm --dir webview-ui test src/components/chat/__tests__/ModeSelector.spec.tsx`                               | 7 tests passed, including a custom short-description display.                                                                                                                        |
| Current handleListWorktrees, transpiled with TypeScript and executed with two mocked VS Code workspace folders | Returned isMultiRoot=true and isGitRepo=false; the current view condition order chooses notGitRepo before the specific multi-root message. No live host or React render was claimed. |
| Development tools                                                                                              | Node 24.21.0 and pnpm 11.24.0 were checked.                                                                                                                                          |

Existing passing tests characterize current behavior; they do not mean the reported defects are already covered by
regression tests. The reviewer reports distinguish passing baseline tests from deterministic defect reproductions.

The three review chats additionally recorded the following executed checks. These counts describe test executions,
not unique tests: some reviewers intentionally ran overlapping suites.

| Review                  | Actual passing executions | Main coverage and limits                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX/state chat           | 95                        | Settings/profile buffer, context/terminal controls, UI/copy, and a focused Enter shortcut. Separate component/host probes reproduced Save, Rename, profile refresh, accessibility, search, checkpoint, custom-tool, and telemetry findings.                          |
| Modes/instructions chat | 318                       | Mode recovery/authority, prompt templates, condensation isolation, scoped rules, command discovery, and skill identity/invocation. Seven documented deterministic boundary reproducers cover the new defects; current passing tests miss several integration chains. |
| Codex/provider chat     | 159                       | Approval/MCP/child launch contracts, managed-setting normalization, provider/profile UI, and output-token inclusion. Most capability mismatches remain source-confirmed rather than fully integrated reproductions.                                                  |

Exact commands, skipped selections, fixture/mock boundaries, and negative coverage are recorded in the linked reports.
No new regression test was authored as part of this review.

Document QA rendered all four reports in memory with the existing React Markdown/GFM stack, checked 284 local source
anchors for file existence and valid line bounds, verified the three linked reports, and found no trailing whitespace.
All four reports passed the focused Prettier check. This verifies document structure and anchors, not live Alpha visuals.

No live VS Code 1.125.0 visual/keyboard session, full settings E2E flow, paid model request, or live MCP service operation
was exercised. The exact-host smoke gate, package builds, typechecks, and certification gates were not run for this
documentation-only review. They remain required as appropriate when the recommended behavior changes are implemented.
No speed or quality improvement is claimed from this review.

## Closure and recommended follow-up

- **Fixed now:** no implementation changes; only review documents were created.
- **Flagged for follow-up:** the findings above and the additional UX details in the linked reports.
- **Not verified:** live host layouts, screen-reader interaction, external provider/service behavior, and exact-host end-to-end fixes.
- **Out of scope:** replacing Alpha's runtime or sandbox, removing its first-class capabilities, migrating the VS Code baseline,
  and broadly deleting historical settings/data.

Start with narrow correctness fixes for source-specific deletion and conflict-safe, acknowledged Save/profile
operations. Repair authoritative map replacement and loss of global drafts during external profile changes.
Reconcile mode editors, model options, and approval descriptions with their actual consumers. Accessible navigation
is also a release-quality priority; broader scope-aware reorganization can follow after correctness fixes, verified
in the exact VS Code 1.125.0 host.

Each implementation pass should preserve historical records, add focused regression coverage for the actual invariant,
and use the existing owning layers. A follow-up contract-alignment review should specifically recheck Save/Discard/reset,
mode instruction provenance, and source-specific capability actions after those changes.
