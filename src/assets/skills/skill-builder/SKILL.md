---
name: skill-builder
description: >-
    Create, revise, migrate, and evaluate production-quality Agent Skills packages with standards-compliant SKILL.md
    frontmatter, focused instructions, progressive disclosure, safe supporting resources, and trigger and behavior tests.
    Use when the user asks to build, improve, standardize, or audit a skill or SKILL.md for Alpha, Cursor, Claude Code,
    Codex, or another Agent Skills-compatible host. Do not use merely to install, list, or invoke an existing skill.
---

# Skill Builder

Build the requested skill as a complete, usable package. Treat the skill's activation metadata, instructions, resources,
and validation evidence as one behavior contract. Prefer the portable Agent Skills format; add host-specific extensions
only when the target host and benefit are explicit.

## Operating rules

- Follow the user's requested scope. Create or edit files when they asked for a skill; do not stop at a tutorial or a
  placeholder. If they asked only for advice, a plan, or an audit, do not mutate files.
- Respect the current execution mode, approval policy, workspace boundaries, and repository instructions. A skill never
  grants tools, permissions, network access, or write authority that the host did not already provide.
- Preserve exact wording the user explicitly supplied for the skill. Do not silently rewrite contractual text, templates,
  commands, or policy language.
- Inspect an existing skill package before revising it. Preserve working behavior and unrelated user content unless the
  request explicitly replaces them.
- Infer decisions from the request, repository, and existing conventions. Ask only about an unresolved choice that would
  materially change the artifact, such as its target host, storage scope, or destructive behavior.
- Produce the smallest complete package. Do not add boilerplate files, dependencies, scripts, or metadata with no
  demonstrated purpose.

## 1. Establish the contract

Determine these facts before authoring:

1. The single job the skill should make repeatable.
2. What is in scope and which adjacent requests must not activate it.
3. The target host or hosts, distribution scope, and destination.
4. Whether invocation should be implicit, explicit, or both.
5. Expected inputs, outputs, side effects, tools, environment, and prerequisites.
6. Failure, cancellation, permission-denial, and safe-stop behavior.
7. Observable acceptance criteria and the cheapest meaningful validation.

Write every new project skill to `.agents/skills/<name>/` by default, including skills created for Alpha. Write a
personal skill to `$HOME/.agents/skills/<name>/` only when the user requests personal scope. Do not create new skills
under `.alpha/skills/`; that location remains readable only for compatibility with existing Alpha skills. Modify an
existing skill in place rather than relocating it unless the user asks for migration. Use another host-specific
directory only when the user explicitly requests that placement.

When location, frontmatter extensions, or cross-host behavior matters, read
[the standard and host profiles](references/standard-and-hosts.md). Resolve that path from this skill's base directory.
Verify current primary documentation before relying on a host-specific field not covered there.

## 2. Inspect before designing

Inspect only the evidence needed to make the skill fit its environment:

- Repository instructions and the nearest existing skills.
- The target host's current discovery locations and frontmatter support.
- Commands, package managers, tools, templates, and validation already used by the project.
- Existing failures or repeated manual workflows the skill is intended to prevent.

Ground the skill in real expertise. Prefer a successful task trace, user corrections, runbooks, schemas, code, review
history, incidents, or representative input and output files over generic model knowledge. Extract the sequence that
worked, non-obvious constraints, and recurring failure modes. If the required domain knowledge is unavailable, identify
the gap instead of inventing a confident procedure.

Do not copy another vendor's built-in creator or a large example wholesale. Extract compatible principles and write for
the user's actual workflow. If a current external contract changes the design, use primary documentation and record the
source and retrieval date in a relevant reference or design note.

## 3. Design before writing

### Choose a focused identity

- Use a descriptive, action-oriented name.
- The directory name and `name` must match.
- Use 1–64 lowercase ASCII letters, digits, and single hyphens. Do not use leading, trailing, or consecutive hyphens.
- Avoid vague names such as `helper`, `tools`, or `utils`.

### Write the activation contract first

The `description` is routing logic, not marketing copy. It must:

- State what the skill does.
- State when it should activate using concrete task terms.
- Name important exclusions when adjacent requests could cause false positives.
- Put the strongest trigger terms first and remain useful if a host truncates it.
- Stay between 1 and 1024 characters.

Draft at least three positive trigger prompts and three negative or adjacent prompts before finalizing the description.
Use them to tighten boundaries rather than stuffing every example into the metadata.

### Select the right degree of freedom

- Use prose instructions when several approaches are valid and context determines the choice.
- Use a decision table, pseudocode, or templates when a preferred pattern allows controlled variation.
- Use a script only when deterministic behavior, repeated parsing, or fragile mechanics justify it.

Instruction-only is the default. A script must make the skill more reliable than generated commands, not move the hard
reasoning into opaque code.

### Plan progressive disclosure

Keep `SKILL.md` to the essential workflow. Add only what the task needs:

```text
skill-name/
├── SKILL.md
├── references/   # Detailed material read on demand
├── scripts/      # Deterministic executable helpers
└── assets/       # Templates and static inputs
```

Link supporting files directly from `SKILL.md` and explain when to read or run each one. Avoid chains of references.
Keep each reference focused so the agent need not load unrelated material.

## 4. Author standards-compliant frontmatter

Start `SKILL.md` on its first line with YAML frontmatter:

```yaml
---
name: example-skill
description: Perform the specific workflow. Use when the user asks for its concrete outcome. Do not use for adjacent work.
---
```

