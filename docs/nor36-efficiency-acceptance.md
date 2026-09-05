# NOR-36 independent efficiency acceptance

September 5, 2026. Production reference: current `main-v2` at
`8b574a6cbfa8a2ca90fd296878e6410fb6b6c208`, including the completed NOR-33/NOR-37 corrections. This lane owns
measurement and independent acceptance; implementation and final host gates are coordinated separately. Historical
failed-completion references are excluded from equal-quality comparisons.

## Measurement contract

The existing seven [proportional-scope fixtures](../evals/proportional-scope/README.md), prompts, scripted actions,
repairs, and quality assertions remain unchanged. Run three independent invocations, each with fresh temporary fixture
workspaces. Preserve their raw privacy-safe reports and phase attribution. An invocation's existing internal sample index
is zero; an external repetition ordinal identifies the three separate runs. Their real engine/scheduler execution still
uses fixture tools and fixed decisions. It does not measure production Task prompts, adaptive strategy, approval enforcement,
or durable completion. Unknown provider usage and timing stay unavailable.

The added [request preflight measurement](../scripts/benchmarks/nor36-request-preflight.spec.ts) invokes the actual
`Task.attemptApiRequest`, `manageContext`, native catalog builder, task catalog cache, and immutable step capture. The
bounded Task prototype seam injects lifecycle/UI methods, a fixed system prompt, and an offline provider. It preserves a
fixed user question, assistant tool call with opaque reasoning state, and its successful result. Existing NOR-28 catalog
fixtures supply no MCP tools, a small catalog, and a large catalog. Three new task catalog instances per configuration
share the process and local tokenizer. Provider prompt caching is disabled. The configuration enables the final primary
task read grant and keeps context safely below the compaction threshold.

For each measured continuation, record catalog builder calls, actual native-schema factory calls (inside cache misses),
provider requests, emitted tools, executed commands, system/message/schema bytes, local input-token estimates, output text
bytes, and logical request/schema digests. Digests cover actual outgoing content and metadata except task/request/attempt
IDs, cancellation signal, and deadline. Assertions exclude absolute workspace paths from this fixed outgoing request;
no arbitrary content normalization hides changes. No raw content, paths, prompts, credentials, or IDs enter reports.

Local tokens use Alpha's existing `o200k_base` estimator with its **1.5 safety multiplier**, separately over system text,
JSON messages, and JSON schemas. These are reproducible local estimates, not exact provider serialization or billing.
Provider input/cache/output usage remains `null`; the offline provider does not emit usage. This preflight seam does not
establish whole-task completion or time to useful answer.

## Baseline and predeclared acceptance

Before candidate integration, the first exploratory run on unchanged production source passed all nine preflight samples:
each made two catalog-builder calls and one provider request, preserved the fixed request/history/response, and captured
the final read grant. Schema byte counts were 33,033 / 34,204 / 33,676 for no/small/large MCP catalogs. Local schema-token
estimates were 10,665 / 11,034 / 10,868. Measurement files were uncommitted during this exploratory run, so clean-source
reports are required for final pairing. The existing engine/scheduler cases passed 7/7; the original reporter/calibration
tests passed 23/23.

Acceptance, declared before integrating runtime edits:

- Each noncompacting continuation must make **one** catalog-builder call instead of two. Record actual schema-factory
  calls to distinguish cache hits from rebuilt work. Do not translate either count reduction into a wall-time percentage.
- All nine requests must preserve logical request/schema digests, byte counts, local token estimates, response text,
  model/tool/command counts, tool transactions, opaque history, and final read-grant authority.
- The authoritative context manager must still prepare tools before forced/full counts, actual compaction, or fallback
  truncation. Preview-false/count-true, invalid counts, cancellation/deadline, and fresh final policy remain mandatory
  owning regressions. Existing retry and production tool-catalog tests remain relevant.
- Invocation-local instruction discovery may share only directory discovery. Rule content reads, root/global authority,
  instruction order, injected-AGENTS behavior, and a fresh next invocation must remain intact. Scope the scan reduction to
  `enableSubfolderRules`; validate enabled/disabled/injected AGENTS variants independently.
- All seven unchanged class oracles must continue passing, including complex/security/audit/escalation coverage. Do not
  shorten actions or weaken required checks to produce a lower counter.

The proposed broad 25% tool/command and 20% input-token improvements remain unproven. The chosen interventions remove
local request-preparation work; outgoing request tokens and fixed model decisions are expected to stay unchanged.

## Paired evidence admission

The small [comparison helper](../scripts/evals/proportional-scope-compare.mjs) admits only complete seven-class sample
sets with passing completed outcomes, clean consistent source identities, matching fixture/policy/full-harness/oracle/
configuration/cache declarations, complete phase attribution, and matching sample ordinals. It rejects a failed-quality
reference, script changes, partial coverage, and missing samples. Missing usage remains unavailable; local estimates or
bytes cannot be admitted as provider usage. Full identity hashes and provider provenance are caller declarations whose
authenticity the helper cannot establish. Existing engine reports omit a cache declaration, so they alone cannot establish
an admitted paired performance run; report that limitation rather than inventing a cache state.

## Commands and external prerequisites

Use Node 20.19.2 and pnpm 10.8.1. Frozen dependency installation and the existing types build are setup requirements.

```sh
node --test scripts/evals/proportional-scope-report.test.mjs scripts/evals/proportional-scope-compare.test.mjs
pnpm --dir src test -- core/agent/__tests__/proportionalScope.integration.spec.ts
pnpm --dir src exec vitest run --config ../scripts/benchmarks/nor36-request-preflight.config.ts
pnpm --dir src exec tsc --noEmit --project ../scripts/benchmarks/nor36-request-preflight.tsconfig.json
pnpm exec eslint --config src/eslint.config.mjs scripts/benchmarks/nor36-request-preflight.spec.ts scripts/benchmarks/nor36-request-preflight.config.ts scripts/evals/proportional-scope-compare.mjs scripts/evals/proportional-scope-compare.test.mjs --max-warnings=0
```

Set `ALPHA_NOR36_PREFLIGHT_REPORT` to an output JSON filename outside the measured checkout. Set `ALPHA_SCOPE_REPORT_DIR`
to a separate output directory for each engine invocation. Commit measurement source before final baseline/candidate
runs. Retain full source and harness identities. The orchestrator owns final integrated exact VS Code 1.122.1 smoke,
targeted context/completion suites, managed certification when applicable, and any quiet paired elapsed-time window.

The documented live E2E path is `apps/vscode-e2e/src/suite/index.ts`: `--provider live` requires
`OPENROUTER_API_KEY` and selects `openai/gpt-4.1` through OpenRouter. In this isolated checkout the variable and
`apps/vscode-e2e/.env.local` are absent. No secret store, unrelated authentication, or credential file was inspected.
Broader live strategy evidence requires an authorized configured provider through a documented Alpha interface and a
declared repeated workload/model/cache/quality protocol; deterministic structural evidence can proceed independently.

Two actual GPT-6 Astra medium subagents contributed: `/root/measurement_audit` reviewed the seven-class evidence and
implemented the bounded paired admission helper; `/root/runtime_oracle_audit` independently reviewed existing read/context
invariants and the candidate compaction/instruction diff. The lead integrates and verifies their work.
