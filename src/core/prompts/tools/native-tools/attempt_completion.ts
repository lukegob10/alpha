import type OpenAI from "openai"

const ATTEMPT_COMPLETION_DESCRIPTION = `Use this tool when the user's intended outcome has been handled end to end and any verification appropriate to the task has completed. Rely on the tool results returned by the harness; separate user confirmation of each intermediate tool is not required.

Near the end of implementation work, perform one bounded review of the stable result against the original request. Check applicable integration boundaries, meaningful failure or user-interface states, test substance, unintended changes, and generated artifacts. If that review finds a material defect, correct it and run only the verification needed for the correction; do not begin another open-ended review cycle. Optional polish is not a completion blocker.

Parameters:
- result: (required) The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.

Example: Completing after updating CSS
{ "result": "I've updated the CSS to use flexbox layout for better responsiveness" }`

const RESULT_PARAMETER_DESCRIPTION = `Final result message to deliver to the user once the task is complete`

export default {
	type: "function",
	function: {
		name: "attempt_completion",
		description: ATTEMPT_COMPLETION_DESCRIPTION,
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
