import type OpenAI from "openai"

const taskId = {
	type: "string",
	minLength: 1,
	maxLength: 64,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
}

export const create_task = {
	type: "function",
	function: {
		name: "create_task",
		description:
			"Launch a separate task (chat/thread) beside this conversation and return its stable task ID. The child uses this task's provider profile, mode, reasoning setting, tool policy, and delegation limits. Choose shared to use the same workspace, or worktree to start from the current Git HEAD in a dedicated worktree; worktree mode does not include uncommitted changes. Only a top-level task can create independent tasks. Wait with wait_task for its result and inspect with list_tasks.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				objective: { type: "string", minLength: 1, maxLength: 12000 },
				workspace_mode: { type: "string", enum: ["shared", "worktree"] },
			},
			required: ["objective", "workspace_mode"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const list_tasks = {
	type: "function",
	function: {
		name: "list_tasks",
		description:
			"List independent tasks directly created by this conversation, including their stable IDs, workspace choices, lifecycle states, and bounded latest result summaries. Managed agents are listed separately by list_agents.",
		strict: true,
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const wait_task = {
	type: "function",
	function: {
		name: "wait_task",
		description:
			"Wait for a direct child's terminal or input-waiting state, then return its current status and bounded final response. Returns early if this tool call is cancelled or the timeout expires. Wait on one task at a time; other model calls may continue only after this blocking tool returns.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: taskId,
				timeout_ms: {
					anyOf: [{ type: "integer", minimum: 1000, maximum: 300000 }, { type: "null" }],
				},
			},
			required: ["task_id", "timeout_ms"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const send_task_message = {
	type: "function",
	function: {
		name: "send_task_message",
		description:
			"Send guidance to one direct child task, or send progress from this child to its recorded parent using task_id 'parent'. A child's final result is reported automatically. The receiving task sees a user message with sender attribution; a completed recipient resumes. This tool does not interrupt an active response; use steer_task for that. Unrelated task IDs are rejected.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: taskId,
				message: { type: "string", minLength: 1, maxLength: 12000 },
			},
			required: ["task_id", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const steer_task = {
	type: "function",
	function: {
		name: "steer_task",
		description:
			"Interrupt the current model turn of one direct child task and durably deliver new guidance. Use send_task_message when the task should finish its current response first. Completed tasks cannot be steered; send a message to resume one.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: taskId,
				message: { type: "string", minLength: 1, maxLength: 12000 },
			},
			required: ["task_id", "message"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const stop_task = {
	type: "function",
	function: {
		name: "stop_task",
		description:
			"Stop one direct child task. Repeated calls are safe. This cannot stop the parent conversation or a managed agent; use cancel_agent for agents.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: taskId,
				reason: { anyOf: [{ type: "string", maxLength: 500 }, { type: "null" }] },
			},
			required: ["task_id", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool

export const crossTaskOrchestrationTools = [
	create_task,
	list_tasks,
	wait_task,
	send_task_message,
	steer_task,
	stop_task,
]
