# Alpha Core Harness: Final Phases

## Purpose

This document replaces the original Phase 5–6 profile plan in [`core-harness-comparison.md`](./core-harness-comparison.md). It starts from the experiment branch as implemented, incorporates the benchmark and telemetry findings gathered during Phases 0–4, and defines the remaining work required to reach a frontier-style agent architecture.

The central reset is:

> Keep the user surface small, keep model choice independent, and compose specialized internal work from objective-driven task definitions, policies, skills, scopes, and model routes.

## Starting point

The experiment branch already provides the substrate required for the reset:

- a provider-neutral `AgentTurnEngine` behind the existing `Task` façade;
- complete-response collection and provider-neutral assistant/tool items;
- multi-tool scheduling with selective read parallelism and serialized mutations;
- immutable `StepContext` snapshots and exact retry reuse;
- centralized tool visibility, execution policy, approval, cancellation, command rules, and output limits;
- safe-boundary compaction with parent-linked contexts;
- task-scoped append-only request, retry, tool, approval, verification, compaction, and completion telemetry;
- structured tool status normalization;
- safe stale-patch rejection;
- shared completion finalization for normal final responses and `attempt_completion`.

The following parts are not implemented:

- the user-facing profile reset;
- a provider-neutral internal task envelope;
- a provider-neutral delegated-agent definition and task envelope;
- skill/workflow attachment to internal tasks;
- independent child model routing and budgets;
- first-class bounded `delegate_task` execution;
- legacy mode migration and prompt consolidation;
- advanced hash/anchor edit recovery;
- token-aware request pacing and final efficiency certification.

## Product decision

### User-facing modes

Alpha should expose two permanent modes:

| Mode | User contract                                                                                     | Runtime policy                                                      |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Work | Answer questions, investigate, diagnose, modify, execute, verify, and delegate when useful        | Full policy-governed tool surface                                   |
| Plan | Investigate and produce an implementation plan without changing the workspace or external systems | Read/search/inspect only; mutation and external side effects denied |

The product may choose different labels, but the runtime identifiers should remain stable. This document uses `work` and `plan`.

Ask is not required as a permanent mode. A question in Work mode does not authorize mutation. A strict read-only Ask experience can remain as an optional saved preset if users value the visible guarantee.

Orchestrator is not part of the target user surface. Work receives delegation as a policy-governed capability.

### Model choice

Mode and model are independent axes:

```text
user mode + model selection + reasoning/cost settings
```

Each mode can remember a default provider, model, reasoning level, and cost preference. The user can override those values per task. A model change must never silently widen or narrow tool permissions.

Internal tasks receive their own model route and budget. This preserves the useful “different models for different kinds of work” behavior without creating a separate execution mode for every model configuration.

### Internal specialization

Internal work is composed as:

```text
objective + expected output + optional agent kind + policy + skills/workflows + model route + scope + budget
```

These dimensions must remain orthogonal:

- **Objective and expected output** define the work and its result contract.
- **Agent kind** is an optional routing hint for a small set of meaningfully different runtime defaults.
- **Policy** enforces allowed actions and side effects.
- **Skills/workflows** provide reusable domain procedures and validation guidance.
- **Model route** selects provider/model/reasoning/cost behavior.
- **Scope** limits workspace paths, environment, and context.
- **Budget** limits depth, concurrency, time, tokens, and output.

An agent kind, skill, or model route may narrow policy but must never widen the parent task’s authority.

## Target workflows

### User workflow

```text
1. Select Work or Plan.
2. Select a model, or use the mode default.
3. Enter the objective.
4. Approve policy-gated operations when required.
5. Receive one integrated result with evidence.
```

### System workflow

```text
resolve user mode and model
  -> snapshot StepContext and effective policy
  -> parent handles simple work directly
  -> parent may invoke bounded delegate_task for justified isolated work
  -> child receives a scoped task envelope
  -> child returns structured result and evidence
  -> parent integrates, verifies, and completes
```

Direct execution is the default. Delegation is an optimization for complexity, parallelizable discovery, independent review, or specialized workflows; it is not a mandatory stage.

## Core contracts

### User execution profile

```ts
type UserExecutionProfile = {
	id: "work" | "plan"
	displayName: string
	promptFragmentId: string
	policyTemplateId: string
	defaultModelRouteId?: string
}
```

The profile references policy and prompt data. It does not own an execution loop.

### Internal agent definitions

Do not introduce a universal role registry. Start with the smallest set of agent kinds that have a distinct runtime reason to exist:

