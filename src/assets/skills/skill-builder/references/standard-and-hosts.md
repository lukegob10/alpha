# Agent Skills standard and host profiles

Use this reference when choosing frontmatter, storage, invocation policy, or cross-host compatibility. Prefer the
portable profile unless the user explicitly targets one host.

Primary references:

- [Agent Skills specification](https://agentskills.io/specification)
- [Authoring practices](https://agentskills.io/skill-creation/best-practices)
- [Script guidance](https://agentskills.io/skill-creation/using-scripts)
- [Evaluation guidance](https://agentskills.io/skill-creation/evaluating-skills)
- [Description optimization](https://agentskills.io/skill-creation/optimizing-descriptions)
- [OpenAI skills documentation](https://developers.openai.com/codex/skills)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Cursor Agent Skills](https://cursor.com/docs/skills)
- Alpha's `SkillsManager` and skill invocation implementation in this repository

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
authorizes installing it. Check the installed validator's supported fields; validate host extensions with the target
host rather than deleting intentional metadata to satisfy a portable validator.
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

Consult [Cursor's current skill documentation](https://cursor.com/docs/skills) for discovery directories, supported
frontmatter, explicit invocation, Custom Modes, and remote distribution. Confirm the target surface: a skill available
on the local machine is not proof that a Cloud Agent or remote worker receives it.

Use `.agents/skills/` only when the requested Cursor surface discovers it. Keep portable frontmatter unless a verified
Cursor extension is required, and keep user-authored skills separate from product-managed built-ins. Do not infer runtime
invocation defaults from an installed creator skill or assume another host implements Cursor's fields.

## Claude Code profile

Consult [Claude Code's skill reference](https://code.claude.com/docs/en/skills) for its discovery locations, frontmatter,
invocation controls, permissions, dynamic context, and subagent behavior. Verify the actual delivery surface separately;
local Claude Code support does not establish support in a synced skill, upload, API, or packaging flow.

Add a Claude Code extension only when the requested workflow needs it and the target host supports it. Keep portable
packages to the standard fields. Treat permission-related metadata according to the host's documented enforcement;
neither the metadata nor the skill body can bypass the active host policy.

## Codex profile

Consult [OpenAI's skill documentation](https://developers.openai.com/codex/skills) for the requested Codex surface. Verify
discovery roots, invocation policy, supported metadata, and distribution there before authoring host-specific behavior.
For Codex CLI behavior, inspect the relevant [current source and tests](https://github.com/openai/codex) when the
documentation does not resolve a compatibility question.

Keep portable activation metadata in `SKILL.md`. Use `agents/openai.yaml` only for supported host extensions that the
requested workflow needs, and test discovery and invocation in that host. Alpha's support for one field does not imply
that it implements Codex presentation, dependency loading, or distribution behavior.

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
