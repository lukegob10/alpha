// OpenAI Codex, Copyright 2025 OpenAI. Apache-2.0; see ../NOTICE and ../LICENSE.
// Verbatim codex-rs/prompts/templates/compact/prompt.md, including its final LF:
// https://github.com/openai/codex/blob/2889d8e1bf564af2ed3a72dc929b583551561363/codex-rs/prompts/templates/compact/prompt.md
// Retrieved 2026-11-06. Keep request-layer additions out of this prompt.
export const DEFAULT_CONDENSING_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`
