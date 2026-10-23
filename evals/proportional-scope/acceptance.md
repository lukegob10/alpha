# Proportional-scope measurement and acceptance

This lane measures request preparation and the fixed engine/scheduler workloads. Declare the reference and candidate
source/build identities before each comparison. Both sides must pass the same quality oracle; incomplete or failed
work cannot serve as an equal-quality cost baseline. Retained historical reports remain evaluation data in
[reports/nor36](../reports/nor36/), separate from this current procedure.

## Measurement contract

The existing seven [proportional-scope fixtures](README.md), prompts, scripted actions,
repairs, and quality assertions remain unchanged. Run three independent invocations, each with fresh temporary fixture
workspaces. Preserve their raw privacy-safe reports and phase attribution. An invocation's existing internal sample index
is zero; an external repetition ordinal identifies the three separate runs. Their real engine/scheduler execution still
uses fixture tools and fixed decisions. It does not measure production Task prompts, adaptive strategy, approval enforcement,
or durable completion. Unknown provider usage and timing stay unavailable.

The added [request preflight measurement](../../scripts/benchmarks/nor36-request-preflight.spec.ts) invokes the actual
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

The request-preparation regression contract requires:

- Each noncompacting continuation must make **one** catalog-builder call. Record actual schema-factory
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

Catalog-call reductions measure local request preparation. Whole-task tool, token, or latency improvements require
their own repeated comparable workloads and cannot be inferred from this fixture's fixed decisions.

## Paired evidence admission

The small [comparison helper](../../scripts/evals/proportional-scope-compare.mjs) admits only complete seven-class sample
sets with passing completed outcomes, clean consistent source identities, matching fixture/policy/full-harness/oracle/
configuration/cache declarations, complete phase attribution, and matching sample ordinals. It rejects a failed-quality
reference, script changes, partial coverage, and missing samples. Missing usage remains unavailable; local estimates or
bytes cannot be admitted as provider usage. Full identity hashes and provider provenance are caller declarations whose
authenticity the helper cannot establish. Existing engine reports omit a cache declaration, so they alone cannot establish
an admitted paired performance run; report that limitation rather than inventing a cache state.

## Commands and external prerequisites

Use Node 24.21.0, npm 11.19.0, and pnpm 11.24.0. Frozen dependency installation and the existing types build are setup requirements.

```sh
node --test scripts/evals/proportional-scope-report.test.mjs scripts/evals/proportional-scope-compare.test.mjs
pnpm --dir src test core/agent/__tests__/proportionalScope.integration.spec.ts
pnpm --dir src exec vitest run --config ../../scripts/benchmarks/nor36-request-preflight.config.ts
pnpm --dir src exec tsc --noEmit --project ../../scripts/benchmarks/nor36-request-preflight.tsconfig.json
pnpm exec eslint --config src/eslint.config.mjs scripts/benchmarks/nor36-request-preflight.spec.ts scripts/benchmarks/nor36-request-preflight.config.ts scripts/evals/proportional-scope-compare.mjs scripts/evals/proportional-scope-compare.test.mjs --max-warnings=0
```

Set `ALPHA_NOR36_PREFLIGHT_REPORT` to an output JSON filename outside the measured checkout. Set `ALPHA_SCOPE_REPORT_DIR`
to a separate output directory for each engine invocation. Commit measurement source before final baseline/candidate
runs. Retain full source and harness identities. Run the exact VS Code 1.138.0 reference gate and affected
context/completion suites after implementation; host adapter changes also require the 1.125.0 compatibility gate.

Live strategy evidence requires an authorized configured provider through a documented Alpha interface and a declared
repeated workload/model/cache/quality protocol. See [live tests](../../README.md#live-tests)
for current Copilot setup and [testing](../../README.md#testing) for host gates. Scripted structural
evidence can proceed without provider credentials. Never use missing live measurements as a zero-cost observation.
