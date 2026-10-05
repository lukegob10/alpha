# Instructions, skills, and modes convergence — 2026-10-03

Reference: Codex CLI `b741e480e203f037ca726bc2a76d99a8e8668e66`, retrieved 2026-10-03; starting Alpha commit
`2660a8f8d68d38ec42d473de6a0eee6d2537e58b`. Work is native TypeScript and retains Alpha approvals, workspace
protections, bundled skills, Tickets, scheduled tasks, and HTML preview.

## Integration contract

- `selectInheritedInstructionFragments` in `src/core/prompts/inherited-instructions.ts` accepts the invoking step's
  unredacted `readonly ApiInstructionFragment[]` and returns independent user-fragment copies in order. It includes
  custom role, language, global/custom-mode instructions, mode/project/generic rules, Alpha ignore guidance, and
  `alpha-subagent-inherited-instructions`. It excludes wrappers, host model/mode/role/approval/environment/tool overlays,
  skill catalogs, unknown origins, and any fragment at developer/system authority. The parent must rebuild those host
  overlays and skill catalogs from child policy. No current live settings/files are read by this selector.
- New frozen aggregate text is emitted once as a user `alpha-subagent-inherited-instructions` fragment containing only
  the exact snapshot body. Its surrounding user `prompt-wrapper` fragments are excluded from inheritance, avoiding
  nested wrappers across descendants. Host precedence remains a developer `alpha-subagent-authority` fragment. Existing
  persisted string/digest readers remain usable; existing aggregate snapshots cannot safely recover per-source roles.
- Skills tools use `await provider.getSkillsManager(task)`. Root integration preserves the synchronous zero-arg UI
  getter and adds the task-aware overload returning the shared logical-workspace manager after initialization. Task
  mention expansion and live prompt generation use that same task manager. Managed Workers use their history workspace for
  skill lookup rather than an isolated write checkout. Managed parents must capture only their frozen skill list.
  Background manager watcher notifications must not publish their catalog into the foreground Settings view. The
  constructor now accepts `new SkillsManager(provider, workspacePath, { notifyWebview: false })`; that option retains
  discovery and watchers while suppressing catalog UI publication. The default `true` preserves foreground behavior.
- Root owns webview preview selection of `model.instructionModelId ?? model.id`, matching live Task prompt assembly, plus
  invoking-step capture integration and nested frozen-skill selection. These changes are outside this file list.

## Findings and changes

- Executable prompt generation now restores retired/unknown modes to canonical Plan before selecting saved overrides,
  matching the tool-surface restoration rule. Historical mode readers retain saved definitions for compatibility.
- Host mode catalog text remains canonical. Settings-supplied mode text is kept out of developer catalog instructions.
- Skill metadata catalog text receives user authority, while fixed invocation/resource guidance remains developer text.
- Portable `.agents/skills` discovery now includes each applicable ancestor from the nearest repository root to cwd,
  and watches those roots. Alpha's existing `.alpha`, bundled, and mode precedence remains intact. A separately bounded
  exact-path index includes discovered skills hidden by same-source name overrides, replaces on completed refresh, and
  clears on disposal. Removed or undiscovered identities and changed content remain rejected for frozen child use.
- SkillTool and the slash-command skill fallback now await the task-aware manager hook. Slash-command skill fallback
  uses the task's sticky mode rather than a foreground mode from provider state.
- Task-scoped managers can retain active file watchers without overwriting the foreground catalog via the optional
  constructor setting `notifyWebview: false`. Disposed managers do not publish a late watcher refresh result.
- AGENTS discovery already uses root-to-cwd `AGENTS.override.md` before `AGENTS.md`, with bounded user-authority content.
  Whitespace-only selected files no longer debit the shared 32 KiB budget. Special files and symlink targets must be
  regular files before reads. Regressions also verify captured nested override content and explicit empty sources.
- GPT-6.1 Sol now has an explicit resolver identity, including provider-qualified aliases, and shares verified GPT-6
  collaboration/delegation fields. Its base reuses Alpha's already retained Astra instructions with two concise local
  communication adaptations; no new upstream prompt body is copied. The retained prompt corpus remains pinned to its
  original provenance. This adaptation intentionally does not claim byte identity with upstream GPT-6.1's template.
  The GPT-6.1 base is an Alpha-owned family adaptation; explicit model identity and verified shared runtime fields do
  not establish exact upstream prompt parity.

## Source evidence

- [AGENTS discovery and bounded reads](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/agents_md.rs)
  and [discovery regressions](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/agents_md_tests.rs).
- [Repository instruction refresh manager](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/agents_md_manager.rs)
  and [user instruction authority](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context/user_instructions.rs).
- [Host-controlled collaboration transitions](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/context/world_state/collaboration_mode.rs)
  and [transition tests](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/tests/suite/collaboration_instructions.rs).
- [Current model catalog](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/models-manager/models.json).
  GPT-6.1 template digest is `e1bdd4f8f0df4b20f4a0ffc8a861ce819df45325d8cecdfb92e80379cf8d142e`;
  Default and multi-agent role fields match Alpha's retained GPT-6 fields. Communication behavior is adapted locally.
  [Official GPT-6.1 Sol documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) confirms the model ID.
