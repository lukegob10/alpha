# Agent Skills standard and host profiles

Use this reference when choosing frontmatter, storage, invocation policy, or cross-host compatibility. Prefer the
portable profile unless the user explicitly targets one host.

Sources were checked on 2026-09-20:

- Agent Skills specification: https://agentskills.io/specification
- Agent Skills authoring practices: https://agentskills.io/skill-creation/best-practices
- Agent Skills script guidance: https://agentskills.io/skill-creation/using-scripts
- Agent Skills evaluation guidance: https://agentskills.io/skill-creation/evaluating-skills
- Agent Skills description optimization: https://agentskills.io/skill-creation/optimizing-descriptions
- OpenAI Codex skills: https://developers.openai.com/codex/skills
- Anthropic Claude Code skills: https://docs.anthropic.com/en/docs/claude-code/skills
- Cursor Agent Skills: https://cursor.com/docs/skills.md
- Cursor's installed `create-skill` authoring guidance available on 2026-09-20
- Alpha's current `SkillsManager` and skill invocation implementation

Host behavior evolves. Recheck the relevant primary documentation before depending on a host extension, distribution
path, version-specific feature, or permission behavior.

## Portable package profile

A portable skill is a directory containing:

```text
skill-name/
├── SKILL.md
├── scripts/       # Optional executable helpers
├── references/    # Optional on-demand documentation
└── assets/        # Optional templates and static resources
```

`SKILL.md` starts on its first line with YAML frontmatter and continues with Markdown instructions:

```markdown
---
name: skill-name
description: State what the skill does and when it should be used.
---

# Skill title

Follow the workflow.
```

Portable frontmatter fields:

- `name` is required, 1–64 characters, lowercase ASCII letters, digits, and hyphens. It cannot start or end with a
  hyphen, contain consecutive hyphens, or differ from the parent directory name.
- `description` is required, 1–1024 characters, and describes both capability and activation conditions.
- `license` is optional and should be an SPDX identifier or a short reference to bundled terms.
- `compatibility` is optional, 1–500 characters, and states actual product, package, network, or environment
  requirements.
- `metadata` is optional and maps string keys to string values. Use namespaced keys where collisions are plausible.
- `allowed-tools` is optional and experimental. In the open specification it is a space-separated string. Support and
  semantics vary by host.

Keep the main file below 500 lines and preferably below 5,000 tokens. Link supporting files directly from `SKILL.md`
using paths relative to the skill root. Load references only when needed.

Validate with `skills-ref validate <skill-directory>` when the reference validator is already available or the user
authorizes installing it. The current validator accepts only the six portable fields, so supported host extensions can
produce an unexpected-field error. Validate those fields with the target host rather than deleting intentional metadata.
The reference library is a conformance aid, not a production security boundary. A valid package can still have poor
activation boundaries or incorrect behavior.

## YAML reliability

Quote ambiguous values:

```yaml
---
name: release-notes
description: "Create release notes from commits. Use when the user asks for a release summary."
compatibility: "Requires git >= 2.40; network access is not required."
metadata:
    example.com/owner: "release-engineering"
    example.com/version: "1.0"
---
```

Use a folded scalar for a long description:

```yaml
description: >-
    Review database migrations for locking and rollback hazards. Use when creating or reviewing schema migrations.
    Do not use for ordinary query tuning.
```

Parse the result with a YAML-aware frontmatter parser. Do not build YAML by concatenating unescaped user text.

## Alpha profile

Alpha reads the portable `name` and `description` fields and progressively loads the body when the skill is selected.
It discovers:

- Project skills from `.agents/skills/<name>/` and `.alpha/skills/<name>/`.
- Personal skills from `~/.agents/skills/<name>/` and `~/.alpha/skills/<name>/`.
- Read-only skills bundled with the installed extension.

Create every new Alpha project skill under `.agents/skills/` and every new personal skill under
`$HOME/.agents/skills/`. Treat `.alpha/skills/` as a compatibility location for existing skills, not a creation target.
Modify an existing `.alpha` skill in place unless the user asks to migrate it. Project skills override personal and
built-in skills with the same name; an existing `.alpha` skill overrides `.agents` at the same scope. Do not edit
installed built-in assets.

