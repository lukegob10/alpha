# Extension development documentation

Start with [AGENTS.md](../AGENTS.md) for engineering requirements and the [repository README](../README.md) for setup.
This directory keeps compatibility contracts and operating guides. Source, schemas, and tests define current behavior;
historical validation records apply only to their recorded revisions.

| Area                                       | Maintained guide                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent architecture and delegation          | [Multi-agent concurrency](multi-agent-concurrency-spec.md)                                                                                                                                               |
| Saved task and configuration compatibility | [CLI retirement](cli-retirement.md), [mode retirement](mode-retirement.md), [provider recovery](provider-reduction.md)                                                                                   |
| Tool policy and workspace protections      | [Approval policy](approval-mode-policy.md), [command and path approval](command-sandbox.md)                                                                                                              |
| Context and completion                     | [Compaction](context-compaction.md), [completion evidence](completion-evidence.md), [reasoning preferences](task-reasoning.md)                                                                           |
| Repository discovery                       | [Index retrieval](code-index-retrieval.md), [file search](search-files.md), [GitHub CLI](github-cli.md)                                                                                                  |
| Integrated extension features              | [HTML documents](html-documents.md), [scheduled tasks](scheduled-tasks.md)                                                                                                                               |
| Local validation and retained evidence     | [Testing workflow](testing-harness.md), [evidence runbook](harness-evidence.md), [core confidence](core-confidence.md)                                                                                   |
| Exact-host and live acceptance             | [Dedicated profiles](vscode-live-test-profiles.md), [milestone certification](certification/managed-agent-milestone-certification.md), [live acceptance](certification/managed-agent-live-acceptance.md) |
| Evaluation corpus and historical results   | [Evaluation directory guide](../evals/README.md), [evaluator commands](../packages/evals/README.md)                                                                                                      |

The [provider convergence record](convergence-context-provider-2026-10-03.md) retains provenance cited by source.
The [October 3 findings](testing-suite-failures-2026-10-03.md) and [October 4 corrections](codex-cli-convergence-fixes-2026-10-04.md)
retain acceptance criteria and validation limits. Recheck them against current tests before treating a historical defect
or result as current.

Completed research notes, migration prompts, dated reviews, and one-off investigation documents were removed from the
working tree; their committed versions remain in Git history. Benchmark reports and old Frontier campaign snapshots
are preserved under `evals/reports/` and `evals/archive/`.

Local logs and superseded VSIX files are disposable build output. Keep release candidates and investigation evidence
until their validation or comparison is complete. UI screenshots, host receipts, and generated workspaces in
`artifacts/` support evaluation and certification; they are excluded from the shipped VSIX.
