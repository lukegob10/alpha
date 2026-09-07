import type OpenAI from "openai"

const BASE_DESCRIPTION = `Use this tool to deliver a final report of completed work or a blocked handoff. Report completion when the user's intended outcome has been handled end to end and any verification appropriate to the task has completed. Rely on the tool results returned by the harness; separate user confirmation of each intermediate tool is not required. If the latest tool result establishes the explicit requested outcome and no requested verification remains, call this tool next. Do not explore, configure, or improve adjacent state that the user did not request.

Before reporting completion, compare the result with the requested outcome and use verification proportionate to the task. Address any material defect or missing requested verification. Optional polish is not a completion blocker.`

const PRIMARY_DESCRIPTION = `${BASE_DESCRIPTION}

Parameters:
- result: (required) The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.
- outcome: Use blocked to hand off work when further progress or required validation is unavailable. Report what was done and the remaining constraint. This does not mark the task completed or satisfy outstanding verification.

If a specific answer from the user would unblock progress, use ask_followup_question with a focused question instead. Otherwise, report the blocked outcome once; do not repeat checks without new information or a concrete way to resolve the blocker.

Example: Completing after updating CSS
{ "result": "I've updated the CSS to use flexbox layout for better responsiveness" }`

const SUBAGENT_DESCRIPTION = `${BASE_DESCRIPTION}

Parameters:
- result: (required) A concise, self-contained report of the assigned objective and evidence.
- outcome: Use completed when the assigned objective was fulfilled, or blocked when authority, missing prerequisites, or another constraint prevented completion.`

const RESULT_PARAMETER_DESCRIPTION = `Final report of completed work or a blocked handoff, including any remaining constraint`

const primaryAttemptCompletion = {
	type: "function",
	function: {
		name: "attempt_completion",
		description: PRIMARY_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				result: {
					type: "string",
					description: RESULT_PARAMETER_DESCRIPTION,
				},
				outcome: {
					type: "string",
					enum: ["completed", "blocked"],
					description: "Use blocked for an incomplete or unverified handoff with the missing evidence.",
				},
			},
			required: ["result"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

const subagentAttemptCompletion = {
	type: "function",
	function: {
		name: "attempt_completion",
		description: SUBAGENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				result: {
					type: "string",
					description: RESULT_PARAMETER_DESCRIPTION,
				},
				outcome: {
					type: "string",
					enum: ["completed", "blocked"],
					description: "Report whether the assigned sub-agent objective was completed or blocked.",
				},
			},
			required: ["result"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export function createAttemptCompletionTool(taskKind: "subagent"): typeof subagentAttemptCompletion
export function createAttemptCompletionTool(taskKind?: "primary"): typeof primaryAttemptCompletion
export function createAttemptCompletionTool(
	taskKind: "primary" | "subagent",
): typeof primaryAttemptCompletion | typeof subagentAttemptCompletion
export function createAttemptCompletionTool(taskKind: "primary" | "subagent" = "primary") {
	return taskKind === "subagent" ? subagentAttemptCompletion : primaryAttemptCompletion
}

export default primaryAttemptCompletion
