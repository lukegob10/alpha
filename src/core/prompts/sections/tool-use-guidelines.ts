export function getToolUseGuidelinesSection(
	subagentRole?: "explore" | "review" | "worker",
	isPlanMode = false,
): string {
	const inspectionGuidance =
		"For investigations and reviews, batch independent inspections only when each resolves a concrete unanswered question in the requested scope. Use known file locations directly. For a known symbol without a known line, locate it with targeted search before reading a large file from its beginning; read the relevant section and its dependencies. Use semantic search when the implementation location is unknown. Reuse current evidence and passing checks; refresh affected evidence after changes or failures. Continue partial output only when the missing portion matters. For a command that already ran, inspect its retained output or status instead of rerunning it merely to obtain more output. Synthesize once the requested coverage is complete; an explicitly comprehensive task still requires its full coverage."
	if (subagentRole) {
		return `# Tool Use Guidelines

1. Work only on the assigned bounded objective.
2. Choose the narrowest available repository tool that supplies the required evidence or authorized change.
3. Group independent read-only operations; serialize dependent operations and worker mutations.
4. Treat returned results as the source of truth. Never assume success from missing or incomplete output.
5. If the objective cannot be completed with this child authority or available workspace evidence, report the constraint through attempt_completion instead of inventing information.`
	}

	if (isPlanMode) {
		return `# Tool Use Guidelines

1. Begin with the request and repository evidence already available.
2. Use the narrowest read-only repository tool that resolves the next material uncertainty. Prefer repository tools; use execute_command only for a host-approved inspection or verification that those tools cannot supply as well.
3. Group independent reads; serialize dependent investigation and agent coordination. ${inspectionGuidance}
4. Treat returned results as evidence of what ran; distinguish verified facts from assumptions. Missing or incomplete output does not establish success.`
	}

	return `# Tool Use Guidelines

1. Choose the most appropriate tool for the next unresolved need. Prefer purpose-built repository tools over shell substitutes when both provide the needed result.
2. Group independent, read-only calls when policy permits. Serialize dependent actions, workspace mutations, approvals, and control-flow operations; inspect results before the next dependent action. ${inspectionGuidance}
3. Treat returned tool results as evidence; no separate user confirmation is required. Never assume success. If output is missing or incomplete and the outcome matters, use a bounded follow-up check of the exit status, process state, or resulting artifact.
4. Supply required parameters only when the task, repository, or prior results provide a defensible value. Never invent a missing material value.`
}
