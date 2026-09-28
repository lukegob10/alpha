# Codex CLI convergence boundary

Reference: pinned Codex CLI source commit `e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1`, inspected on
2026-09-26. The reference informs behavior and ordering; Alpha retains its TypeScript extension runtime, provider
adapters, three-tier Ask/Auto/Full Access approval UI, Alpha Tickets, and VS Code 1.122.1 release host. No Codex
runtime or process sandbox is imported.

## Decisions in this change

- The shared `AgentTurnEngine`, captured step/tool surface, and `ToolScheduler` remain the one agent loop. The inspected
  prompt and provider contracts did not justify a second loop or a copied Codex prompt.
- Explore and Review children have `execute: false` in their captured authority. They may use the scheduler's bounded,
  isolated Git/ripgrep reader when its complete eligibility checks pass. The ordinary shell adapter denies their
  commands, including a command that looked read-only but could not use the isolated reader. Worker command approval
  stays within inherited policy. This is an execution-policy boundary in Alpha's own code, not an OS sandbox claim.
- MCP tool calls use the same Ask/Auto/Full Access decision path as runtime approval. Server annotations are context for
  review and never create an allow grant. A saved allow grant matches the resolved tool and server source; old source-less
  approval records remain readable.
- Optional post-turn compaction defaults to off (`0`). A saved nonzero percentage still enables it at a settled turn
  boundary. Provider context-error recovery remains available independently.
- The live Copilot Tickets probe requires the model to call `list_tickets` and checks its persisted transaction. The
  rendered 1.122.1 fixture checks activity trace, file-change review, and the immutable VS Code diff opened from a
  persisted command edit.

Codex ordering references: [MCP preparation and approval](https://github.com/openai/codex/blob/e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1/codex-rs/core/src/mcp_tool_call.rs),
[parallel tool execution](https://github.com/openai/codex/blob/e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1/codex-rs/core/src/tools/parallel.rs),
and [turn completion/compaction](https://github.com/openai/codex/blob/e0ef5a1a0f6421601baaa679fb37eddaa4e9c8c1/codex-rs/core/src/session/turn.rs).
Alpha's exact execution and approval contracts are described in [approval-mode-policy.md](approval-mode-policy.md),
[context-compaction.md](context-compaction.md), and [multi-agent-concurrency-spec.md](multi-agent-concurrency-spec.md).
