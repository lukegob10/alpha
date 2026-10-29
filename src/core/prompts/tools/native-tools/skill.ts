import type OpenAI from "openai"

const SKILL_DESCRIPTION = `Load and execute a skill by name. Skills provide specialized instructions for common tasks like creating MCP servers or custom modes.

Use this tool when you need to follow specific procedures documented in a skill. The AVAILABLE SKILLS section is bounded. Use action "list" to discover further available skills, following next_cursor until the relevant skill is found. List responses contain at most 50 entries and 8000 UTF-8 bytes. Large instruction loads return contents, complete, and next_cursor; repeat action "load" with the same skill and args and that cursor until complete is true before acting on the skill. Source changes invalidate a cursor; restart without one. Loads support up to 524288 formatted characters and eight pending reads per task. An omitted action loads a skill for compatibility.`

const SKILL_PARAMETER_DESCRIPTION = `Name of the skill to load (e.g., create-mcp-server, create-mode), including a skill named by the user. Set null for action "list".`

const ARGS_PARAMETER_DESCRIPTION = `Optional context or arguments to pass to the skill`

export default {
	type: "function",
	function: {
		name: "skill",
		description: SKILL_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: ["string", "null"],
					enum: ["load", "list", null],
					description: 'Use "load" (or null) for instructions, or "list" for bounded metadata discovery.',
				},
				cursor: {
					type: ["string", "null"],
					description:
						"Opaque next_cursor from the same action, skill, and args, or null for the first page.",
				},
				skill: {
					type: ["string", "null"],
					description: SKILL_PARAMETER_DESCRIPTION,
				},
				args: {
					type: ["string", "null"],
					description: ARGS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["skill", "args", "action", "cursor"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