Alpha's optional `modeSlugs` field restricts a skill to selected executable modes:

```yaml
modeSlugs:
    - code
    - architect
```

Omit it for all modes. `modeSlugs` is an Alpha extension, so exclude it from a package intended for strict portable
validation or another host. Selection never widens the active mode's tool or mutation policy.

## Cursor profile

Cursor discovers:

- Project skills at `.agents/skills/<name>/SKILL.md` and `.cursor/skills/<name>/SKILL.md`.
- Personal skills at `~/.agents/skills/<name>/SKILL.md` and `~/.cursor/skills/<name>/SKILL.md`.
- Compatible skills in project and personal Claude and Codex skill directories.

Prefer `.agents/skills/` for the portable package and `.cursor/skills/` for a Cursor-specific package. Start from the
portable `name` and `description` fields. Cursor also supports `paths` for file-scoped activation,
`disable-model-invocation` for explicit-only invocation, `metadata`, and `icon` and `color` for Custom Mode presentation.
Cursor's installed creator defaults `disable-model-invocation` to `true`; omit it when the skill should be selected from
ambient task context. This authoring default is distinct from the runtime default, which permits automatic invocation
when the field is absent. Keep references one level deep and use forward slashes in skill-authored paths.

Only personal skills under `~/.cursor/skills/` participate in Cursor's personal Cloud Agent sync; `.agents` and
compatibility directories remain local unless separately distributed. Cursor's `~/.cursor/skills-cursor/` directory is
managed by the product. Never write user skills into it. Verify current Cursor documentation before relying on
additional Cursor-only fields or packaging behavior.

## Claude Code profile

Claude Code reads project skills from `.claude/skills/<name>/SKILL.md` and personal skills from
`~/.claude/skills/<name>/SKILL.md`. It supports the portable profile and local Claude Code extensions, including:

- `when_to_use` and argument metadata.
- `disable-model-invocation` and `user-invocable`.
- `allowed-tools` and `disallowed-tools`.
- `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, and `shell`.

Use these only for a Claude Code-local skill whose requested behavior needs them. Keep cross-host skills to the six
standard fields. Claude.ai uploads, the Skills API, and Anthropic's packaging flow accept only `name`, `description`,
`license`, `compatibility`, `metadata`, and `allowed-tools`; unsupported keys can fail packaging instead of being
ignored.

`allowed-tools` is a temporary host permission grant in Claude Code. Grant only the narrow commands the workflow needs;
do not use it as a substitute for safe instructions or input validation. Dynamic context injection and Claude-specific
substitutions are not portable.

## Codex profile

Codex uses the open Agent Skills format and discovers:

- Repository skills from `.agents/skills/` at the current directory and parent directories through the repository root.
- Personal skills from `$HOME/.agents/skills/`.
- Administrator skills from `/etc/codex/skills/` on supported systems.
- System skills bundled with Codex.

Explicit invocation uses the host's skill selector or `$skill-name`; implicit invocation relies primarily on `name` and
`description`. Codex loads the body and later resources progressively.

Codex can use `agents/openai.yaml` for presentation, implicit-invocation policy, and declared tool dependencies. Keep
those settings outside `SKILL.md`; they are a Codex extension. Use plugins when the requested deliverable is an
installable distribution containing multiple skills, connectors, or presentation metadata.

## Cross-host decisions

For one package intended to work unchanged across hosts:

1. Use only portable frontmatter fields.
2. Avoid host-only substitutions, embedded command execution, and internal tool names.
3. Describe capabilities generically and let each host enforce its own permissions.
4. Use instruction-only workflows or cross-platform scripts with explicit dependencies.
5. Put the canonical package in a shared location only when every target host discovers that location.
6. Otherwise generate host-specific distribution metadata from one canonical source; do not maintain divergent copies
   by hand.
7. Test discovery, explicit invocation, implicit routing, and resource resolution in every claimed host.

Compatibility means verified behavior, not merely frontmatter that parses.
