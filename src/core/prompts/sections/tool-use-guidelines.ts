export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool for the job. Prefer purpose-built repository tools over shell substitutes when both provide the needed result.
3. Group independent, read-only calls when doing so reduces latency without hiding dependencies. Run dependent or mutating actions in the order their evidence requires.
4. Treat returned tool results as the source of truth; no separate user confirmation is required. Never assume success. If output is missing or incomplete and the outcome matters, use a bounded follow-up check such as inspecting the exit status, process state, or resulting artifact.
5. Supply required parameters only when the task, repository, or prior results provide a defensible value. If a material required value is still missing after reasonable discovery, ask the user rather than inventing it.`
}