| Agent kind | Runtime distinction                                                   |
| ---------- | --------------------------------------------------------------------- |
| `general`  | Scoped worker; policy and task contract determine permitted behavior  |
| `explore`  | Read-only discovery worker with an evidence-oriented result contract  |
| `review`   | Independent, non-mutating evaluation of evidence or workspace changes |

The kind is optional. It can select narrow defaults for instructions, context packaging, or result presentation, but it does not grant permissions and is not the primary description of the work. Diagnose, design, implement, verify, document, operate, analyze, and skill-specific workflows remain ordinary objectives expressed through the task envelope.

Add another built-in kind only when evaluations show that it needs a stable runtime distinction that cannot be represented cleanly through objective, expected output, policy, scope, skills, and model route.

### Internal task envelope

```ts
type InternalTaskEnvelope = {
	id: string
	parentTaskId: string
	objective: string
	agentKind?: "general" | "explore" | "review"
	expectedOutput: string[]
	scope: {
		workspaceRoots: string[]
		allowedPaths?: string[]
		sharedWorkspace: boolean
		contextRefs: string[]
	}
	policy: {
		read: boolean
		execute: boolean
		mutate: boolean
		delegate: boolean
		network: boolean
		externalSideEffects: boolean
		requireApproval: boolean
	}
	skills: string[]
	modelRoute: {
		id: string
		provider?: string
		model?: string
		reasoning?: string
	}
	budget: {
		maxDepth: number
		maxConcurrency: number
		maxInputTokens: number
		maxOutputTokens: number
		timeoutMs: number
	}
	dependencies: string[]
}
```

The concrete TypeScript shape can differ, but every field above must have one authoritative runtime owner and be represented in telemetry.

### Structured child result

```ts
type InternalTaskResult = {
	taskId: string
	status: "completed" | "failed" | "denied" | "cancelled" | "timed_out"
	summary: string
	evidence: Array<{ kind: string; reference: string; outcome?: string }>
	changedFiles: string[]
	verification: Array<{ command?: string; status: string; exitCode?: number }>
	remainingRisks: string[]
	usage: { inputTokens?: number; outputTokens?: number; durationMs: number }
}
```

The parent must not treat a child summary as proof. It must use the structured evidence and perform parent-side integration or verification appropriate to the task.

## Compatibility migration

| Legacy mode                | Target mapping                                                |
| -------------------------- | ------------------------------------------------------------- |
| Code                       | Work                                                          |
| General/custom broad modes | Work configuration or custom preset                           |
| Architect                  | Plan                                                          |
| Ask                        | Work request, or optional read-only preset                    |
| Debug                      | Work with a debugging objective and optional debugging skills |
| Orchestrator               | Hidden compatibility alias to Work with delegation available  |

Existing saved tasks, profile assignments, keyboard shortcuts, API inputs, and custom mode identifiers must continue to resolve during migration. Compatibility aliases should be read-compatible but no longer appear as recommended new choices.

Custom modes should migrate to saved configurations over the shared engine:

- optional prompt addition;
- explicit policy template;
- default model route and reasoning setting;
- selected skills;
- no alternate task loop or private tool dispatcher.

## Final implementation phases

### Phase 4 closure — Certify coding-tool and lifecycle contracts

#### Goal

Close the remaining reliability gaps before changing the mode topology.

#### Implementation

- Add content fingerprints and stable anchors to relevant read results.
- Allow edit/patch calls to reference the observed file version when available.
- Reject stale edits with a structured `stale_context` error before writing.
- Attempt deterministic recovery only when the target can be uniquely re-anchored; otherwise require a re-read.
- Preserve external changes and never silently apply a best-effort patch across ambiguity.
- Keep structured `success`, `error`, `denied`, and `cancelled` statuses consistent from tool implementation through event telemetry.
- Retain the shared idempotent completion finalizer for normal final responses and `attempt_completion`.
- Add a deterministic runtime approval-denial test with auto-approval disabled; an automatically approved operation is an invalid test, not a denial pass.
- Clean up test artifacts on success, failure, denial, cancellation, and timeout.

#### Acceptance criteria

- stale content is never silently overwritten;
- uniquely recoverable line drift applies the intended patch and reports recovery metadata;
- ambiguous recovery returns a structured error and preserves the file;
- telemetry status matches the actual tool outcome;
- normal final text completes the frontend lifecycle;
- denied operations emit `approval_result: denied` and `tool_result: denied`;
- focused tool, scheduler, lifecycle, typecheck, lint, and build checks pass.

### Phase 5 — Introduce Work and Plan execution profiles

