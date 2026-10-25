/** Shared by the renderer probe and a real-component regression so settings changes cannot silently stale the probe. */
export const renderedAgentSettingsControls = [
	["agents-concurrency", "input", "Maximum concurrent managed agents"],
	["agents-default-model", "input", "Default subagent model"],
	["agents-default-reasoning", "select", "Default subagent reasoning effort"],
	["agents-new-type-name", "input", "New agent type name"],
	["agents-new-type-description", "textarea", "New agent type description"],
] as const
