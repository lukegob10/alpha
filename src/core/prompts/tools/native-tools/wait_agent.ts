import type OpenAI from "openai"

export const wait_agent = {
	type: "function",
	function: {
		name: "wait_agent",
		description:
			"Wait once for a bounded period for a managed-agent update visible to this task. Set until_terminal true to ignore progress/control traffic and wait for a terminal result from any immediate child, or set target to an immediate-child task ID/canonical path to await that child specifically. Target requires until_terminal true. Terminal results return with durable event IDs, sender task/path provenance, and terminal status; their mailbox claim is consumed exactly once only after this tool result is persisted. With until_terminal false, the legacy behavior returns the next mailbox update and a managed child may block for immediate-parent control. A primary/root task with no matching active children or unconsumed updates returns immediately. This blocking tool must be called alone, never alongside another tool in the same response. Use it after continuing useful local work; do not call it repeatedly as a polling loop. Use null for optional defaults.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				timeout_ms: {
					anyOf: [{ type: "integer", minimum: 10_000, maximum: 300_000 }, { type: "null" }],
					description: "Bounded wait in milliseconds. Use null for 30000.",
				},
				target: {
					anyOf: [
						{
							type: "string",
							pattern: "^(?:/root(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*|[A-Za-z0-9][A-Za-z0-9._:-]*)$",
						},
						{ type: "null" },
					],
					description:
						"Optional immediate-child task ID or canonical path. Use null for any immediate child. Requires until_terminal true.",
				},
				until_terminal: {
					anyOf: [{ type: "boolean" }, { type: "null" }],
					description:
						"When true, ignore non-terminal mailbox traffic and await a terminal child result. Use null or false for legacy next-update behavior.",
				},
			},
			required: ["timeout_ms", "target", "until_terminal"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
