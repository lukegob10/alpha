# Settings review: modes, prompts, rules, skills, and slash commands

Review date: October 10, 2026, America/New_York. This is a review-only report. No production code, tests, configuration, lockfiles, or commits were changed. This report is the only file created by this chat.

The inspected checkout was `b0423c06af2341c89948ec2a68f56ffd3e6f037a` plus its existing, extensively modified working tree. Source anchors describe that working tree, not an assertion that the findings occur in an unmodified release. Existing changes were preserved. The root engineering guide was read; no nested `AGENTS.md` or `AGENTS.override.md` was found in the inspected source tree.

Exactly **two sub-agents** were launched in this chat: `modes_authority` reviewed mode selection, prompt overrides, migration, and executable authority; `prompt_skills` reviewed prompt composition, rules, skills, and slash-command management. The primary reviewer covered support prompts, enhancement, condensation, and cross-surface integration. No further chats or sub-agents were created here.

## Findings

| ID    | Severity / disposition | Finding                                                                                   | Classification                                         |
| ----- | ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| MP-01 | High / must-fix        | Command deletion resolves by name and can delete a different source than the selected row | Active but buggy                                       |
| MP-02 | Medium / should-fix    | Prompt-map hydration resurrects reset overrides and seeds defaults as customizations      | Active but buggy                                       |
| MP-03 | Medium / should-fix    | Enhancement history invents user roles and drops actual user corrections                  | Active but buggy                                       |
| MP-04 | Medium / should-fix    | Enhancement preview accepts unrelated responses and overwrites its draft                  | Active but buggy                                       |
| MP-05 | Medium / should-fix    | Plan offers role/instruction editors whose values runtime deliberately ignores            | Active but confusing UI; healthy authority restriction |
| MP-06 | Medium / should-fix    | A saved custom Code definition silently supersedes the settings prompt editor             | Active but confusing                                   |
| MP-07 | Medium / should-fix    | Recursive rules discovery omits standalone `.alpha` and AGENTS descendants                | Active but buggy                                       |
| MP-08 | Medium / should-fix    | Skills appear as deletable command rows but use a command-only deletion handler           | Active but buggy                                       |
| MP-09 | Low / should-fix       | Editable “When to Use” values have no current chat execution consumer                     | Dormant customization; compatibility consumers remain  |

Severity reflects observable impact, not the amount of code needed to fix it. All nine findings have high confidence at the cited source or deterministic boundary. Full live UI/extension-host reproductions were not performed.

### MP-01 — Command deletion does not preserve the selected identity

**Trigger and impact.** Open Delete for a global command. While its confirmation dialog remains open, a project command with the same name appears. Confirming the global deletion now resolves the project command and unlinks that different file. The source supplied by the UI is checked for presence but never used for resolution. This is unintended deletion of user-authored content.

**Trace.** [SlashCommandsSettings.tsx:48](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/SlashCommandsSettings.tsx:48) retains the selected row and sends its name plus `values.source`. [webviewMessageHandler.ts:3245](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:3245) calls `getCommand(cwd, name)` and then `fs.unlink(command.filePath)`. [commands.ts:156](F:/roo-fork/Alpha-Code/src/services/command/commands.ts:156) resolves project `.alpha`, project legacy `.roo`, then global `.roo` before built-in fallback. The requested source is absent from this lookup.

**Evidence.** A deterministic execution of the unchanged handler case with mocked filesystem operations confirmed a `source: "global"` request unlinked `F:/review-fixture/.alpha/commands/shared-name.md` when name resolution returned the project definition. No real file was deleted. This proves the handler boundary; the stale-dialog trigger is the source-traced integration scenario.

**Smallest follow-up.** Carry resource kind and stable selected identity through the wire contract. Resolve and validate that identity in the requested trusted scope, then reject a stale target instead of falling through to a higher-priority command. A raw frontend path alone must not become authority. Add coverage for same-name source changes between discovery, confirmation, and deletion, and for a target removed before confirmation.

### MP-02 — Authoritative prompt-map replacement is treated as an incremental merge

**Triggers and impact.** Reset the last field of a Code override, Save, and reopen settings: the previous override can return. A later unrelated Save can persist it again. Separately, a fresh host with no explicit overrides hydrates the webview with built-in prompt copies; an unrelated Save persists these as customizations. That pins old defaults and changes their recorded instruction provenance.

**Trace.** [ModesView.tsx:46](F:/roo-fork/Alpha-Code/webview-ui/src/components/modes/ModesView.tsx:46) deletes an empty mode entry after its last field is reset. [SettingsView.tsx:472](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/SettingsView.tsx:472) sends the replacement map. [webviewMessageHandler.ts:1046](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:1046) persists it through [ContextProxy.ts:324](F:/roo-fork/Alpha-Code/src/core/config/ContextProxy.ts:324), and [AlphaProvider.ts:4365](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:4365) projects the authoritative map. However, [ExtensionStateContext.tsx:220](F:/roo-fork/Alpha-Code/webview-ui/src/context/ExtensionStateContext.tsx:220) spreads the new map over the previous map, so `{}` cannot delete old entries.

The same context initializes `customModePrompts` with `defaultPrompts` at [ExtensionStateContext.tsx:505](F:/roo-fork/Alpha-Code/webview-ui/src/context/ExtensionStateContext.tsx:505). Settings copies that state into its edit buffer at [SettingsView.tsx:157](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/SettingsView.tsx:157). Once saved, [system.ts:110](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:110), [system.ts:267](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:267), and [system.ts:283](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:283) recognize the copied Code component as user-defined; [custom-instructions.ts:727](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:727) assigns customized mode instructions user authority. This does not widen executable permission.

**Evidence.** Unchanged-function Node/TypeScript boundary scripts confirmed both old-entry retention on an empty authoritative payload and default seeding on empty-host hydration. Existing ModesView tests exercise local editing/reset but do not cover this complete hydration/persistence chain. A full React Save-to-provider reproduction was not run.

**Smallest follow-up.** Initialize the explicit override map to `{}`; replace it when an authoritative map is supplied. Keep built-in fallback in display/effective-selection helpers. Test clearing the last override, replacement imports, reopening after reset, and saving an unrelated setting when no override exists. Any repair of previously seeded records needs an explicit, backward-compatible distinction from real user customization.

### MP-03 — Enhancement context uses UI message types as conversation roles

**Trigger and impact.** Enable “Include task history” and enhance after a user correction or tool approval. The original task can be labeled Assistant, assistant-generated approval requests become User, and actual human corrections disappear. The enhancement model receives misleading context, including omission of constraints such as “Do not modify production files.”

**Trace.** The buffered checkbox is rendered at [PromptsSettings.tsx:196](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/PromptsSettings.tsx:196), saved at [SettingsView.tsx:463](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/SettingsView.tsx:463), typed at [global-settings.ts:254](F:/roo-fork/Alpha-Code/packages/types/src/global-settings.ts:254), and read by [webviewMessageHandler.ts:1853](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:1853). That handler passes the current task's `clineMessages` to `MessageEnhancer`.

