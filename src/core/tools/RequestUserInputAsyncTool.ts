import type { AsyncUserInputData, AsyncUserInputQuestion } from "@alpha-code/types"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"

interface RequestUserInputAsyncParams {
	questions: AsyncUserInputQuestion[]
}

function validateQuestions(questions: unknown): asserts questions is AsyncUserInputQuestion[] {
	if (!Array.isArray(questions) || questions.length < 1) {
		throw new Error("request_user_input_async requires at least one question.")
	}

	for (const [index, question] of questions.entries()) {
		if (!question || typeof question !== "object" || Array.isArray(question)) {
			throw new Error(`request_user_input_async question ${index + 1} must be an object.`)
		}
		const record = question as Record<string, unknown>
		if (typeof record.title !== "string" || record.title.trim().length === 0) {
			throw new Error(`request_user_input_async question ${index + 1} must have a title.`)
		}
		if (
			record.options !== undefined &&
			(!Array.isArray(record.options) ||
				record.options.length < 1 ||
				!record.options.every((option) => typeof option === "string" && option.trim().length > 0))
		) {
			throw new Error(`request_user_input_async question ${index + 1} options must be non-empty strings.`)
		}
	}
}

function createQuestionData(questions: AsyncUserInputQuestion[]): AsyncUserInputData {
	return {
		questions: questions.map(({ title, options }) => ({
			title: title.trim(),
			...(options === undefined ? {} : { options: options.map((option) => option.trim()) }),
		})),
	}
}

export class RequestUserInputAsyncTool extends BaseTool<"request_user_input_async"> {
	readonly name = "request_user_input_async" as const

	async execute(params: RequestUserInputAsyncParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, setResultMetadata, signal } = callbacks
		if (task.taskKind !== "primary") {
			setResultMetadata?.({ status: "denied" })
			pushToolResult(
				JSON.stringify({
					status: "denied",
					message: "request_user_input_async is available to the root task only.",
				}),
			)
			return
		}

		try {
			validateQuestions(params?.questions)
			if (task.abort || signal?.aborted) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ status: "cancelled" }))
				return
			}

			const request = createQuestionData(params.questions)
			await task.say("async_user_input", undefined, undefined, undefined, undefined, undefined, {
				isNonInteractive: true,
				asyncUserInput: request,
			})
			pushToolResult(JSON.stringify({ accepted: true }))
		} catch (error) {
			if (task.abort || signal?.aborted) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ status: "cancelled" }))
				return
			}
			await handleError("requesting user input", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const requestUserInputAsyncTool = new RequestUserInputAsyncTool()