#### Goal

Replace legacy mode semantics with two profiles over the existing shared engine without changing the UI all at once.

#### Implementation

- Add a provider-neutral `UserExecutionProfile` registry with `work` and `plan`.
- Resolve profile once per step and include its identifier and digest in `StepContext`.
- Derive the model-visible tool schemas and scheduler policy from the same profile snapshot.
- Define Work as the full policy-governed problem-solving surface.
- Define Plan as read/search/inspect only, with no workspace mutation, general command execution, external side effects, or mutating children.
- Keep model/provider/reasoning selection independent from profile resolution.
- Add per-profile default model settings while preserving per-task override.
- Add legacy-mode adapters without removing existing settings or saved-task compatibility.

#### Acceptance criteria

- Work can answer, inspect, edit, execute, verify, and complete using the shared engine;
- Plan cannot execute a mutating tool even if the model requests it directly;
- changing models does not change policy digests or allowed capabilities;
- Code resolves to Work and Architect resolves to Plan for existing tasks;
- Ask, Debug, and Orchestrator remain compatible but are no longer required by the engine;
- existing custom modes continue to load through the adapter;
- profile, policy, prompt, model, and tool digests are recorded per request.

### Phase 6 — Add objective-driven task definitions and skill workflows

#### Goal

Define specialized internal work without creating more user-facing modes, a large role taxonomy, or child execution yet.

#### Implementation

- Add minimal `general`, `explore`, and `review` agent definitions with structured expected-output defaults.
- Add a task-envelope builder that composes objective, expected output, optional agent kind, parent-constrained policy, skills, scope, model route, and budget.
- Resolve skills through the existing skill system and record selected skill identifiers/digests.
- Ensure skill instructions cannot grant tools, paths, network access, or side effects denied by policy.
- Add model-route definitions such as fast, balanced, deep, and user-configured routes without hard-coding providers into agent kinds.
- Add envelope validation, deterministic digests, redaction, and event serialization.
- Exercise envelopes locally in tests before exposing delegation to the model.

#### Acceptance criteria

- a diagnostic objective can receive read/execute policy without mutation;
- an implementation objective can receive scoped mutation without external side effects;
- a verification objective can execute bounded checks without changing source files;
- an agent kind or skill cannot widen parent authority;
- model routes can change model/reasoning/budget without changing policy;
- unknown agent kinds, skills, routes, or invalid scopes fail closed;
- envelopes and results are replayable and redacted.

### Phase 7 — Add bounded delegation and child model routing

#### Goal

Expose one manager-style internal task capability to Work while keeping the parent responsible for the user interaction and final result.

#### Implementation

- Add `delegate_task` as a typed registry tool and scheduler barrier.
- Require a validated `InternalTaskEnvelope` for every child.
- Start with maximum depth one: children cannot delegate.
- Start with two concurrent children maximum per parent.
- Allow parallel children only when scopes and dependencies are independent.
- Propagate cancellation, timeout, denial, and parent shutdown.
- Pass scoped context references rather than copying the entire parent transcript.
- Return `InternalTaskResult` and integrate it into the parent transcript as bounded structured evidence.
- Require parent-side review or verification before completion when a child mutates the workspace.
- Route each child through its explicit model route and record usage independently.
- Keep `new_task` as a compatibility adapter until all existing delegation paths migrate.

#### Delegation guidance

The parent should execute directly when the task is small or tightly coupled. Delegation is justified for:

- independent repository exploration;
- isolated implementation with a clear path boundary;
- diagnosis that can run independently from implementation;
- independent verification or review;
- a domain skill that materially improves the result;
- parallel work whose expected savings exceed child setup and context cost.

#### Acceptance criteria

- simple tasks complete without spawning children;
- a parent can delegate independent Explore and Review work concurrently;
- child results return in deterministic dependency order;
- children cannot exceed parent policy, workspace scope, depth, concurrency, time, token, or output limits;
- cancellation stops pending and active children;
- a failed or denied child does not corrupt the parent transcript;
- child mutation is not accepted as final without parent integration and verification;
- telemetry attributes requests, tools, usage, changes, and outcomes to parent and child IDs.

### Phase 8 — Simplify prompts and migrate the product surface

#### Goal

Remove prompt and mode complexity that the runtime now enforces.

#### Implementation

