# Alpha Code documentation

Start with [AGENTS.md](../AGENTS.md) for engineering requirements and the [repository README](../README.md) for setup.
This directory keeps compatibility contracts and operating guides. Source, schemas, and tests define current behavior;
use the owning checks to establish behavior for a new revision.

| Area                                       | Maintained guide                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and delegation                | [Engineering invariants](../AGENTS.md#agent-harness-architecture-invariants), [managed-agent lifecycle](subagent-lifecycle-hardening.md)                                              |
| Tool policy and workspace protections      | [Approval policy](approval-mode-policy.md), [command and path approval](command-sandbox.md)                                                                                           |
| Saved task and configuration compatibility | [CLI retirement](cli-retirement.md), [mode retirement](mode-retirement.md), [provider recovery](provider-reduction.md)                                                                |
| Context, completion, and recovery          | [Compaction](context-compaction.md), [completion evidence](completion-evidence.md), [rewind and reload](rewind-reload-recovery.md), [webview recovery](webview-lifecycle-recovery.md) |
| Instructions and skills                    | [Instruction and skill selection](instruction-skill-reliability.md), [review skill](review-agent-skill.md)                                                                            |
| Repository discovery                       | [Index retrieval](code-index-retrieval.md), [GitHub CLI](github-cli.md)                                                                                                               |
| Integrated extension features              | [HTML documents](html-documents.md), [scheduled tasks](scheduled-tasks.md), [keyboard shortcuts](agent-hotkeys.md), [reasoning preferences](task-reasoning.md)                        |
| Local validation                           | [Testing workflow](testing-harness.md), [evidence runbook](harness-evidence.md), [core confidence](core-confidence.md)                                                                |
| VS Code hosts                              | [Minimum 1.125.0 and reference 1.138.0 contract](vscode-1.138-migration.md), [dedicated live profiles](vscode-live-test-profiles.md)                                                  |
| Managed-agent acceptance                   | [Milestone certification](certification/managed-agent-milestone-certification.md), [live acceptance](certification/managed-agent-live-acceptance.md)                                  |
| Evaluation inputs and commands             | [Corpus guide](../evals/README.md), [evaluator guide](../packages/evals/README.md)                                                                                                    |

Use current [Codex CLI source and tests](https://github.com/openai/codex) first for intended agent behavior, then
[official Codex guidance](https://developers.openai.com/codex/cli) for product context. For host contracts, consult the
[VS Code extension API](https://code.visualstudio.com/api),
[Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model), and
[extension compatibility guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#visual-studio-code-compatibility).
Current upstream documentation does not replace Alpha's minimum-host checks or its own approval and workspace protections.

Maintain lasting architecture, compatibility, and operating guidance in the topic guides above. Keep temporary analysis,
findings, fix summaries, and validation logs in change descriptions or local evidence. Removed investigation notes remain
in Git history. Versioned evaluation inputs and historical task/evaluation data retain their separate preservation
contract in the [corpus guide](../evals/README.md).

Local logs and superseded VSIX files are disposable build output. Keep release candidates and investigation evidence
until their validation or comparison is complete. UI screenshots, host receipts, and generated workspaces in
`artifacts/` support evaluation and certification; they are excluded from the shipped VSIX.
