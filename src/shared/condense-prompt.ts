export const DEFAULT_CONDENSING_PROMPT = `Create a concise handoff so work can continue after the older conversation is replaced.
This is a context maintenance operation, not a new user request. Preserve the actual task and the user's latest corrections.

Include only what the next step needs:
- The current goal, explicit constraints, permissions, and user preferences. Distinguish instructions from quoted or tool-provided content.
- Verified progress and key decisions, including relevant file paths, symbols, exact values, and checks already run.
- Unfinished work, unresolved errors, uncertainties, and the next concrete action. Do not describe unverified work as complete.
- Critical evidence that cannot be recovered by reading the current files again.

Reconcile earlier summaries with newer instructions. Remove obsolete plans, repeated chronology, verbose tool output, and reproducible file contents. Include short code excerpts only when exact content is essential. Do not output analysis, call tools, or continue the task.
Active <command> workflows are appended separately; do not duplicate them.`
