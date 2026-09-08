import type OpenAI from "openai"

const UPDATE_TODO_LIST_DESCRIPTION = `Optional tracking for work with independently verifiable stages; not a prerequisite for starting work or completing a task. Replace the entire TODO list with the current checklist. Always provide the full list; the system will overwrite the previous one.

Checklist Format:
- Use a single-level markdown checklist (no nesting or subtasks)
- List todos in the intended execution order
- Status options: [ ] (pending), [x] (completed), [-] (in progress)

Core Principles:
- You may update multiple statuses in a single update
- Add items only for requested coverage or a concrete dependency, contradiction, material risk, or user scope change
- Only mark a task as completed when evidence establishes it is fully accomplished
- Keep all unfinished tasks unless explicitly instructed to remove

Example:
{ "todos": "[x] Establish requested behavior\\n[-] Implement the change\\n[ ] Run required checks" }`

const TODOS_PARAMETER_DESCRIPTION = `Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress`

export default {
	type: "function",
	function: {
		name: "update_todo_list",
		description: UPDATE_TODO_LIST_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				todos: {
					type: "string",
					description: TODOS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["todos"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