[messageEnhancer.ts:101](F:/roo-fork/Alpha-Code/src/core/webview/messageEnhancer.ts:101) labels every textual `ask` as User and every `say: text` as Assistant while excluding `say: user_feedback`. In contrast, [Task.ts:9446](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:9446) emits the initial user task as `say: text`; [Task.ts:10798](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:10798) records human feedback as `say: user_feedback`; and [WriteToFileTool.ts:144](F:/roo-fork/Alpha-Code/src/core/tools/WriteToFileTool.ts:144) creates an assistant tool approval using `ask: tool`. The current 10-message/500-character bounds are useful but do not preserve roles.

**Evidence.** A deterministic invocation of the actual public `MessageEnhancer.enhanceMessage` path, with only completion/telemetry dependencies stubbed, captured the generated prompt and confirmed all three errors. No model or network call was made. The existing message-enhancer suite passed, but its user-history fixtures use `type: "ask"` as a fabricated user turn and therefore miss the production representation.

**Smallest follow-up.** Use canonical role-bearing history or an explicit UI-to-conversation projection that recognizes the original task, actual human-origin feedback, and assistant approval messages. Preserve context limits. Add real message-shape regression fixtures, including auto-generated feedback that must not be mislabeled as human input.

### MP-04 — Settings preview consumes any enhancement result

**Trigger and impact.** Start enhancement in the chat composer, open Settings → Prompts, and enter a preview draft while the composer request is pending. Its response overwrites the preview draft even though the preview never requested enhancement. Overlapping requests can also deliver the wrong result to a waiting consumer.

**Trace.** [PromptsSettings.tsx:47](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/PromptsSettings.tsx:47) accepts any `enhancedPrompt` message and writes its text without checking a pending preview request. [PromptsSettings.tsx:86](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/PromptsSettings.tsx:86) sends requests without correlation. The composer uses the same message type at [ChatTextArea.tsx:169](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/ChatTextArea.tsx:169). [App.tsx:288](F:/roo-fork/Alpha-Code/webview-ui/src/App.tsx:288) keeps ChatView mounted while Settings is shown. Host replies at [webviewMessageHandler.ts:1890](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:1890) carry no requester or request ID; [vscode-extension-host.ts:998](F:/roo-fork/Alpha-Code/packages/types/src/vscode-extension-host.ts:998) defines preview options without correlation either.

**Evidence.** An isolated execution of the unchanged PromptsSettings component with mocked hooks and event registration confirmed an unrelated reply replaces an unsent draft while `isEnhancing` is false and no request was sent. This is a component/event-boundary reproduction, not a rendered browser interaction. Existing buffering tests passed; they do not cover reply ownership.

**Smallest follow-up.** Add a request ID/requester and echo it on success and failure. Both consumers should ignore unsolicited, unrelated, and stale replies. Protect edits made after dispatch. Keep the useful existing behavior where Preview sends the buffered template/profile/history options without saving them.

### MP-05 — Plan role and instruction editors promise an unsupported effect

**Trigger and impact.** Select Plan in Mode setup, edit Role Definition or Mode-specific Custom Instructions, then Save. The values persist, but the Plan agent ignores them. This is misleading customization UI, not a reason to weaken Plan.

**Trace.** [ModesView.tsx:127](F:/roo-fork/Alpha-Code/webview-ui/src/components/modes/ModesView.tsx:127) and [ModesView.tsx:183](F:/roo-fork/Alpha-Code/webview-ui/src/components/modes/ModesView.tsx:183) render these editors for either mode, sharing the buffered/persisted map described above. [system.ts:422](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:422) deliberately selects no custom Plan prompt component. [modes.ts:125](F:/roo-fork/Alpha-Code/src/shared/modes.ts:125) likewise returns canonical Plan guidance regardless of supplied prompt/custom-mode definitions.

**Evidence.** Existing `modes.spec.ts` and system-prompt tests explicitly confirm Plan overrides are inert. An unchanged-function boundary reproducer confirmed this behavior. The source restriction is intentional and healthy.

**Smallest follow-up.** Hide these unsupported Plan editors or show current guidance read-only. Preserve historical saved values without granting authority. Global instructions and Plan-specific rules remain active user-instruction surfaces. Plan's **Description is active** in the human-facing selector and should remain available.

### MP-06 — Effective custom Code configuration is hidden from its editor

**Trigger and impact.** A retained global/project custom mode definition uses `slug: "code"`. Editing Code role or instructions in Settings saves values that runtime does not use, because the file-backed/custom definition wins entirely. The editor displays built-in fallback rather than explaining the effective source.

**Trace.** [ModesView.tsx:28](F:/roo-fork/Alpha-Code/webview-ui/src/components/modes/ModesView.tsx:28) uses built-in fallback functions without receiving effective custom definitions. [modes.ts:134](F:/roo-fork/Alpha-Code/src/shared/modes.ts:134) resolves a matching custom definition first and returns its role/instructions entirely. [AlphaProvider.ts:4454](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:4454) supplies the current custom-mode state to runtime. [CustomModesManager.ts:294](F:/roo-fork/Alpha-Code/src/core/config/CustomModesManager.ts:294) retains project-over-global configuration precedence.

**Evidence.** Existing [modes.spec.ts:583](F:/roo-fork/Alpha-Code/src/shared/__tests__/modes.spec.ts:583) covers custom-mode precedence and passed. The unchanged-function reproducer confirmed a custom Code role supersedes an edited prompt component. This finding is conditional on a retained/custom Code definition; ordinary Code component edits are active.

**Smallest follow-up.** Display the effective configuration and its source, and disable fields that cannot apply, or adopt one explicitly reviewed customization precedence. Preserve compatible readers and user files while deciding that policy.

### MP-07 — Recursive discovery is driven by legacy `.roo` paths

**Trigger and impact.** Enable recursive/subfolder rules for a workspace containing a descendant `.alpha/rules/instructions.md` or descendant `AGENTS.md`, but no descendant `.roo` directory. The setting's advertised descendants are omitted. A legacy `.roo` marker can cause the corresponding `.alpha` directory and AGENTS scope to appear.

**Trace.** The buffered control is at [ContextManagementSettings.tsx:210](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/ContextManagementSettings.tsx:210); [settings.json:633](F:/roo-fork/Alpha-Code/webview-ui/src/i18n/locales/en/settings.json:633) advertises recursive `.alpha/rules` and AGENTS discovery. [config-paths/index.ts:260](F:/roo-fork/Alpha-Code/src/services/config-paths/index.ts:260) searches `**/.roo/**` and extracts only `.roo` directories. [custom-instructions.ts:299](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:299) derives descendant `.alpha` paths from those legacy parents; [custom-instructions.ts:314](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:314) derives descendant AGENTS directories from the same list.

**Evidence.** A deterministic execution of the unchanged discovery/capture functions with a mocked read-only search demonstrated the omission and the legacy-marker dependency. Existing project-discovery tests passed; they do not cover standalone canonical descendants.

**Smallest follow-up.** Decide the intended optional recursive scope, then either implement the advertised canonical discovery with bounded, scope-safe traversal or correct the control's promise. Preserve Alpha's path protections. Root-to-cwd AGENTS discovery is independently active and healthy; do not indiscriminately combine unrelated descendant AGENTS in an attempt to match Codex, which uses scoped root-to-cwd discovery.

