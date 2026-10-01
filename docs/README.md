# Extension development documentation

Start with the [engineering guide](../AGENTS.md) for ownership, invariants, and required checks, and the
[repository README](../README.md) for setup and build commands. This directory keeps maintained contracts and operating
guides. Check implementation details against current source and tests; dated measurements describe their recorded runs.

| Area                                                | Guide                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Local testing and evidence workflow                 | [Testing harness](testing-harness.md)                                                                           |
| Evaluator reports and diagnostics                   | [Paired reports](harness-implementation-experiments.md), [diagnostics](harness-implementation-diagnostics.md)   |
| Agent architecture and certification requirements   | [Multi-agent concurrency](multi-agent-concurrency-spec.md)                                                      |
| Turn sequencing and current Codex prompt alignment  | [Agent turn path trace](agent-turn-path-trace.md)                                                               |
| Retired CLI and historical evaluation compatibility | [CLI retirement](cli-retirement.md)                                                                             |
| Code/Plan modes and saved-task compatibility        | [Mode retirement](mode-retirement.md)                                                                           |
| Model tool catalogs and historical aliases          | [Tool surface refactor](tool-surface-refactor.md), [implementation checks](tool-surface-refactor-validation.md) |
| Approval modes and command/path approval            | [Approval-mode policy](approval-mode-policy.md), [command and path approval](command-sandbox.md)                |
| Context budgets and compaction                      | [Context compaction](context-compaction.md)                                                                     |
| Completion checks and saved acceptance evidence     | [Completion evidence](completion-evidence.md)                                                                   |
| Turn completion lifecycle diagnosis                 | [Turn completion investigation](turn-completion-investigation.md)                                               |
| Indexing, retrieval, and index compatibility        | [Code index retrieval](code-index-retrieval.md)                                                                 |
| File-search arguments and results                   | [File search](search-files.md)                                                                                  |
| Native tool-surface refactor (implementing prompt)  | [Tool surface refactor](tool-surface-refactor.md)                                                               |
| HTML preview security, lifecycle, and limits        | [HTML documents](html-documents.md)                                                                             |
| Scripted core-loop checks and bounded live checks   | [Core confidence](core-confidence.md)                                                                           |
| Owned VS Code test profiles and runner options      | [Live-test profiles](vscode-live-test-profiles.md)                                                              |
| Managed-agent deterministic release gate            | [Milestone certification](certification/managed-agent-milestone-certification.md)                               |
| Managed-agent integration procedures                | [Live acceptance](certification/managed-agent-live-acceptance.md)                                               |
| Proportional-scope evaluation contract and evidence | [Efficiency acceptance](nor36-efficiency-acceptance.md)                                                         |
| Provider connections and recovery                   | [Provider reduction](provider-reduction.md)                                                                     |

Feature-specific details live with the [agent kernel](../src/core/agent/), [tools](../src/core/tools/),
[provider adapters](../src/api/providers/), [ticket store](../src/services/tickets/), and [webview](../webview-ui/src/).
The installed [debug](../src/assets/skills/debug/SKILL.md) and
[rich-documents](../src/assets/skills/rich-documents/SKILL.md) skills contain their own workflows and references.

Completed migration plans, historical research notes, dated scorecards, and one-off acceptance reports are not current
guidance; committed versions remain available in Git history. The six files in [benchmarks/](benchmarks/) remain as
evidence cited by the retained evaluation contracts.
