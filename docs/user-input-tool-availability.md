# User input tools in primary tasks

The primary Code and Plan tool catalogs expose `request_user_input`. It pauses the task for a structured answer and
returns that answer on the original tool call. The Code catalog still applies disabled-tool settings, task policy, and
lookup narrowing. Managed children cannot ask the user directly. Models explicitly marked for
`request_user_input_async` also receive the nonblocking question tool.

This closes a Code-mode gap: for a lookup request on a model without async question support, Alpha previously advertised
only `exec_command`. A user asking the agent to pose a question could therefore receive a false impression that questions
were impossible. The Code prompt now directs the model to ask a focused question when an undiscoverable answer materially
changes the task, while continuing independent work where possible.

Upstream Codex source checked on 2026-09-28: [tool availability](https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_config.rs),
[question schema](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/request_user_input_spec.rs),
and [Default mode guidance](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/default.md).
Codex supports Default-mode questions behind a feature gate. Alpha intentionally exposes the existing blocking question
tool in primary Code tasks regardless of model, so providers without async support can ask too. Alpha retains its existing
model-gated async path; [OpenAI's async tool guide](https://developers.openai.com/api/docs/guides/async-tool-calling)
documents the different continuation contract for async calls.

Catalog cost checked on 2026-09-28 with `getNativeTools()` and UTF-8 JSON serialization: the Code `exec_command` schema
is 1,450 bytes and the added `request_user_input` schema is 2,191 bytes. A command-and-question lookup therefore carries
3,641 raw schema bytes before provider serialization or caching. This is a payload measurement, not a token or latency
claim; the frozen lookup fixtures still verify the narrowed catalog shape.
