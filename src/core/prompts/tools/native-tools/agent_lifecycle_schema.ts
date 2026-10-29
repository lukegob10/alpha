import { AGENT_CANONICAL_PATH_PATTERN, AGENT_TARGET_REFERENCE_PATTERN } from "@alpha-code/types"

export const CANONICAL_AGENT_PATH_PATTERN = AGENT_CANONICAL_PATH_PATTERN

export const AGENT_TARGET_PATTERN = AGENT_TARGET_REFERENCE_PATTERN

export const canonicalAgentPathSchema = {
	type: "string",
	minLength: 5,
	pattern: CANONICAL_AGENT_PATH_PATTERN,
} as const

export const agentTargetSchema = {
	type: "string",
	minLength: 1,
	pattern: AGENT_TARGET_PATTERN,
	description:
		"A task ID, caller-relative agent path such as worker/code_review, or canonical path such as /root/code_review; the host checks recipient or control scope.",
} as const