- Keep one stable system-prompt prefix for the shared engine.
- Add small Work and Plan prompt fragments focused on role, strategy, evidence, and non-negotiable constraints.
- Remove the full mode catalog from every request.
- Remove prompt text that attempts to enforce tool visibility, approval, ordering, cancellation, output limits, child bounds, or completion mechanics.
- Remove the large Orchestrator delegation prompt from the active product path.
- Convert Debug behavior into an ordinary Work debugging objective plus optional debugging skills.
- Convert Ask behavior into ordinary Work request handling or an optional read-only preset.
- Hide legacy modes from new selection while retaining compatibility resolution.
- Update settings, mode/model defaults, command palette entries, onboarding, documentation, and migration telemetry.
- Preserve custom configurations through the shared profile/policy/skill/model schema.

#### Acceptance criteria

- Work and Plan are the only recommended built-in choices;
- old saved tasks and API inputs still resolve predictably;
- Orchestrator is not needed to delegate;
- prompt snapshots are smaller and have a more stable cached prefix;
- policy tests, not prompt assertions, prove enforceable behavior;
- Work answers ordinary questions without mutation unless the request authorizes action;
- Plan cannot mutate even when prompted to do so.

### Phase 9 — Optimize and certify the final harness

#### Goal

Optimize tokens, latency, and orchestration only after the final contracts are stable.

#### Implementation

- Add token-aware request pacing based on estimated input plus reserved output, provider TPM/RPM limits, and observed retry headers.
- Keep fixed delay only as a minimum spacing floor, not the primary limiter.
- Separate initial-request tokens from retry-request tokens in every benchmark report.
- Track context growth by step and identify oversized tool results, repeated environment text, unstable prompt prefixes, and unnecessary verification loops.
- Give children scoped context and hard token/output budgets.
- Measure delegation setup cost against time, token, and quality benefit.
- Add stopping rules for repeated reads, repeated failed commands, redundant verification, and unproductive child spawning.
- Run focused certification plus repeated unchanged end-to-end benchmarks.

#### Certification matrix

| Area          | Required evidence                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Completion    | Normal final text and compatibility completion both close backend and frontend lifecycle                |
| Policy        | Hidden/disallowed/denied tools fail closed and emit correct telemetry                                   |
| Scheduling    | Independent reads overlap; mutations and barriers remain deterministic                                  |
| Context       | Retries reuse context; compaction preserves complete transactions                                       |
| Editing       | Stale edits reject or recover without overwriting external changes                                      |
| Profiles      | Work is capable; Plan is non-mutating; model changes do not alter policy                                |
| Skills        | Skills guide work but cannot grant authority                                                            |
| Delegation    | Children are bounded, cancellable, scoped, attributed, and parent-verified                              |
| Efficiency    | Retry amplification is near zero in uncontended runs and child work has bounded marginal cost           |
| Compatibility | Legacy modes, saved tasks, custom configurations, and extension UI continue to resolve during migration |

## Benchmark strategy

Use focused tests after each implementation slice and the unchanged full benchmark at phase boundaries. Do not use a rate-limit-contaminated run as an orchestration comparison.

For every full run, report:

- final task outcome and verification evidence;
- initial model requests and retry requests separately;
- initial, retry, output, and cache-read tokens;
- maximum and average request context;
- tool calls per response and batch-size distribution;
- failed commands and recovery loops;
- compaction events;
- child count, agent kind, objective, model route, context size, usage, and outcome;
- wall time excluding explicit approval waits when comparing autonomous performance;
- artifacts left behind.

Run repeated trials before claiming a quality or efficiency improvement. A single successful run proves compatibility, not a statistically meaningful performance gain.

## Non-goals

- Do not create a user-facing mode or permanent internal role for every kind of work.
- Do not let skills or prompts bypass policy.
- Do not delegate every task.
- Do not copy the full parent transcript into every child.
- Do not bind an agent kind permanently to one vendor or model.
- Do not preserve Orchestrator as a separate execution engine.
- Do not optimize prompts before profile, policy, delegation, and completion contracts are stable.
- Do not judge token efficiency from totals that combine initial requests with rate-limit retries.

## Final target

```text
User chooses Work or Plan
  + user chooses model/reasoning/cost
  -> one shared turn engine
  -> one immutable step context
  -> one registry, scheduler, and policy boundary
  -> direct execution by default
  -> optional bounded children composed from objective + expected output + optional agent kind + policy + skills + model route
  -> parent integrates and verifies
  -> one completion lifecycle and replayable event stream
```

The result is simpler for users and internally: two meaningful modes, independent model choice, and an extensible orchestration substrate that represents diagnosis, implementation, verification, operations, documentation, analytics, and skill-driven workflows through explicit task contracts instead of an ever-growing mode or role registry.
