import type Anthropic from "@anthropic-ai/sdk"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { getToolFreeMetadata, summarizeConversation } from "../index"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { instance: { captureContextCondensed: vi.fn() } },
}))

function fixture(chunks: ApiStreamChunk[]) {
	const messages: ApiMessage[] = [
		{ role: "user", content: "Original task. ".repeat(200), ts: 1 },
		{ role: "assistant", content: "Previous work. ".repeat(200), ts: 2 },
		{ role: "user", content: "Continue the work. ".repeat(200), ts: 3 },
	]
	const next = vi.fn<() => Promise<IteratorResult<ApiStreamChunk>>>()
	for (const chunk of chunks) next.mockResolvedValueOnce({ done: false, value: chunk })
	next.mockResolvedValue({ done: true, value: undefined })
	const close = vi.fn(async () => ({ done: true as const, value: undefined }))
	const createMessage = vi.fn<ApiHandler["createMessage"]>().mockReturnValue({
		[Symbol.asyncIterator]: () => ({ next, return: close }),
	} as unknown as ReturnType<ApiHandler["createMessage"]>)
	const handler: ApiHandler = {
		streamCapabilities: { lifecycle: true, cancellation: true },
		createMessage,
		countTokens: vi.fn(async (content: Anthropic.Messages.ContentBlockParam[]) =>
			content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0),
		),
		getModel: () => ({ id: "summary-fixture", info: { contextWindow: 50_000, supportsPromptCache: false } }),
	}
	const options = {
		messages,
		apiHandler: handler,
		systemPrompt: "Live task instructions",
		taskId: "summary-task",
		maxContextTokens: 1_500,
		recentTailTokenBudget: 0,
	}
	return { messages, handler, next, close, options }
}

const completed: ApiStreamChunk = {
	type: "outcome",
	status: "completed",
	terminal: true,
	semanticOutputObserved: true,
}

