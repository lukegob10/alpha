# Claude frontier setup

Verified against Anthropic's primary documentation on 2026-09-04 UTC.

The native Anthropic setup includes `claude-fable-5-1` and exposes Low, Medium, High, XHigh, and Max effort for Fable 5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8, and Opus 4.7. High is the documented API default. Sonnet 5 is the default for new configurations; existing explicit model selections remain intact.

- [Effort and model-specific level support](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Thinking configuration and display defaults](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Fable 5.1 specifications and pricing](https://platform.claude.com/docs/en/models/fable-5-1/overview)
- [Retired model IDs](https://platform.claude.com/docs/en/about-claude/model-deprecations)

The provider sends `output_config.effort` and `thinking: { type: "adaptive", display: "summarized" }`. Unsupported saved effort values fall back to High, and obsolete enable/disable flags cannot suppress an explicit selection. Legacy models retain their token-budget controls. Retired entries remain in the catalog for saved configuration compatibility but are hidden from new model selections through the existing `deprecated` handling.

Fable 5.1 binds thinking blocks to their preceding system prompt, tools, and conversation. Alpha can change those inputs during mode changes, edits, and compaction. Its requests therefore include `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` and the `thinking-binding-controls-2026-08-01` beta header. Anthropic can discard only invalidated thinking without rejecting the request. This can require the model to reason again after a history change. Normal task requests use automatic tool choice, which Fable 5.1 supports; forcing a tool with `any` or `tool` is not supported by that model.

See the [Fable 5.1 migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide) for these compatibility requirements.

The installed Anthropic SDK 0.37 serializes these current API fields but predates their TypeScript declarations. The native adapter keeps the adaptive shape typed locally and narrows it only at the SDK boundary. `anthropic-wire.spec.ts` exercises the actual SDK with an intercepted HTTP request to verify the serialized body and beta header. Provider tests cover each effort and saved-setting fallback; webview tests exercise every selector option against the local settings edit buffer. These tests do not require a live Anthropic account.
