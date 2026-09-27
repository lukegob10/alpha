import type { FollowUpData, RequestUserInputAnswerMap, RequestUserInputQuestion } from "@alpha-code/types"

import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface RequestUserInputParams {
	questions: RequestUserInputQuestion[]
}

function validateQuestions(questions: unknown): asserts questions is RequestUserInputQuestion[] {
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) {
		throw new Error("request_user_input requires one to three questions.")
	}

	const ids = new Set<string>()
	for (const [index, question] of questions.entries()) {
		if (!question || typeof question !== "object") {
			throw new Error(`request_user_input question ${index + 1} must be an object.`)
		}
		const record = question as Record<string, unknown>
		if (typeof record.id !== "string" || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(record.id) || ids.has(record.id)) {
			throw new Error(`request_user_input question ${index + 1} must have a unique snake_case id.`)
		}
		ids.add(record.id)
		if (typeof record.header !== "string" || record.header.trim().length === 0 || record.header.length > 12) {
			throw new Error(`request_user_input question ${record.id} must have a header of 12 or fewer characters.`)
		}
		if (typeof record.question !== "string" || record.question.trim().length === 0) {
			throw new Error(`request_user_input question ${record.id} must have a prompt.`)
		}
		if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 3) {
			throw new Error(`request_user_input question ${record.id} requires two or three options.`)
		}
		for (const option of record.options) {
			const optionRecord = option as Record<string, unknown> | undefined
			const label = optionRecord?.label
			const description = optionRecord?.description
			if (
				!option ||
				typeof option !== "object" ||
				typeof label !== "string" ||
				label.trim().length === 0 ||
				label.trim().split(/\s+/).length > 5 ||
				label.trim().toLowerCase() === "other" ||
				typeof description !== "string" ||
				description.trim().length === 0
			) {
				throw new Error(`request_user_input question ${record.id} options require a label and description.`)
			}
		}
	}
}

function formatRequestUserInput(questions: RequestUserInputQuestion[]): FollowUpData {
	const defaultAnswers: RequestUserInputAnswerMap = {}
	for (const question of questions) {
		defaultAnswers[question.id] = { answers: [question.options[0]!.label] }
	}

	return {
		requestUserInput: { questions },
		// The existing follow-up auto-approval path consumes one suggested string. Make that
		// suggestion a complete response so approval resolves the grouped request atomically.
		suggest: [{ answer: JSON.stringify({ answers: defaultAnswers }) }],
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseAnswersResponse(
	text: string | undefined,
	questions: RequestUserInputQuestion[],
): RequestUserInputAnswerMap {
	if (!text?.trim()) {
		throw new Error("request_user_input requires an answer for every question.")
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		// Preserve the existing free-form reply path when a request contains one question.
		if (questions.length === 1) return { [questions[0]!.id]: { answers: [text.trim()] } }
		throw new Error("request_user_input response must be a JSON answer map for every question.")
	}

	if (typeof parsed === "string" && questions.length === 1 && parsed.trim()) {
		return { [questions[0]!.id]: { answers: [parsed.trim()] } }
	}

	if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "answers")) {
		throw new Error("request_user_input response must contain one answers object keyed by question id.")
	}

	const rawAnswers = parsed.answers
	if (!isRecord(rawAnswers)) {
		throw new Error("request_user_input response answers must be an object keyed by question id.")
	}
	const questionIds = new Set(questions.map(({ id }) => id))
	const answerIds = Object.keys(rawAnswers)
	if (answerIds.length !== questions.length || answerIds.some((id) => !questionIds.has(id))) {
		throw new Error("request_user_input response must answer every question exactly once.")
	}

	const answers: RequestUserInputAnswerMap = {}
	for (const question of questions) {
		const answer = rawAnswers[question.id]
		if (
			!isRecord(answer) ||
			Object.keys(answer).length !== 1 ||
			!Array.isArray(answer.answers) ||
			answer.answers.length === 0 ||
			!answer.answers.every((value) => typeof value === "string" && value.trim().length > 0)
		) {
			throw new Error(
				`request_user_input response for ${question.id} must include at least one non-empty answer.`,
			)
		}
		answers[question.id] = { answers: answer.answers.map((value) => (value as string).trim()) }
	}

	return answers
}

function formatAnswerFeedback(questions: RequestUserInputQuestion[], answers: RequestUserInputAnswerMap): string {
	return questions.map((question) => `${question.header}: ${answers[question.id]!.answers.join(", ")}`).join("\n")
}

function isCancellation(task: Task, signal?: AbortSignal): boolean {
	return task.abort || signal?.aborted === true
}

async function askWithCancellation(
	task: Task,
	payload: string,
	signal?: AbortSignal,
): Promise<Awaited<ReturnType<Task["ask"]>> | undefined> {
	if (signal?.aborted) return undefined
	const askPromise = task.ask("followup", payload, false)
	if (!signal) return askPromise

	let onAbort: (() => void) | undefined
	const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
		onAbort = () => resolve({ kind: "cancelled" })
		signal.addEventListener("abort", onAbort, { once: true })
	})
	try {
		const result = await Promise.race([
			askPromise.then((value) => ({ kind: "response" as const, value })),
			cancelled,
		])
		if (result.kind === "response") return result.value

		// The scheduler signal can stop this call without aborting the whole Task.
		// Settle the existing Alpha ask so its polling promise and UI do not leak.
		if (!task.abort) task.handleWebviewAskResponse("noButtonClicked")
		await askPromise.catch(() => undefined)
		return undefined
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort)
	}
}

export class RequestUserInputTool extends BaseTool<"request_user_input"> {
	readonly name = "request_user_input" as const

	async execute(params: RequestUserInputParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, setResultMetadata, signal } = callbacks
		if (task.taskKind !== "primary") {
			setResultMetadata?.({ status: "denied" })
			pushToolResult(
				JSON.stringify({ status: "denied", message: "request_user_input is available to the root task only." }),
			)
			return
		}

		try {
			validateQuestions(params?.questions)
			if (isCancellation(task, signal)) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ answers: {} }))
				return
			}

			const request = formatRequestUserInput(params.questions)
			const answer = await askWithCancellation(task, JSON.stringify(request), signal)
			if (!answer || isCancellation(task, signal) || answer.response === "noButtonClicked") {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ answers: {} }))
				return
			}
			if (answer.response !== "messageResponse") {
				throw new Error("request_user_input did not receive a structured answer response.")
			}

			const answers = parseAnswersResponse(answer.text, params.questions)
			if (isCancellation(task, signal)) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ answers: {} }))
				return
			}

			const feedback =
				params.questions.length === 1
					? answers[params.questions[0]!.id]!.answers.join("\n")
					: formatAnswerFeedback(params.questions, answers)
			await task.say("user_feedback", feedback, answer.images)
			if (isCancellation(task, signal)) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ answers: {} }))
				return
			}
			pushToolResult(JSON.stringify({ answers }))
		} catch (error) {
			if (isCancellation(task, signal)) {
				setResultMetadata?.({ status: "cancelled" })
				pushToolResult(JSON.stringify({ answers: {} }))
				return
			}

			if (error instanceof Error) {
				await handleError("requesting user input", error)
				return
			}
			await handleError("requesting user input", new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"request_user_input">): Promise<void> {
		const questions = block.nativeArgs?.questions ?? []
		const preview = questions
			.map(({ header, question }) => (header || question ? `**${header ?? ""}**\n\n${question ?? ""}` : ""))
			.filter(Boolean)
			.join("\n\n")
		await task.ask("followup", preview, block.partial).catch(() => {})
	}
}

export const requestUserInputTool = new RequestUserInputTool()