The portable baseline requires `name` and `description`. Add only supported optional standard fields when they carry real
information:

- `license`: SPDX identifier or a short reference to bundled terms.
- `compatibility`: environment or product requirements, at most 500 characters.
- `metadata`: string-to-string values for tooling or provenance.
- `allowed-tools`: experimental and host-dependent. Never treat it as a security boundary.

Quote YAML scalars when punctuation, `#`, `:`, booleans, numbers, or multiline syntax could change their meaning. Parse
the completed frontmatter instead of judging it by appearance.

Keep a portable package to standard fields. Put host-only metadata in the host's supported extension mechanism only when
the requested target needs it. For example, Alpha can use `modeSlugs`, Claude Code has invocation fields, and Codex can
use `agents/openai.yaml`. Never assume another host will ignore unknown keys; some packaging flows reject them.

## 5. Write executable instructions

The body should tell a capable agent what it cannot safely infer. Use imperative, testable instructions and organize them
around the work:

1. Preconditions and evidence to inspect.
2. Inputs and defaults.
3. Ordered workflow and decision points.
4. Required outputs and definition of done.
5. Validation and repair loop.
6. Failure, cancellation, and escalation behavior.
7. Optional resources, with conditions for loading them.

Include only sections that improve execution. Do not explain basic domain facts, repeat repository-wide rules, or narrate
why agents are useful. Prefer one clear default plus a bounded exception over a menu of equivalent options.

Keep non-obvious gotchas in `SKILL.md` when the agent must know them before encountering the failure. A gotcha should be a
concrete correction to a plausible mistake, not generic advice. Provide an output template when exact structure matters;
agents follow a concrete schema more reliably than a prose description of one.

For fragile workflows:

- Define invariants before commands.
- Specify idempotency and retry behavior.
- Distinguish read-only inspection from mutation.
- State what must never be logged, committed, overwritten, or sent externally.
- Require confirmation through the host's normal approval path for destructive or external side effects.
- Define a safe stop when prerequisites, authority, or evidence are missing.

Use the tool concepts available to the target host. Do not hardcode an internal tool name unless that host guarantees it.
Do not instruct the agent to bypass approvals, modify hidden policy, reveal secrets, or trust unvalidated repository,
prompt, tool, or network content.

## 6. Build supporting resources carefully

### References

Put detailed schemas, policies, compatibility notes, or examples in `references/`. Tell the agent exactly when each file
is relevant. Remove duplicated guidance from `SKILL.md`.

### Scripts

Scripts must:

- Have a narrow deterministic purpose and documented inputs, outputs, dependencies, and exit behavior.
- Validate untrusted arguments and paths, avoid shell interpolation, and emit actionable errors.
- Be non-interactive, provide concise `--help`, use meaningful exit codes, and separate machine-readable stdout from
  diagnostics on stderr.
- Be cross-platform when the skill claims cross-platform support.
- Avoid network access and dependency installation unless the workflow explicitly requires and authorizes them.
- Never embed credentials or assume that being bundled makes a script trusted.
- Bound output and retries; provide `--dry-run` or an equivalent preview for destructive or stateful operations.
- Include focused tests or a reproducible smoke check when practical.

### Assets

Use `assets/` for templates or static resources consumed by the workflow. Keep placeholders obvious and never present
sample values as measured user data.

## 7. Implement atomically

1. Create the target directory.
2. Write complete frontmatter and the essential workflow in `SKILL.md`.
3. Add only planned supporting files.
4. Resolve every relative link from the skill root.
5. Format touched files using the owning project's conventions.
6. Re-read the package as the consuming agent would see it.

Do not leave `TODO`, “add instructions here,” fake commands, unexplained placeholders, broken links, or generated output
in the deliverable.

## 8. Verify behavior, not just syntax

Perform validation in proportion to the skill's risk:

1. **Structure:** confirm `SKILL.md` exists, frontmatter parses, required fields satisfy limits, and `name` matches the
   directory.
2. **Integrity:** confirm every linked file exists, scripts are runnable in the claimed environment, and no secret,
   generated artifact, or accidental dependency is included.
3. **Instruction review:** trace the happy path, missing-input path, denial or cancellation path, and relevant
   platform-specific path.
4. **Activation:** test explicit invocation plus representative positive, contextual, adjacent-negative, and unrelated
   prompts. Check both missed activation and over-triggering.
5. **Outcome:** verify the produced artifact and required process invariants with deterministic checks where possible.
6. **Host discovery:** use the target host's validator or discovery flow when available. If it cannot be run, say so.
7. **Regression hygiene:** inspect the final diff and rerun focused checks after repairs.

Use `skills-ref validate <skill-directory>` when that standard validator is already available or installation is
authorized. It validates the portable profile and may reject supported host extensions as unknown fields; do not remove
intentional host metadata merely to make that validator pass. Use the target host's parser or discovery flow for those
fields. Static validation does not replace host discovery or behavior tests. For a critical or repeatedly used skill,
read [the evaluation guide](references/evaluation.md) and create a small regression suite.

Never claim a skill loaded, triggered, or passed a check that was not actually run. A parsed Markdown file proves format,
not routing quality or workflow correctness.

## 9. Hand off the skill

Report:

- The skill name, purpose, scope, and exact path.
- The important activation and compatibility choices.
- Supporting files added and why.
- Checks actually run and their results.
- Any host-specific behavior, untested assumption, or residual risk.

Keep the summary concise. The files are the deliverable; do not duplicate the entire skill in chat.