### MP-08 — Skill aliases are offered command deletion

**Trigger and impact.** A project/global skill with no same-name command appears in Slash Commands. Delete is offered, but confirmation produces command-not-found and leaves the skill unchanged.

**Trace.** [webviewMessageHandler.ts:204](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:204) merges mode-enabled skills into the command list using name/source/path without a resource-kind discriminator. [SlashCommandsSettings.tsx:128](F:/roo-fork/Alpha-Code/webview-ui/src/components/settings/SlashCommandsSettings.tsx:128) offers deletion for every non-built-in row. The handler at [webviewMessageHandler.ts:3245](F:/roo-fork/Alpha-Code/src/core/webview/webviewMessageHandler.ts:3245) uses command-only lookup, never the skills manager. Discovery intentionally deduplicates same-name commands ahead of skills, but that does not make a skill row a command resource.

**Evidence.** The unchanged-handler deterministic script confirmed a skill-only name takes the command-not-found path with no unlink. Existing discovery tests passed; they establish unified completion rows, not valid management dispatch.

**Smallest follow-up.** Give discovered rows a typed resource kind and stable identity. Route skill management to its owning skill operation or provide a link to Skills and omit command deletion for these aliases. Consolidate this wire-contract repair with MP-01 while retaining the two distinct regression scenarios.

### MP-09 — “When to Use” is editable but not applied to chat execution

**Trigger and impact.** Edit this field for either Code or Plan and Save. The live system-mode catalog continues to use the built-in text. Users can reasonably infer that the saved explanation changes the agent's mode guidance, but it does not.

**Trace.** [ModesView.tsx:164](F:/roo-fork/Alpha-Code/webview-ui/src/components/modes/ModesView.tsx:164) exposes the field. [sections/modes.ts:7](F:/roo-fork/Alpha-Code/src/core/prompts/sections/modes.ts:7) ignores captured overrides and renders built-in `whenToUse`; [system.ts:229](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:229) uses that catalog. Role/instruction selection does not consume the field. Compatibility/export code still reads it at [CustomModesManager.ts:812](F:/roo-fork/Alpha-Code/src/core/config/CustomModesManager.ts:812), and legacy helpers remain at [modes.ts:183](F:/roo-fork/Alpha-Code/src/shared/modes.ts:183).

**Evidence.** Source call-site tracing and execution of unchanged `getModesSection` confirmed a unique custom marker is absent. This is a dormant **chat customization**, not a claim that the property is globally dead.

**Smallest follow-up.** Retire the editor or make the canonical explanation read-only while retaining saved/export compatibility. Do not reintroduce model-controlled mode changes to give this field a consumer.

## Complete owned-surface inventory and disposition

The settings inputs examined here use SettingsView's local `cachedState` edit buffer. Support-prompt preview sends explicit buffered options. Reading profile lists or available mode metadata from extension state is not itself a violation of that form-buffer invariant. MP-02 is a separate authoritative-map hydration problem.

| Surface/control                                          | Current flow and classification                                                                                        | Recommendation                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Mode setup Code/Plan buttons                             | Editor selection only; does not change the active task. Active and useful                                              | Keep                                                                    |
| Chat selector / Shift+Tab                                | Human mode choice routed to host lifecycle transitions; two executable modes. Active and useful                        | Keep                                                                    |
| Code Role Definition                                     | Buffered map → saved state → captured Code prompt component → user instruction part. Active and useful except MP-02/06 | Keep; label its component scope clearly                                 |
| Code Mode-specific Custom Instructions                   | Same path; customized guidance has user authority. Active and useful except MP-02/06                                   | Keep; describe as Code instructions                                     |
| Plan Role Definition / Mode-specific Custom Instructions | Buffered and saved, intentionally ignored by effective Plan runtime. Active but confusing                              | Hide or read-only, MP-05                                                |
| Code and Plan Description                                | Buffered map → ModeSelector override → displayed selector caption. Active and useful for both modes                    | Keep; clarify human-facing purpose                                      |
| Code and Plan When to Use                                | Saved, but built-in catalog wins in chat. Export compatibility remains                                                 | Retire editor or read-only, MP-09                                       |
| Per-field mode Reset                                     | Deletes explicit field/last map entry locally. Active but buggy on hydration                                           | Keep after MP-02                                                        |
| Global Custom Instructions                               | Buffered string → `customInstructions` → user instruction parts for either mode                                        | Keep; consider grouping under Instructions                              |
| Retained custom Code definitions                         | Project/global compatibility configuration can supersede component edits                                               | Preserve readers; disclose precedence, MP-06                            |
| Retired/unknown saved modes                              | Historical records readable; restore to Plan. Missing/empty legacy mode retains Code fallback                          | Preserve conservative recovery                                          |
| Prompts template selector                                | Nine live support types; CONDENSE is intentionally edited in Context Management                                        | Keep; group by action/context                                           |
| Template text and Reset                                  | `customSupportPrompts` buffered map → host storage → support-prompt lookup; `${...}` substitution                      | Keep; make supported variables discoverable                             |
| Enhancement API configuration                            | Current task configuration or named saved profile; available profile checked before use                                | Keep as optional advanced control                                       |
| Include task history in enhancement                      | Saved boolean; bounded UI-history extraction is active but loses roles                                                 | Keep after MP-03                                                        |
| Enhancement Preview draft/button                         | Sends buffered ENHANCE template/profile/history without persisting; uncorrelated result listener                       | Keep after MP-04                                                        |
| CONDENSE custom template and Reset                       | Same prompt map; manual and auto condensation use it in a tool-free summarization request                              | Keep as optional advanced customization                                 |
| Legacy `customCondensingPrompt`                          | Startup migration moves genuine customization to `customSupportPrompts.CONDENSE`; no second current editor             | Preserve migration; avoid duplicate UI                                  |
| `.alpha/rules` and per-mode rule directories             | Personal/project instruction files read into user parts; legacy `.roo`/older file readers remain                       | Keep canonical files and compatible readers                             |
| Root-to-cwd AGENTS / AGENTS.override                     | Scoped discovery, preferred file selection, project byte budget. Active and useful                                     | Keep                                                                    |
| `AGENTS.local.md` personal addenda                       | Separate active local instruction reader                                                                               | Keep with clearly documented scope/provenance                           |
| VS Code `useAgentRules` setting                          | Native manifest setting read by task prompt generation; independent of recursive checkbox                              | Keep; explain where configured                                          |
| Enable subfolder rules                                   | Buffered flag changes optional descendant capture; canonical-only descendants omitted                                  | Keep only with accurate behavior/copy, MP-07                            |
| Skills built-in toggles                                  | Settings buffer controls built-in inclusion; defaults stay inspectable                                                 | Keep                                                                    |
| Skills project/global Create/Edit/Delete                 | File-backed resource management, source/mode identity, skill owning handlers                                           | Keep; retain stable identity work already in the working tree           |
| Skills mode filters and catalog                          | Task/mode-scoped catalog; actual enabled skill invocation and frozen child digest                                      | Keep; show effective source/mode                                        |
| Slash Commands list, file edit/open, Create              | Command discovery and file-backed prompts; includes skill completion aliases                                           | Keep; distinguish commands from skills                                  |
| Slash Commands Delete                                    | Name-only handler loses selected identity and cannot delete skill resources                                            | Repair together, MP-01/08                                               |
| Old full-system-prompt preview/copy handlers             | Host helpers still exist; no current production webview caller found                                                   | Dormant compatibility candidate; retire separately after consumer audit |
| Old wholesale system-prompt-file override                | No current live loader found in the inspected runtime                                                                  | Do not treat historical documentation as a current authority defect     |

