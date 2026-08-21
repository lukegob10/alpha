export const CANONICAL_AGENT_PATH_PATTERN = "^/root(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$"

export const AGENT_TARGET_PATTERN = "^(?:/root(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*|[A-Za-z0-9][A-Za-z0-9._:-]*)$"

export const canonicalAgentPathSchema = {
	type: "string",
	minLength: 5,
	pattern: CANONICAL_AGENT_PATH_PATTERN,
} as const

export const agentTargetSchema = {
	type: "string",
	minLength: 1,
	pattern: AGENT_TARGET_PATTERN,
	description: "A stable child task_name, task ID, or canonical agent path such as /root/review.",
} as const
