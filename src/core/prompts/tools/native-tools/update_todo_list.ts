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
- For complex work, work_plan optionally preserves the objective, constraints, resource/evidence notes, and a few executable acceptance checks across compaction and reload. Null preserves the existing plan. Do not create a plan for a trivial edit.
- A declared check is satisfied only by an observed successful execute_command with the exact command and working directory. Include all relevant source, test, config, and dependency files in paths; use reusable=false for external/live state. Results are supplied automatically. Do not repeat a passing check without changed inputs or another concrete reason. Failed or stale declared checks prevent a completed outcome; use a blocked outcome when they cannot be resolved.
- Replace the plan only for an actual change of scope; never remove a failing check to manufacture completion. Notes should retain artifact/resource references, unresolved failures, and external operations requiring reconciliation, without secrets.

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
				work_plan: {
					type: ["object", "null"],
					properties: {
						objective: { type: "string", maxLength: 2000 },
						constraints: { type: "array", maxItems: 16, items: { type: "string", maxLength: 2000 } },
						notes: { type: "array", maxItems: 16, items: { type: "string", maxLength: 2000 } },
						checks: {
							type: "array",
							maxItems: 16,
							items: {
								type: "object",
								properties: {
									id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
									description: { type: "string", maxLength: 2000 },
									command: { type: "string", maxLength: 4096 },
									cwd: { type: ["string", "null"] },
									paths: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
									reusable: { type: "boolean" },
								},
								required: ["id", "description", "command", "cwd", "paths", "reusable"],
								additionalProperties: false,
							},
						},
					},
					required: ["objective", "constraints", "notes", "checks"],
					additionalProperties: false,
				},
			},
			required: ["todos", "work_plan"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
