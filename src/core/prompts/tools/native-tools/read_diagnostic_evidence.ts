import type OpenAI from "openai"

const readDiagnosticEvidence: OpenAI.Chat.ChatCompletionFunctionTool = {
	type: "function",
	function: {
		name: "read_diagnostic_evidence",
		description:
			"Read bounded, redacted runtime evidence for the incident's source task. This tool accepts no paths or task IDs and never returns raw provider history or source file contents.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
	},
}

export default readDiagnosticEvidence