Both mode descriptions are confirmed live at [ModeSelector.tsx:65](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/ModeSelector.tsx:65) and [ModeSelector.tsx:193](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/ModeSelector.tsx:193), with the map supplied by [ChatTextArea.tsx:1553](F:/roo-fork/Alpha-Code/webview-ui/src/components/chat/ChatTextArea.tsx:1553). Existing ModeSelector coverage validates this override. It should not be classified as dead because it is absent from the model's role definition.

### Skills, rules, and command details that affect effective behavior

Skill authoring is active and writes portable `.agents/skills` with structured frontmatter at [SkillsManager.ts:510](F:/roo-fork/Alpha-Code/src/services/skills/SkillsManager.ts:510). Discovery supports portable and native `.alpha` roots at [SkillsManager.ts:721](F:/roo-fork/Alpha-Code/src/services/skills/SkillsManager.ts:721). Resolution is project over global over built-in, with mode-specific variants at [SkillsManager.ts:247](F:/roo-fork/Alpha-Code/src/services/skills/SkillsManager.ts:247). Non-built-in mode membership is live through [skillsMessageHandler.ts:163](F:/roo-fork/Alpha-Code/src/core/webview/skillsMessageHandler.ts:163); an explicit empty membership list means Any and supersedes directory-mode inheritance. Create/edit/delete/mode configuration are immediate file operations; built-in enable preferences use the Settings Save buffer. That distinction should be clear in the interface.

Built-in inspection remains protected: [skillsMessageHandler.ts:229](F:/roo-fork/Alpha-Code/src/core/webview/skillsMessageHandler.ts:229) opens a read-only virtual inspection document. Writable variants use the skill editability checks and exact source/path/mode identity in the existing working tree. Task managers are workspace-scoped at [AlphaProvider.ts:4789](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:4789); [SkillsManager.ts:820](F:/roo-fork/Alpha-Code/src/services/skills/SkillsManager.ts:820) owns watchers and [SkillsManager.ts:859](F:/roo-fork/Alpha-Code/src/services/skills/SkillsManager.ts:859) disposes them. Watcher behavior was source-reviewed, not verified in a live host.

Automatic skill exposure differs by mode. [system.ts:230](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:230) omits the automatic catalog in Plan, and the Plan tool policy excludes model `skill`/`run_slash_command` execution. However, human `/skill-name` invocation resolves against current mode through [mentions/index.ts:187](F:/roo-fork/Alpha-Code/src/core/mentions/index.ts:187) and injects selected instructions at [mentions/index.ts:324](F:/roo-fork/Alpha-Code/src/core/mentions/index.ts:324). Plan membership is therefore **not wholly ineffective**. [SkillTool.ts:50](F:/roo-fork/Alpha-Code/src/core/tools/SkillTool.ts:50) preserves sticky task mode, approval, frozen child catalog/path/digest checks, and the selected-skill receipt. [skillInvocation.ts:37](F:/roo-fork/Alpha-Code/src/services/skills/skillInvocation.ts:37) carries file/base-directory provenance.

User slash invocation remains active independently of the experiment that exposes model `run_slash_command`; see [filter-tools-for-mode.ts:265](F:/roo-fork/Alpha-Code/src/core/prompts/tools/filter-tools-for-mode.ts:265). [RunSlashCommandTool.ts:57](F:/roo-fork/Alpha-Code/src/core/tools/RunSlashCommandTool.ts:57) can resolve skills as a fallback. Human `/plan` parsing at [mentions/index.ts:168](F:/roo-fork/Alpha-Code/src/core/mentions/index.ts:168) is a host mode operation and protects the remainder from recursive command parsing. Legacy command files and ordinary completion should remain compatible when management identity is repaired.

Standard AGENTS file precedence is explicit at [custom-instructions.ts:430](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:430): preferred override, standard AGENTS, then compatible AGENT fallback. Existing coverage deliberately verifies that an empty existing override suppresses a standard file; current upstream source agrees. Personal [AGENTS.local.md loading](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:471) is an additive Alpha capability outside the standard project byte budget. Alpha stores personal guidance in its global instructions and native rule files; this review does not imply it reads Codex's `~/.codex/AGENTS.md`. Child instruction-source capture is live at [custom-instructions.ts:544](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:544).

Two **Low / advisory** follow-ups remain separate from the nine defects. First, skill rows could expose effective source/mode/path/override badges before adding more controls; current names/descriptions can obscure which definition wins. Second, [skills.ts:68](F:/roo-fork/Alpha-Code/src/core/prompts/sections/skills.ts:68) renders the selected catalog without an aggregate token budget. Benchmark a large deterministic catalog before choosing a bounded policy, preserve explicit invocation, and make any omission visible. No latency, memory, or token regression was measured here.

Legacy `updatePrompt`, `customInstructions`, and skill-move messages are retained compatibility paths; current Settings uses `updateSettings`. No current caller was found for the old full-prompt preview/copy UI. This is a candidate for a separate compatibility audit, not proof that the core task prompt generator is dead.

### Support templates: all ten have current consumers

| Type                    | Current consumer / effective behavior                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| ENHANCE                 | `MessageEnhancer`; standalone completion used by composer and Settings preview |
| CONDENSE                | Manual and automatic context summarization; Context Management editor          |
| EXPLAIN                 | Editor code action; starts a task                                              |
| FIX                     | Editor code action; starts a task                                              |
| IMPROVE                 | Editor code action; starts a task                                              |
| ADD_TO_CONTEXT          | Editor code action; inserts prepared context into chat                         |
| TERMINAL_ADD_TO_CONTEXT | Terminal action; inserts prepared context into chat                            |
| TERMINAL_FIX            | Terminal action; starts a task                                                 |
| TERMINAL_EXPLAIN        | Terminal action; starts a task                                                 |
| NEW_TASK                | Registered new-task command → `handleTask` → provider code-action path         |

Editor registration is at [registerCodeActions.ts:10](F:/roo-fork/Alpha-Code/src/activate/registerCodeActions.ts:10); terminal registration is at [registerTerminalActions.ts:11](F:/roo-fork/Alpha-Code/src/activate/registerTerminalActions.ts:11). NEW_TASK remains live at [handleTask.ts:22](F:/roo-fork/Alpha-Code/src/activate/handleTask.ts:22). Effective template lookup/substitution is [support-prompt.ts:155](F:/roo-fork/Alpha-Code/src/shared/support-prompt.ts:155); provider dispatch is [AlphaProvider.ts:1344](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:1344) and [AlphaProvider.ts:1375](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:1375). These are reusable action templates, not replacements for the agent harness.