- [Portable skill roots](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/ext/skills/src/host_roots.rs),
  [root discovery tests](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/ext/skills/src/host_roots_tests.rs),
  [skill merge behavior](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/ext/skills/src/loader/host_merge.rs),
  [skill selection](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/skills/src/selection.rs),
  and [implicit-invocation catalog filtering](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/ext/skills/src/provider/host.rs).

## Intentional differences and remaining work

Alpha preserves fresh instruction discovery at each root prompt assembly. Codex caches repository instructions by
environment selection and trust while refreshing host providers; changes at a new Alpha step intentionally remain
observable. Child tasks continue to use frozen snapshots. Alpha preserves `.alpha`/`.roo` rules, `AGENT.md` fallback,
additive `AGENTS.local.md`, project-over-global skill resolution, and its host-owned strict Plan restrictions.

Skill `agents/openai.yaml` `policy.allow_implicit_invocation` needs shared metadata and an explicit-vs-implicit invocation
contract across Task mention parsing, SkillTool, and persisted child skills. Catalog guidance alone cannot enforce it;
this broader contract remains a parent-owned follow-up. Codex retains same-name skills at distinct paths and rejects
ambiguous plain-name selection; Alpha intentionally retains a deterministic winning name, with nearer portable roots
overriding ancestors. Recursive discovery within a portable root remains a broader unimplemented difference.

## Validation

Node `24.21.0`; pnpm `11.24.0`. Five new prompt/model authority regressions failed before their fixes, then passed along
with two capture-selector tests. Instruction discovery's two bug regressions also failed before their fixes.
Final affected-surface command:

```powershell
pnpm --dir src test core/prompts/__tests__ core/prompts/sections/__tests__ services/skills/__tests__ core/tools/__tests__/skillTool.spec.ts core/tools/__tests__/runSlashCommandTool.spec.ts shared/__tests__/modes.spec.ts shared/__tests__/primary-modes.spec.ts
```

Result: **33 files passed, 525 tests passed, 2 existing skips**. The retired Ask prompt snapshot was updated deliberately
to canonical Plan and its diff inspected. Touched-file Prettier, scoped ESLint, and scoped `git diff --check` passed.
Independent review found no remaining owned issues after the wrapper fix.

Follow-up: the scoped watcher-publication regression failed before the constructor option (three unscoped UI
publications), then passed after it. All 75 SkillsManager tests passed, including existing default publication,
generation guards, and watcher cleanup coverage.

Earlier local `pnpm --dir src check-types` receipts failed on parent-owned Task approval tests calling the removed
`getApprovalModeForAsk` and SkillTool/RunSlashCommandTool awaiting the not-yet-integrated task-aware provider getter.
An earlier readonly-cwd skill-test fixture was repaired and its 74 manager tests passed again; concurrent
SubagentContextCapture and condense errors were absent from the later local receipt.

Root subsequently completed the shared integration and reported **`pnpm --dir src check-types` passed** on 2026-10-03.
This is the parent validation receipt; this workstream did not rerun the shared gate after the freeze request. Final
owned diff review and scoped `git diff --check` found no remaining issues. Source is frozen for parent gates. Root owns
final affected-surface tests, VS Code 1.125.0 smoke, builds, packaging, and certification.

## Exact changed files

Production files:

- `src/core/prompts/system.ts`
- `src/core/prompts/inherited-instructions.ts`
- `src/core/prompts/codex-model-instructions.ts`
- `src/core/prompts/codex-runtime-instructions.ts`
- `src/core/prompts/sections/custom-instructions.ts`
- `src/core/prompts/sections/index.ts`
- `src/core/prompts/sections/modes.ts`
- `src/core/prompts/sections/rules.ts`
- `src/core/prompts/sections/skills.ts`
- `src/services/skills/SkillsManager.ts`
- `src/core/tools/SkillTool.ts`
- `src/core/tools/RunSlashCommandTool.ts`

Tests and inspected snapshot:

- `src/core/prompts/__tests__/inherited-instructions.spec.ts`
- `src/core/prompts/__tests__/codex-model-instructions.spec.ts`
- `src/core/prompts/__tests__/codex-runtime-instructions.spec.ts`
- `src/core/prompts/__tests__/system-prompt.spec.ts`
- `src/core/prompts/__tests__/add-custom-instructions.spec.ts`
- `src/core/prompts/__tests__/__snapshots__/add-custom-instructions/ask-mode-prompt.snap`
- `src/core/prompts/sections/__tests__/custom-instructions-project-discovery.spec.ts`
- `src/core/prompts/sections/__tests__/custom-instructions.spec.ts`
- `src/core/prompts/sections/__tests__/modes.spec.ts`
- `src/core/prompts/sections/__tests__/skills.spec.ts`
- `src/services/skills/__tests__/SkillsManager.spec.ts`
- `src/core/tools/__tests__/skillTool.spec.ts`
- `src/core/tools/__tests__/runSlashCommandTool.spec.ts`

Record: `docs/convergence-instructions-skills-modes-2026-10-03.md`. No shared type, Task, AlphaProvider, dependency,
release, commit, branch, or generated build artifact changes were made by this workstream.
