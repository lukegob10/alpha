# Optional presentation model calls, 2026-10-20

Governed task runs can now opt out of automatic model-generated titles and reasoning synopses with the host-owned
`presentationModelCalls: false` option. Visible reasoning, main task requests, tools, and normal interactive defaults
remain unchanged. The option is a task admission property, outside provider configuration and model tool arguments.

## Finding and scope

Automatic title generation created a separate provider handler and request outside the task transcript. The title
reader did not record usage chunks in task accounting. A task's observed cost and request count therefore could not
establish a bound on that optional request. Historical task-event totals do not prove total provider charges.

Reasoning synopses already retain reported usage in `reasoningSummaryUsage`, consolidated into normal task metrics.
However, they are optional asynchronous presentation work: a 750 ms timer can start a request that is still active at
the main task's terminal snapshot. Their existing cancellation does not provide a financial reservation or a terminal
join. Suppressing both optional paths before allocation gives governed runs a consistent admission contract without
adding another accounting engine or a new draining framework.

The change affects only automatic titles and generated reasoning synopses. It does not suppress visible reasoning,
compaction, normal task output, tool calls, or explicitly requested work.

## Admission and persistence

- `Task` captures a readonly optional false-only property. Explicit creation policy, saved history, and inherited
  parent/root policy combine conservatively: any `false` retains the opt-out.
- `AlphaProvider` captures settings at fresh-task and history-restore admission. A finite positive `allowedMaxCost` or
  `allowedMaxRequests` also opts out. Zero, null, undefined, and non-finite values keep their existing unlimited/default
  interpretation for this decision.
- Both scheduling methods return before creating a title handler/controller or a synopsis object/timer when opted out.
  The existing enabled-path deadlines, cancellation, disposal, and normal title behavior are unchanged.
- `saveAlphaMessages` passes the immutable property through `taskMetadata`, which emits the optional `false` field in
  `HistoryItem`. Old history without the field retains interactive behavior. No migration is required.
- Managed and legacy delegated children inherit their root/parent task's suppression. Independent peer creation copies
  the parent's policy explicitly because it intentionally does not use the managed-child parent pointer.
- Fallback peer-history creation and cold forks preserve suppression. A fork retains it if the caller, live source, or
  saved source is opted out. Restoration also retains a live predecessor's opt-out when its saved snapshot is older.

Existing per-task history storage, atomic writes, and restoration remain the persistence path. There is no new registry,
cache, provider-specific flag, or model-controlled way to enable optional requests. The public API and IPC negotiation
advertise `presentationModelCallOptOut`; governed evaluators require the capability before relying on the option.

## Current Codex comparison

The reference is Codex commit
[`18795fc12571a3530d3e4ac18366e41cd2f57448`](https://github.com/openai/codex/tree/18795fc12571a3530d3e4ac18366e41cd2f57448),
retrieved on 2026-10-20. Its interactive TUI
[starts automatic naming from an unnamed user message](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/app/thread_routing.rs#L2046)
and [owns a deduplicated cancellable auxiliary request](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/app/thread_title.rs#L61).
The title request uses a
[temporary feature thread](https://github.com/openai/codex/blob/18795fc12571a3530d3e4ac18366e41cd2f57448/codex-rs/tui/src/temporary_structured_request.rs#L140).
The inspected noninteractive `exec` source has no automatic title-generator reference; this is not a claim that every
Codex mode suppresses titles or that upstream provides Alpha's financial admission contract.

Alpha preserves interactive naming while giving bounded host runs explicit control over optional presentation work.
Automatically suppressing it under Alpha's finite cost/request limits is an intentional financial-policy safeguard.
The implementation stays in Alpha's existing TypeScript task and VS Code adapters; no upstream runtime code or sandbox
architecture was copied.

## Regression evidence

Before the fix, controlled tests produced **16 intended failures**:

- Opted-out title work still created a presentation provider.
- Opted-out reasoning still scheduled the synopsis timer.
- Explicit, parent, root, and saved policies were not captured.
- Metadata lost the false-only field during serialization.
- Fresh and restored finite positive task limits did not suppress optional work.
- Live restoration, independent creation, and forks lost suppression.

After the fix, the primary five-file run passed **589/589** cases. Adjacent title, synopsis, task persistence, and shared
history tests passed **522/522** cases, including an additional real `startTask` entry test proving the main task still
starts with its original human message and creates no title provider. Counting each file only once, the latest results
cover **696 passing cases across nine files**, with no failures or skips. All runs used one worker and controlled local
fixtures, with no model or network requests.

Existing generated-title success, managed-child title exclusion, manual rename cancellation, title preparation timeout,
late cancellation, synopsis usage retention, and persistence behavior were exercised. Extension typechecking, scoped
ESLint, scoped Prettier, and the scoped whitespace check passed.

Raw JSON is retained under `artifacts/testing-2026-10-20/presentation-policy/` as `runtime-red.json`,
`propagation-red.json`, `runtime-green.json`, and `adjacent-green.json`. The main testing pass owns subsequent packaging,
the exact VS Code 1.138.0 host gate, and governed live evidence. These local regressions do not certify historical live
runs, unknown provider usage, actual invoices, or a hard monetary ceiling for an already in-flight main request.