CONDENSE is read by [Task.ts:8829](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:8829) and [Task.ts:14277](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:14277). [condense/index.ts:1048](F:/roo-fork/Alpha-Code/src/core/condense/index.ts:1048) applies a trimmed custom prompt while retaining the summarization request structure. [condense/index.ts:809](F:/roo-fork/Alpha-Code/src/core/condense/index.ts:809) builds tool-free metadata and drops live task instruction fragments/provider linkage. Request-isolation coverage passed. Legacy migration is [ContextProxy.ts:101](F:/roo-fork/Alpha-Code/src/core/config/ContextProxy.ts:101).

## Instruction provenance and authority

The current runtime composes typed instruction parts rather than loading a wholesale user replacement for its system prompt. [system.ts:374](F:/roo-fork/Alpha-Code/src/core/prompts/system.ts:374) assembles model, runtime, approval, Alpha feature, environment, inherited-context, skills, custom role/instructions, child authority, and Plan parts with explicit authority. [Task.ts:13705](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:13705) consumes the generated fragments in the actual task path.

User-customized Code role/instructions, global instructions, repository/mode rules, AGENTS content, and skill content remain user-origin material. [custom-instructions.ts:713](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:713) adds global instructions; [custom-instructions.ts:723](F:/roo-fork/Alpha-Code/src/core/prompts/sections/custom-instructions.ts:723) distinguishes built-in mode guidance from customization; later rule/AGENTS parts retain user provenance. Textual order is not executable permission. The canonical built-in mode catalog should remain owned by the harness.

Plan authority is enforced in code. [validateToolUse.ts:190](F:/roo-fork/Alpha-Code/src/core/tools/validateToolUse.ts:190) checks Plan before custom-tool shortcuts and restricts mutation, commands, and managed child roles. [filter-tools-for-mode.ts:194](F:/roo-fork/Alpha-Code/src/core/prompts/tools/filter-tools-for-mode.ts:194) uses runtime validation for visibility. [ExecutionProfile.ts:123](F:/roo-fork/Alpha-Code/src/core/agent/ExecutionProfile.ts:123) retains approval policy; [AlphaProvider.ts:2095](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:2095) gates Plan admission. Retried steps retain captured authority at [Task.ts:14247](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:14247). This inspection found no need to loosen authority or restore a model `switch_mode` tool.

Recovery is explicit at [mode.ts:168](F:/roo-fork/Alpha-Code/packages/types/src/mode.ts:168): Code and Plan are the two executable modes; retired/unknown strings recover to Plan, while absent/empty historical values use the Code fallback. Preserve that distinction when simplifying UI.

## Current Codex CLI comparison

Reference source: `openai/codex` commit **`cc7ba33601286a751477832b01de7b6f8de0dd9c`**, dated `2026-10-10T22:28:01Z`, retrieved October 10, 2026. Source and relevant upstream tests were inspected; upstream Rust tests were **not executed**. Findings above are against Alpha's current TypeScript paths, not inferred from upstream documentation.