describe("isolated summary requests", () => {
	it("replaces live instruction and continuation metadata while retaining caller controls", async () => {
		const { options, handler } = fixture([{ type: "text", text: "Complete summary." }, completed])
		const controller = new AbortController()
		const metadata = Object.freeze<ApiHandlerCreateMessageMetadata>({
			taskId: options.taskId,
			instructionFragments: [{ role: "developer", content: "Continue executing the live task." }],
			suppressPreviousResponseId: false,
			signal: controller.signal,
			deadline: Date.now() + 10_000,
			requestId: "summary-request",
			attemptId: "summary-attempt",
			store: false,
			tools: [],
			tool_choice: "required",
			parallelToolCalls: true,
		})

		const isolated = getToolFreeMetadata(metadata)
		expect(isolated).not.toHaveProperty("instructionFragments")
		expect(isolated).toMatchObject({
			taskId: options.taskId,
			suppressPreviousResponseId: true,
			signal: controller.signal,
			deadline: metadata.deadline,
			requestId: metadata.requestId,
			attemptId: metadata.attemptId,
			store: false,
			tools: [],
			tool_choice: "none",
			parallelToolCalls: false,
			allowedFunctionNames: [],
		})
		expect(metadata.instructionFragments?.[0].content).toBe("Continue executing the live task.")
		expect(metadata.suppressPreviousResponseId).toBe(false)

		await summarizeConversation({ ...options, metadata })
		expect(handler.createMessage).toHaveBeenCalledWith(
			expect.stringContaining("summarization-only request"),
			expect.any(Array),
			isolated,
		)
	})

	it("settles and closes at the terminal outcome without waiting for another stream read", async () => {
		const { options, next, close } = fixture([
			{ type: "text", text: "Complete summary." },
			completed,
			{ type: "text", text: "Late unrelated text must not enter the summary." },
		])
		const result = await summarizeConversation(options)
		expect(result.status).toBe("reduced")
		expect(result.summary).toBe("Complete summary.")
		expect(next).toHaveBeenCalledTimes(2)
		expect(close).toHaveBeenCalledOnce()
	})

	it("does not install a summary when cancellation arrives during terminal iterator cleanup", async () => {
		const { options, messages, next, close } = fixture([{ type: "text", text: "Complete summary." }, completed])
		const before = structuredClone(messages)
		const controller = new AbortController()
		const reason = new DOMException("Cancelled at the completed response boundary", "AbortError")
		close.mockImplementation(async () => {
			controller.abort(reason)
			return { done: true, value: undefined }
		})

		await expect(
			summarizeConversation({ ...options, metadata: { taskId: options.taskId, signal: controller.signal } }),
		).rejects.toBe(reason)
		expect(next).toHaveBeenCalledTimes(2)
		expect(close).toHaveBeenCalledOnce()
		expect(messages).toEqual(before)
	})

	it("does not install a completed summary when cancellation interrupts the final candidate token count", async () => {
		const { options, messages, handler, next, close } = fixture([
			{ type: "text", text: "Complete summary." },
			completed,
		])
		const before = structuredClone(messages)
		const controller = new AbortController()
		const reason = new DOMException("Cancelled while validating the candidate", "AbortError")
		let notifyCandidateCount!: () => void
		let releaseCandidateCount!: () => void
		const candidateCountEntered = new Promise<void>((resolve) => (notifyCandidateCount = resolve))
		const candidateCountReleased = new Promise<void>((resolve) => (releaseCandidateCount = resolve))
		vi.mocked(handler.countTokens).mockImplementation(async (content) => {
			if (
				content.some(
					(block) =>
						block.type === "text" && block.text.startsWith("## Conversation Summary\nComplete summary."),
				)
			) {
				notifyCandidateCount()
				await candidateCountReleased
			}
			return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0)
		})
		const pending = summarizeConversation({
			...options,
			metadata: { taskId: options.taskId, signal: controller.signal },
		})
		const rejected = expect(pending).rejects.toBe(reason)
		try {
			await candidateCountEntered
			controller.abort(reason)
			await rejected
		} finally {
			releaseCandidateCount()
		}

		expect(next).toHaveBeenCalledTimes(2)
		expect(close).toHaveBeenCalledOnce()
		expect(messages).toEqual(before)
	})

	it("does not await uncooperative cleanup after terminal completion", async () => {
		const { options, next, close } = fixture([{ type: "text", text: "Complete summary." }, completed])
		close.mockImplementation(() => new Promise(() => {}))
		const result = await summarizeConversation(options)
		expect(result.status).toBe("reduced")
		expect(next).toHaveBeenCalledTimes(2)
		expect(close).toHaveBeenCalledOnce()
	})

	it.each(["throw", "reject"])("keeps the accepted summary when iterator cleanup fails (%s)", async (failure) => {
		const { options, close } = fixture([{ type: "text", text: "Complete summary." }, completed])
		close.mockImplementation(() => {
			if (failure === "throw") throw new Error("Transport cleanup failed")
			return Promise.reject(new Error("Transport cleanup failed"))
		})
		const result = await summarizeConversation(options)
		expect(result.status).toBe("reduced")
		expect(result.summary).toBe("Complete summary.")
		expect(close).toHaveBeenCalledOnce()
	})

	it("uses only accounting delivered before the terminal response boundary", async () => {
		const { options, next } = fixture([
			{ type: "text", text: "Complete summary." },
			{ type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.02 },
			completed,
			{ type: "usage", inputTokens: 999, outputTokens: 999, totalCost: 9.99 },
		])
		const result = await summarizeConversation(options)
		expect(result.cost).toBe(0.02)
		expect(next).toHaveBeenCalledTimes(3)
	})

	it("rejects a nominal completion that still requires continuation", async () => {
		const { options, messages } = fixture([
			{ type: "text", text: "Partial summary." },
			{ ...completed, requiresContinuation: true },
		])
		const result = await summarizeConversation(options)
		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.diagnostic?.reason).toBe("incomplete_outcome")
	})

	it("does not repair an unsuccessful nonterminal outcome with a later terminal completion", async () => {
		const { options, messages, next, close } = fixture([
			{ type: "text", text: "Partial summary." },
			{
				type: "outcome",
				status: "incomplete",
				terminal: false,
				semanticOutputObserved: true,
				reason: "An incomplete summary must remain incomplete.",
			},
			completed,
			{ type: "text", text: "Late text." },
		])
		const before = structuredClone(messages)

		const result = await summarizeConversation(options)

		expect(result).toMatchObject({
			status: "no_progress",
			summary: "",
			errorDetails: "An incomplete summary must remain incomplete.",
			diagnostic: { reason: "incomplete_outcome", unsuccessfulOutcome: "incomplete" },
		})
		expect(result.messages).toBe(messages)
		expect(messages).toEqual(before)
		expect(next).toHaveBeenCalledTimes(3)
		expect(close).toHaveBeenCalledOnce()
	})

	it("keeps the first explicit provider failure and accounting when a later iterator read rejects", async () => {
		const { options, messages, next, close } = fixture([
			{ type: "text", text: "Partial summary." },
			{ type: "error", error: "FirstProviderFailure", message: "The first observed provider failure." },
			{ type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.02 },
		])
		const before = structuredClone(messages)
		next.mockRejectedValueOnce(new Error("A later transport error must not replace the provider failure."))

		const result = await summarizeConversation(options)

		expect(result).toMatchObject({
			status: "no_progress",
			summary: "",
			cost: 0.02,
			errorDetails: "The first observed provider failure.",
			diagnostic: { reason: "provider_error" },
		})
		expect(result.messages).toBe(messages)
		expect(messages).toEqual(before)
		expect(next).toHaveBeenCalledTimes(4)
		expect(close).toHaveBeenCalledOnce()
	})

	it.each<ApiStreamChunk>([
		{ type: "tool_call", id: "unexpected", name: "read_file", arguments: "{}" },
		{ type: "tool_call_start", id: "unexpected", name: "read_file" },
		{ type: "tool_call_delta", id: "unexpected", delta: "{}" },
		{ type: "tool_call_end", id: "unexpected" },
		{ type: "tool_call_partial", index: 0, id: "unexpected", name: "read_file", arguments: "{}" },
	])("rejects unexpected $type output without altering stored history", async (toolChunk) => {
		const { options, messages } = fixture([
			{ type: "text", text: "Text before unexpected tool intent." },
			toolChunk,
			completed,
		])
		const result = await summarizeConversation(options)
		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.summary).toBe("")
		expect(result.diagnostic).toMatchObject({ reason: "unexpected_tool_output", toolParts: 1 })
		expect(messages.every((message) => message.condenseParent === undefined)).toBe(true)
	})
})
