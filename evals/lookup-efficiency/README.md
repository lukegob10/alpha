# Lookup-efficiency fixtures

Tiny synthetic workspaces and a frozen four-prompt set for measuring **production-shaped lookup cost**. They are a sibling of the proportional-scope suite, not a replacement.

Scripted traces in `scripts/evals/lookup-efficiency-report.test.mjs` prove the reporter and measurement contract. They are not a live-model budget. The NOR-36 scripted narrow-lookup class remains a different measurement: **2 model requests / 1 tool result** on the unchanged proportional-scope fixture (`docs/nor36-efficiency-acceptance.md`). Do not change those seven fixtures or their scripts to manufacture a lookup improvement.

Live Copilot or other provider samples are a **separate recorded run**. One live sample is not a general quality or speed improvement. This subset is `unadmitted` and does not require Postgres, Redis, or `pnpm test:evals:offline`.

## Frozen prompts

See [prompts.md](prompts.md). Cases: named-function definition (positive), named output-path writer (positive, generic recorder), missing symbol (negative), README-stated config default (optional fourth). Workspaces include similarly named decoys so shotgun `list_files` is tempting but wrong. Prompts are generic; they are not overfit to Alpha-Code or this product's logs.

## Run

From the repository root with Node 24.14.1:

```sh
node --test scripts/evals/lookup-efficiency-report.test.mjs
node scripts/evals/lookup-efficiency-report.mjs observations.json report.json
node scripts/evals/lookup-efficiency-pair.mjs reference-run.json candidate-run.json pair.json
```

The reporter consumes existing `EvalTraceEvent` records (the same normalized shape `packages/evals/src/cli/processTask.ts` already emits). It also accepts persisted `agent_turn_events.jsonl` rows. It projects allowlisted counters only: never prompts, secrets, tool arguments, file bodies, commands, paths, IDs, or output text.

## Capture a live sample

Do not wait for an unimplemented NOR-48 live eval adapter. Wrap evidence the campaign and `processTask` paths already write.

1. Predeclare `declaredSampleCount`, model id, reasoning preference (effort), and cache warm/cold **before** the run. Use the tiny workspaces under `workspaces/` (or a frozen copy). Pair later on the same prompt ids.
2. Run each prompt in the real VS Code extension (live Copilot through the existing campaign `--provider live-copilot` path, or an evals `processTask` VS Code execution). Keep the same model/effort for reference and candidate.
3. After the task finishes, copy the **raw** `agent_turn_events.jsonl` from task storage (`tasks/<taskId>/agent_turn_events.jsonl`) or from the evals log (`<language>-<exercise>.<iteration>_agent_turn_events.jsonl`). Do **not** use campaign `*.projection.json` files: those hash tool names and cannot feed lookup counters.
4. Wrap one sample as `observations.json` with identity and optional usage/completion observers. Missing usage must be omitted so the reporter emits `unavailable`, never a silent zero.

```json
{
	"fixtureId": "symbol-definition",
	"measurementKind": "live-supplemental",
	"traceCoverage": "complete",
	"declaredSampleCount": 3,
	"sampleIndex": 0,
	"revision": "<40-character git SHA>",
	"workingTree": "clean",
	"modelId": "<exact model id>",
	"reasoningPreference": "high",
	"cacheState": "cold",
	"trace": [],
	"usage": {},
	"completionStage": {},
	"timing": {}
}
```

Parse JSONL records into `trace` as an array. `buildReport` / `traceFromPersistedAgentTurns` flatten `{ sequence, timestamp, event }` rows. If the adapter reported `reasoningTokens`, put them on `usage.reasoningTokens` or every `usage.requestUsage[]` row. Otherwise omit them. A local tokenizer estimate belongs only on `usage.localReasoningTokenEstimate`. Completion rejections and backgrounded-command counts come from an explicit observer (`completionStage`); they are not inferred from assistant prose or command text.

5. Project with the reporter, then pair reference vs candidate runs that share prompt ids, declared sample count, model, reasoning preference, and cache state. Revisions may differ.

## Attribution contract

Allowlisted report fields: git SHA, dirty flag, model id, reasoning preference, cache warm/cold, declared sample count, `measurementKind`, `traceCoverage`, provider requests and retries, tool results by allowlisted name, distinct search tools (`codebase_search` / `search_files` / `list_files` / `shell`), first tool name, skill/ticket/spawn/todo/`attempt_completion` counts, completion rejection counts and allowlisted reason codes, adapter reasoning tokens **or** a separately labeled local estimate, wall time to first grounded answer, time to durable completion, and backgrounded commands still running at first answer.

`shell` and historical `execute_command` count as the `shell` search tool. Command text is never inspected, so a Select-String-like search is visible only as `shell`. Unknown tool names become `other`.

## Predeclared acceptance bar

Starting bar, to revise with a baseline in hand (not a 25%/20% claim):

- ≤3 provider requests and ≤4 tool results
- first tool is `search_files`, `read_file`, or one `codebase_search`
- zero skill, ticket, spawn, todo, and `attempt_completion` results
- first grounded answer without a completion rejection

Unavailable required counters fail the bar rather than counting as zero. Passing the bar on a `reporter-contract-test` trace is contract coverage, not a live measurement.