- [Collaboration presets](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/models-manager/src/collaboration_mode_presets.rs#L6) and [preset tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/models-manager/src/collaboration_mode_presets_tests.rs#L5) establish Plan/Default. [TUI discovery](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/tui/src/collaboration_modes.rs#L88) clears restored instruction overrides so the server supplies current mode guidance. This supports avoiding saved copies of built-in guidance as accidental customization.
- [Collaboration state](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/world_state/collaboration_mode.rs#L32) and [its tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/context/world_state/collaboration_mode_tests.rs#L85) distinguish current catalog instructions from legacy overrides. Codex does not universally forbid every legacy/custom instruction override. Alpha's UI should describe its actual supported subset rather than make a blanket prohibition claim.
- The [Plan template](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/collaboration-mode-templates/templates/plan.md#L7) supports host-controlled exit and non-mutating investigation. Alpha intentionally maintains its own stronger runtime restrictions and existing approval/workspace security. Codex sandbox architecture is outside this alignment target.
- [AGENTS discovery](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/agents_md.rs#L45), [root-to-cwd traversal](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/agents_md.rs#L189), and [AGENTS tests](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/agents_md_tests.rs) are the relevant reference for scoped project instructions. [Official AGENTS guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md) documents override precedence, root-to-current-directory ordering, and byte limits. Alpha's scoped discovery is active; optional recursive descendant rules are an Alpha feature and should have an explicit scope contract.
- [Inline compaction](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/compact.rs#L123), [configuration normalization](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/src/config/mod.rs#L4040), and [custom compaction coverage](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/core/tests/suite/compact.rs#L923) show that custom compaction guidance remains supported on applicable local paths. Retaining Alpha's custom condensation prompt is consistent with that capability; it does not imply a whole-harness override.
- [Skill fragment roles](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/ext/skills/src/fragments.rs), [host roots](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/ext/skills/src/host_roots.rs), [catalog rendering](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/ext/skills/src/render.rs), and their tests distinguish catalog guidance from selected user skill content and bound aggregate catalog rendering. Alpha intentionally separates developer-owned invocation guidance from user-authored metadata and content. Its native roots and mode-scoped variants are intentional extension capabilities.
- [Skill configuration](https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/config/src/skills_config.rs), [official skills guidance](https://learn.chatgpt.com/docs/build-skills), and [custom-prompt guidance](https://learn.chatgpt.com/docs/custom-prompts) support gradual consolidation of new reusable instruction authoring around skills. Deprecation of upstream custom prompts does not justify removing Alpha's active command-file compatibility or management controls without migration.

Recommendations concern behavior and native Alpha abstractions. They do not propose copying upstream prompts, introducing Rust, or creating a parallel runtime.

## Validation ledger

These are existing tests actually executed. Passing tests demonstrate current covered contracts; they do not establish that the newly identified defects are fixed.

| Command                                                                                                                                                                                              | Actual result                               | Coverage / limit                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm --dir webview-ui test src/components/settings/__tests__/PromptsSettings.buffering.spec.tsx`                                                                                                    | Exit 0; 1 file / 2 tests passed             | Settings buffer and preview options                                            |
| `pnpm --dir src test core/webview/__tests__/messageEnhancer.test.ts shared/__tests__/support-prompts.spec.ts core/condense/__tests__/request-isolation.spec.ts`                                      | Exit 0; 3 files / 52 tests passed           | Existing enhancement fixtures, template lookup, condensation request isolation |
| `pnpm --dir webview-ui test src/components/modes/__tests__/ModesView.spec.tsx src/components/chat/__tests__/ModeSelector.spec.tsx src/components/__tests__/UserFacingModeSelectors.spec.tsx`         | Exit 0; 3 files / 16 tests passed           | Mode editor/selector UI contracts                                              |
| `pnpm --filter @alpha-code/types test src/__tests__/mode-retirement.test.ts src/__tests__/primary-mode-isolation.test.ts src/__tests__/plan-mode-instructions.spec.ts`                               | Exit 0; 3 files / 14 tests passed           | Typed mode recovery and isolation                                              |
| `pnpm --dir src test shared/__tests__/modes.spec.ts shared/__tests__/primary-modes.spec.ts core/agent/__tests__/ExecutionProfile.spec.ts core/prompts/tools/__tests__/filter-tools-for-mode.spec.ts` | Exit 0; 4 files / 74 tests passed           | Effective component precedence and policy visibility                           |
| `pnpm --dir src test core/webview/__tests__/AlphaProvider.sticky-mode.spec.ts`                                                                                                                       | Exit 0; 1 file / 55 tests passed            | Host mode/task behavior                                                        |
| `pnpm --dir src test core/prompts/sections/__tests__/custom-instructions-project-discovery.spec.ts core/prompts/sections/__tests__/modes.spec.ts`                                                    | Exit 0; 2 files / 9 tests passed            | Existing scoped rules and canonical catalog                                    |
| `pnpm --dir src test core/webview/__tests__/webviewMessageHandler.spec.ts -t requestCommands`                                                                                                        | Exit 0; 1 file / 3 tests passed, 99 skipped | Combined command/skill discovery; not deletion identity                        |
| `pnpm --dir src test __tests__/command-mentions.spec.ts services/skills/__tests__/skillInvocation.spec.ts core/webview/__tests__/skills-variant-identity.spec.ts`                                    | Exit 0; 3 files / 93 tests passed           | Mentions, selected skill provenance, existing exact variant management         |

The original coordinating chat also reported `pnpm --dir src test core/prompts/__tests__/system-prompt.spec.ts` (53 tests passed) and a separate ModeSelector run (7 tests passed). Those results are corroborating evidence from the coordinator; they are not counted as additional runs performed by this chat. In particular, passing system-prompt coverage intentionally protects Plan from legacy customization.

No full test suite, typecheck, bundle, VSIX build, or exact-host launch was requested or run for this review-only work. `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` remains unrun. Source compatibility with the repository's 1.125.0 contract was assessed, but live host behavior and material visuals were not verified. No performance or benchmark improvement is claimed.

Report QA also completed without file outputs: in-memory React Markdown/GFM rendering succeeded (four tables, twelve fenced code blocks), all 95 local source links resolved to existing files and valid line bounds, and no trailing whitespace was found. This checks document structure and anchors; it is not a live visual verification of Alpha.

## Follow-up order and closure

1. Repair command/skill resource identity and management dispatch, with stale-dialog deletion tests (MP-01/08).
2. Repair authoritative prompt-map hydration without treating genuine user overrides as disposable defaults (MP-02).
3. Repair enhancement role projection and response ownership (MP-03/04).
4. Make effective mode customization visible: hide unsupported Plan fields, disclose custom Code precedence, retire When to Use editing (MP-05/06/09).
5. Reconcile optional recursive rule scope with its canonical-path promise (MP-07).

Keep Code/Plan, mode descriptions, global/Code instructions, scoped AGENTS/rules, all ten support templates, safe condensation, and task-scoped skills. A clearer Instructions group could consolidate the current placement of global guidance, Code customization, and links to rule files; this is an advisory UX direction, not an implemented design. Retain Alpha's skills, scheduling, Tickets, preview, and execution protections as first-class shared-harness capabilities.

**Fixed now:** none; this task authorized review only. **Flagged:** MP-01 through MP-09. **Not verified:** live VS Code 1.125.0 interaction/visuals, end-to-end React Save/provider reload, live enhancement model output, all provider combinations, actual command deletion on disk, and upstream Rust test execution. **Out of scope:** sibling-owned settings, implementation, migrations, broad validation, packaging, and pre-existing working-tree changes. No finding here grants permission to alter those changes.

## Deterministic reproducer appendix

The scripts below execute current source in memory, use no model/network access, and create no files. They are boundary reproductions, with dependencies stubbed where stated; they are separate from the existing test ledger.

### R1 — Enhancement history projection

Run from `F:\roo-fork\Alpha-Code` in PowerShell. This exact successful command exited 0. An earlier harness attempt used the wrong local TypeScript require path; correcting it to root `typescript` resolved that harness error.

```powershell
@'
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('typescript')
function evaluate(path, stubs) {
 const code = ts.transpileModule(fs.readFileSync(path,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const module={exports:{}}
 vm.runInNewContext(code,{module,exports:module.exports,console,require(id){
  if(!(id in stubs)) throw new Error('Unexpected runtime dependency: '+id)
  return stubs[id]
 }},{filename:path})
 return module.exports
}
const support=evaluate('src/shared/support-prompt.ts',{})
let capturedPrompt
const {MessageEnhancer}=evaluate('src/core/webview/messageEnhancer.ts',{
 '@alpha-code/types':{TelemetryEventName:{}},
 '@alpha-code/telemetry':{TelemetryService:{hasInstance:()=>false}},
 '../../shared/support-prompt':support,
 '../../utils/single-completion-handler':{singleCompletionHandler:async(_config,prompt)=>{capturedPrompt=prompt;return'enhanced'}}
})
const fixture=[
 {type:'say',say:'text',text:'Build a read-only report.',ts:1},
 {type:'say',say:'text',text:'I will review the files.',ts:2},
 {type:'say',say:'user_feedback',text:'Do not modify production files.',ts:3},
 {type:'ask',ask:'tool',text:'{"tool":"write_to_file","path":"src/app.ts"}',ts:4}
]
MessageEnhancer.enhanceMessage({text:'Continue review',apiConfiguration:{apiProvider:'openai'},listApiConfigMeta:[],includeTaskHistoryInEnhance:true,currentAlphaMessages:fixture,providerSettingsManager:{}}).then(result=>{
 assert.equal(result.success,true)
 assert.ok(capturedPrompt.includes('Assistant: Build a read-only report.'))
 assert.ok(capturedPrompt.includes('User: {"tool":"write_to_file"'))
 assert.ok(!capturedPrompt.includes('Do not modify production files.'))
 console.log('Observed current-runtime bug: initial user task labeled Assistant; tool approval labeled User; user correction omitted.')
 console.log(capturedPrompt)
}).catch(error=>{console.error(error);process.exitCode=1})
'@ | node
```

Observed context included `Assistant: Build a read-only report.` and `User: {"tool":"write_to_file","path":"src/app.ts"}`; the human correction was absent. Assertions intentionally recognize the current defect rather than pretend to be a passing regression test for desired behavior.

### R2 — Unrequested Settings enhancement reply

This exact successful command exited 0. It evaluates the actual component with hook/UI dependencies stubbed, captures its message listener, and never sends an enhancement request.

```powershell
@'
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript')
const code=ts.transpileModule(fs.readFileSync('webview-ui/src/components/settings/PromptsSettings.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const handlers=[],setterCalls=[],states=['Unsent preview draft',false,'ENHANCE']
let stateIndex=0
const stubs={
 'react':{useState:()=>{const i=stateIndex++;return[states[i],v=>setterCalls.push({i,v})]},useEffect:effect=>effect()},
 'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
 '@vscode/webview-ui-toolkit/react':{VSCodeTextArea:'textarea',VSCodeCheckbox:'checkbox'},
 '@alpha/support-prompt':{supportPrompt:{get:()=> 'default enhancement template',default:{ENHANCE:'template'}}},
 '@src/utils/vscode':{vscode:{postMessage:()=>{throw new Error('Unexpected request')}}},
 '@src/i18n/TranslationContext':{useAppTranslation:()=>({t:key=>key})},
 '@src/context/ExtensionStateContext':{useExtensionState:()=>({listApiConfigMeta:[]})},
 '@src/components/ui':new Proxy({},{get:(_target,key)=>key}),
 './SectionHeader':{SectionHeader:'section'},'./Section':{Section:'section'},'./SearchableSetting':{SearchableSetting:'setting'}
}
const module={exports:{}}
vm.runInNewContext(code,{exports:module.exports,module,window:{addEventListener:(event,handler)=>handlers.push(handler),removeEventListener:()=>{}},require:id=>{if(!(id in stubs))throw new Error(id);return stubs[id]}})
module.exports.default({customSupportPrompts:{},setCustomSupportPrompts:()=>{},includeTaskHistoryInEnhance:true,setIncludeTaskHistoryInEnhance:()=>{},setEnhancementApiConfigId:()=>{}})
handlers[0]({data:{type:'enhancedPrompt',text:'Unrelated composer enhancement'}})
assert.deepEqual(setterCalls,[{i:0,v:'Unrelated composer enhancement'},{i:1,v:false}])
console.log('Observed actual PromptsSettings listener overwrites an unsent preview draft with an enhancedPrompt response despite no preview request and isEnhancing=false.')
'@ | node
```

### R3 — Command deletion identity and skill-only deletion

This exact successful sub-agent command exited 0. It extracts the actual `deleteCommand` case, replaces its command import with a read-only fixture, and mocks unlink/UI effects. The requested global identity and returned project identity are deliberately different.

```powershell
@'
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('src/core/webview/webviewMessageHandler.ts','utf8');
const tree = ts.createSourceFile('handler.ts',source,ts.ScriptTarget.Latest,true);
let productionCase;
function visit(node) {
 if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)
     && node.expression.text === 'deleteCommand') productionCase=node.getText(tree);
 ts.forEachChild(node,visit);
}
visit(tree);
if (!productionCase) throw new Error('deleteCommand case missing');
const adapted = productionCase.replace(
 'await import("../../services/command/commands")',
 'await readOnlyCommandFixture()'
);
const js = ts.transpileModule('switch(message.type){'+adapted+'}',{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}
}).outputText;
const run = new (Object.getPrototypeOf(async function(){}).constructor)(
 'message','readOnlyCommandFixture','getCurrentCwd','fs','provider','vscode','t',js
);
(async () => {
 for (const fixture of [
  {scenario:'skill-only row projected as a command',source:'project',command:undefined},
  {scenario:'stale global row after same-name project override appears',source:'global',
   command:{filePath:'F:/review-fixture/.alpha/commands/shared-name.md',source:'project'}}
 ]) {
  const deleted=[], errors=[];
  await run(
   {type:'deleteCommand',text:'shared-name',values:{source:fixture.source}},
   async()=>({getCommand:async()=>fixture.command}),
   ()=>'F:/review-fixture',{unlink:async p=>deleted.push(p)},{log:()=>{}},
   {window:{showErrorMessage:e=>errors.push(e)}},key=>key
  );
  console.log(JSON.stringify({
   scenario:fixture.scenario,requestedSource:fixture.source,deleted,errors
  }));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
'@ | node
```

```json
{"scenario":"skill-only row projected as a command","requestedSource":"project","deleted":[],"errors":["common:errors.command_not_found"]}
{"scenario":"stale global row after same-name project override appears","requestedSource":"global","deleted":["F:/review-fixture/.alpha/commands/shared-name.md"],"errors":[]}
```

### R4 — Canonical-only recursive descendants

This exact successful sub-agent command exited 0. It extracts the production discovery and capture functions, mocks the search to honor the actual legacy glob, and compares fixtures without/with a legacy marker. It does not perform a real directory scan.

```powershell
@'
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path').posix;
const os = {homedir:()=>'/home/review-fixture'};
function extractFunction(file,symbol) {
 const source=fs.readFileSync(file,'utf8');
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const node=tree.statements.find(
  node=>ts.isFunctionDeclaration(node)&&node.name?.text===symbol
 );
 if(!node) throw new Error('Missing production function '+symbol);
 return node.getText(tree).replace(/^export\s+/,'');
}
const production=[
 extractFunction('src/services/config-paths/index.ts',
  'discoverLegacySubfolderConfigDirectories').replace(
   'await import("../search/file-search")','await readOnlySearchFixture()'),
 extractFunction('src/services/config-paths/index.ts',
  'getAllLegacyConfigDirectoriesForCwd'),
 extractFunction('src/core/prompts/sections/custom-instructions.ts',
  'getAlphaDirectoriesForCwd'),
 extractFunction('src/core/prompts/sections/custom-instructions.ts',
  'captureInstructionDirectories')
].join('\n');
const js=ts.transpileModule(
 production+'\nreturn captureInstructionDirectories(cwd,true);',
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}
).outputText;
const run=new (Object.getPrototypeOf(async function(){}).constructor)(
 'path','os','readOnlySearchFixture','getLegacyGlobalConfigDirectory',
 'getLegacyProjectConfigDirectory','getProjectInstructionDirectoriesForCwd','cwd',js
);
(async()=>{
 for(const fixturePaths of [
  ['package-a/.alpha/rules/instructions.md','package-b/AGENTS.md'],
  ['package-a/.alpha/rules/instructions.md','package-a/.roo/marker.md',
   'package-b/AGENTS.md']
 ]) {
  let searchArgs;
  const result=await run(
   path,os,
   async()=>({executeRipgrep:async({args})=>{
    searchArgs=args;
    return fixturePaths.filter(p=>p.includes('/.roo/')).map(p=>({path:p}));
   }}),
   ()=>'/home/review-fixture/.roo',cwd=>path.join(cwd,'.roo'),
   async cwd=>({root:cwd,directories:[cwd]}),'/review-fixture'
  );
  console.log(JSON.stringify({
   fixturePaths,searchGlob:searchArgs[4],
   alphaDirectories:result.alpha,agentsDirectories:result.agents
  }));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
'@ | node
```

```json
{"fixturePaths":["package-a/.alpha/rules/instructions.md","package-b/AGENTS.md"],"searchGlob":"**/.roo/**","alphaDirectories":["/home/review-fixture/.alpha","/review-fixture/.alpha"],"agentsDirectories":["/review-fixture"]}
{"fixturePaths":["package-a/.alpha/rules/instructions.md","package-a/.roo/marker.md","package-b/AGENTS.md"],"searchGlob":"**/.roo/**","alphaDirectories":["/home/review-fixture/.alpha","/review-fixture/.alpha","/review-fixture/package-a/.alpha"],"agentsDirectories":["/review-fixture","/review-fixture/package-a"]}
```

### R5 — Prompt-map replacement

This exact successful sub-agent command exited 0. Run from the repository root; `pnpm --dir webview-ui exec node` evaluates relative paths inside the webview package. An earlier extraction harness used the wrong parser kind for a `.ts` input; the successful commands below explicitly select TS versus TSX.

```powershell
@'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const ts = require('typescript')
function extract(file, names) {
 const source = fs.readFileSync(file, 'utf8')
 const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
 const selected = ast.statements.filter((s) =>
  (ts.isFunctionDeclaration(s) && names.includes(s.name?.text)) ||
  (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => names.includes(d.name.getText(ast))))
 )
 assert.equal(selected.length, names.length, 'All requested production declarations were extracted')
 return selected.map((s) => s.getText(ast)).join('\n')
}
const selected = extract('src/context/ExtensionStateContext.tsx', ['mergeExtensionState']) + '\n' + extract('src/context/agentLifecycleState.ts', ['mergeAgentLifecycleDegradedSignals', 'mergeAgentLifecycleSnapshots', 'applyLifecycleSnapshotsToExtensionState'])
const js = ts.transpileModule(selected, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText
const api = {}
new Function('exports', js)(api)
const previous = {apiConfiguration:{}, experiments:{}, customModePrompts:{code:{roleDefinition:'Custom role'}}}
const hostAfterReset = {customModePrompts:{}}
const actual = api.mergeExtensionState(previous, hostAfterReset)
assert.equal(actual.customModePrompts.code.roleDefinition, 'Custom role')
const replacement = api.mergeExtensionState(previous, {customModePrompts:{architect:{description:'Plan caption'}}})
assert.equal(replacement.customModePrompts.code.roleDefinition, 'Custom role')
console.log(JSON.stringify({resetSentByHost:hostAfterReset.customModePrompts, afterMerge:actual.customModePrompts, replacementMapAfterMerge:replacement.customModePrompts}))
console.log('Reproduced: deleting a mode override in the authoritative host map does not delete it from webview state.')
'@ | pnpm --dir webview-ui exec node
```

```text
{"resetSentByHost":{},"afterMerge":{"code":{"roleDefinition":"Custom role"}},"replacementMapAfterMerge":{"code":{"roleDefinition":"Custom role"},"architect":{"description":"Plan caption"}}}
Reproduced: deleting a mode override in the authoritative host map does not delete it from webview state.
```

### R6 — Built-in defaults become explicit overrides

This exact successful sub-agent command exited 0.

```powershell
@'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const ts = require('typescript')
function extract(file, names) {
 const source = fs.readFileSync(file, 'utf8')
 const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
 const selected = ast.statements.filter((s) => (ts.isFunctionDeclaration(s) && names.includes(s.name?.text)) || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => names.includes(d.name.getText(ast)))))
 assert.equal(selected.length, names.length)
 return selected.map((s) => s.getText(ast)).join('\n')
}
const sources = [
 extract('../packages/types/src/mode.ts', ['CODE_MODE_INSTRUCTIONS', 'PLAN_MODE_INSTRUCTIONS', 'DEFAULT_MODES']),
 extract('../src/shared/modes.ts', ['modes','codeModeSlug','planModeSlug','defaultModeSlug','defaultMode','planMode','defaultPrompts','findModeBySlug','getModeSelection']),
 extract('../src/utils/object.ts', ['isEmpty']),
 extract('../src/core/prompts/system.ts', ['getPromptComponent']),
 extract('src/context/ExtensionStateContext.tsx', ['mergeExtensionState']),
 extract('src/context/agentLifecycleState.ts', ['mergeAgentLifecycleDegradedSignals','mergeAgentLifecycleSnapshots','applyLifecycleSnapshotsToExtensionState'])
].join('\n')
const js = ts.transpileModule(sources, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const api = {}
new Function('exports', js)(api)
assert.equal(api.getPromptComponent({}, 'code'), undefined)
const hydrated = api.mergeExtensionState({apiConfiguration:{},experiments:{},customModePrompts:api.defaultPrompts},{customModePrompts:{}})
const component = api.getPromptComponent(hydrated.customModePrompts,'code')
assert.ok(component.roleDefinition)
assert.ok(component.customInstructions)
console.log(JSON.stringify({hostStoredMap:{}, hydratedModeKeys:Object.keys(hydrated.customModePrompts), roleOverridePresent:!!component.roleDefinition, instructionsOverridePresent:!!component.customInstructions}))
console.log('Reproduced: an empty host override map hydrates as explicit built-in prompt overrides; SettingsView passes that buffered map to updateSettings on any save.')
'@ | pnpm --dir webview-ui exec node
```

```text
{"hostStoredMap":{},"hydratedModeKeys":["architect","code"],"roleOverridePresent":true,"instructionsOverridePresent":true}
Reproduced: an empty host override map hydrates as explicit built-in prompt overrides; SettingsView passes that buffered map to updateSettings on any save.
```

### R7 — Effective Plan/Code selection and mode catalog

This exact successful sub-agent command exited 0. It verifies effective functions, not a full UI round trip.

```powershell
@'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const ts = require('typescript')
function extract(file, names) {
 const source = fs.readFileSync(file, 'utf8')
 const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 const selected=ast.statements.filter((s)=>(ts.isFunctionDeclaration(s)&&names.includes(s.name?.text))||(ts.isVariableStatement(s)&&s.declarationList.declarations.some((d)=>names.includes(d.name.getText(ast)))))
 assert.equal(selected.length,names.length)
 return selected.map((s)=>s.getText(ast)).join('\n')
}
const source=[
 extract('../packages/types/src/mode.ts',['CODE_MODE_INSTRUCTIONS','PLAN_MODE_INSTRUCTIONS','DEFAULT_MODES']),
 extract('../src/shared/modes.ts',['modes','codeModeSlug','planModeSlug','defaultModeSlug','defaultMode','planMode','findModeBySlug','getModeSelection']),
 extract('../src/core/prompts/sections/modes.ts',['getModesSection'])
].join('\n')
const api={}
new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api)
const edits={roleDefinition:'NEW ROLE',customInstructions:'NEW INSTRUCTIONS',whenToUse:'UNIQUE WHEN TO USE'}
assert.notEqual(api.getModeSelection('architect',edits).roleDefinition,edits.roleDefinition)
assert.notEqual(api.getModeSelection('architect',edits).baseInstructions,edits.customInstructions)
const customCode={slug:'code',name:'Saved Code',roleDefinition:'SAVED ROLE',customInstructions:'SAVED INSTRUCTIONS',groups:['read']}
assert.equal(api.getModeSelection('code',edits,[customCode]).roleDefinition,customCode.roleDefinition)
assert.equal(api.getModeSelection('code',edits,[customCode]).baseInstructions,customCode.customInstructions)
api.getModesSection({}, {code:edits,architect:edits}).then((catalog)=>{
 assert.ok(!catalog.includes(edits.whenToUse))
 console.log('Reproduced with unchanged production functions: Plan ignores role/instruction edits; Code mode config supersedes prompt edits; captured whenToUse overrides do not enter the mode catalog.')
})
'@ | pnpm --dir webview-ui exec node
```

```text
Reproduced with unchanged production functions: Plan ignores role/instruction edits; Code mode config supersedes prompt edits; captured whenToUse overrides do not enter the mode catalog.
```
