# Extension development documentation

Start with the [engineering guide](../AGENTS.md) for ownership, invariants, and required checks, and the
[repository README](../README.md) for setup and build commands. This directory keeps maintained contracts and operating
guides. Check implementation details against current source and tests; dated measurements describe their recorded runs.

| Area                                                | Guide                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Corporate migration and harness development         | [Migration roadmap](corporate-migration-roadmap.md)                                                                                  |
| Local testing, evaluation and evidence workflow     | [Testing harness](testing-harness.md)                                                                                                |
| Docker-free corporate evaluation and closure        | [Native workflow](harness-docker-free.md), [follow-up audit](harness-follow-up-audit.md), [acceptance](harness-acceptance-status.md) |
| Local host acceptance experiments                   | [Runnable checks and retained evidence](harness-local-acceptance.md), [rendered UI](harness-ui-acceptance.md)                        |
| Research basis and implementation verification      | [Harness research](harness-development-research.md), [progress](harness-implementation-progress.md)                                  |
| Agent architecture and certification requirements   | [Multi-agent concurrency](multi-agent-concurrency-spec.md)                                                                           |
| Retired CLI and historical evaluation compatibility | [CLI retirement](cli-retirement.md)                                                                                                  |
| Code/Plan modes and saved-task compatibility        | [Mode retirement](mode-retirement.md)                                                                                                |
| Command approval and outside-workspace paths        | [Command and path approval](command-sandbox.md)                                                                                      |
| Context budgets and compaction                      | [Context compaction](context-compaction.md)                                                                                          |
| Completion checks and saved acceptance evidence     | [Completion evidence](completion-evidence.md)                                                                                        |
| Turn completion lifecycle diagnosis                 | [Turn completion investigation](turn-completion-investigation.md)                                                                    |
| Indexing, retrieval, and index compatibility        | [Code index retrieval](code-index-retrieval.md)                                                                                      |
| File-search arguments and results                   | [File search](search-files.md)                                                                                                       |
| HTML preview security, lifecycle, and limits        | [HTML documents](html-documents.md)                                                                                                  |
| Scripted core-loop checks and bounded live checks   | [Core confidence](core-confidence.md)                                                                                                |
| Owned VS Code test profiles and runner options      | [Live-test profiles](vscode-live-test-profiles.md)                                                                                   |
| Focused Copilot file-edit and read probes           | [File-tool live tests](file-tools-live-tests.md)                                                                                     |
| Managed-agent deterministic release gate            | [Milestone certification](certification/managed-agent-milestone-certification.md)                                                    |
| Managed-agent integration procedures                | [Live acceptance](certification/managed-agent-live-acceptance.md)                                                                    |
| Proportional-scope evaluation contract and evidence | [Efficiency acceptance](nor36-efficiency-acceptance.md)                                                                              |

Feature-specific details live with the [agent kernel](../src/core/agent/), [tools](../src/core/tools/),
[provider adapters](../src/api/providers/), [ticket store](../src/services/tickets/), and [webview](../webview-ui/src/).
The installed [debug](../src/assets/skills/debug/SKILL.md) and
[rich-documents](../src/assets/skills/rich-documents/SKILL.md) skills contain their own workflows and references.

Completed plans, comparative scorecards, investigation diaries, and one-off validation reports are not maintained as
parallel specifications. Committed versions remain in Git history. The 2026-09-17 documentation cleanup also preserved
the exact working copies, including uncommitted updates, under
`F:/alpha-vscode-e2e-runs/docs-cleanup-20260917/archive/docs/`, with a SHA-256 removal manifest in its parent run directory.
The six files in [benchmarks/](benchmarks/) remain as evidence cited by the retained evaluation contracts.
