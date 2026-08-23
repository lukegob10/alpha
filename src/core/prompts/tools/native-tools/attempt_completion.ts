import type OpenAI from "openai"

const BASE_DESCRIPTION = `Use this tool when the user's intended outcome has been handled end to end and any verification appropriate to the task has completed. Rely on the tool results returned by the harness; separate user confirmation of each intermediate tool is not required. If the latest tool result establishes the explicit requested outcome and no requested verification remains, call this tool next. Do not explore, configure, or improve adjacent state that the user did not request.

Near the end of implementation work, perform one bounded review of the stable result against the original request. Check applicable integration boundaries, meaningful failure or user-interface states, test substance, unintended changes, and generated artifacts. If that review finds a material defect, correct it and run only the verification needed for the correction; do not begin another open-ended review cycle. Optional polish is not a completion blocker.`

const PRIMARY_DESCRIPTION = `${BASE_DESCRIPTION}

Parameters:
- result: (required) The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.

Example: Completing after updating CSS
{ "result": "I've updated the CSS to use flexbox layout for better responsiveness" }`

const SUBAGENT_DESCRIPTION = `${BASE_DESCRIPTION}

Parameters:
- result: (required) A concise, self-contained report of the assigned objective and evidence.
- outcome: Use completed when the assigned objective was fulfilled, or blocked when authority, missing prerequisites, or another constraint prevented completion.`

const RESULT_PARAMETER_DESCRIPTION = `Final result message to deliver to the user once the task is complete`

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
