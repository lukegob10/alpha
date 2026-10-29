import type Anthropic from "@anthropic-ai/sdk"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { invalidPersistedApiMessages } from "../../task-persistence/validatePersistedApiMessages"
import { invalidateOpaqueProviderStateReplay } from "../../task-persistence/providerStateScope"
import { getEffectiveApiHistory, getToolFreeMetadata, summarizeConversation } from "../index"

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
	it("retries an oversized summary with fewer complete steps before falling back", async () => {
		const { options, handler } = fixture([])
		const createMessage = vi.mocked(handler.createMessage)
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "Discarded partial summary." }
			throw new Error("maximum context length exceeded")
		})
		createMessage.mockImplementationOnce(async function* () {
			yield { type: "text", text: "Recovered summary." }
			yield completed
		})
		const before = structuredClone(options.messages)
		const result = await summarizeConversation(options)
		expect(result.status).toBe("reduced")
		expect(result.summary).not.toContain("Discarded partial summary")
		expect(createMessage).toHaveBeenCalledTimes(2)
		const retryInput = JSON.stringify(createMessage.mock.calls[1][1])
		expect(retryInput).not.toContain("Original task.")
		expect(retryInput).not.toContain("Previous work.")
		expect(retryInput).toContain("Continue the work.")
		expect(options.messages).toEqual(before)
	})

	it("bounds overflow recovery to three attempts and accounts for discarded requests", async () => {
		const { options, handler } = fixture([])
		const observeCost = vi.fn()
		const messages: ApiMessage[] = Array.from({ length: 8 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `Step ${index}. `.repeat(200),
			ts: index + 1,
		}))
		vi.mocked(handler.createMessage).mockImplementation(async function* () {
			yield { type: "usage", inputTokens: 1, outputTokens: 0, totalCost: 0.25 }
			yield { type: "error", error: "context_length_exceeded", message: "maximum context length exceeded" }
		})
		const result = await summarizeConversation({ ...options, messages, observeCost })
		expect(result.status).toBe("no_progress")
		expect(handler.createMessage).toHaveBeenCalledTimes(3)
		expect(result.cost).toBe(0.75)
		expect(observeCost.mock.calls.map(([cost]) => cost)).toEqual([0.25, 0.5, 0.75])
	})

	it("removes whole tool transactions from retry input without changing the exact recent tail", async () => {
		const { options, handler } = fixture([])
		const tail: ApiMessage[] = [
			{ role: "user", content: "Recent instruction", ts: 5 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "recent", signature: "tail-signature" },
					{ type: "text", text: "Recent response" },
				],
				ts: 6,
			},
		]
		const messages: ApiMessage[] = [
			options.messages[0],
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "old-call", name: "read_file", input: { path: "old.ts" } }],
				ts: 2,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "old-call", content: "Old tool evidence" }],
				ts: 3,
			},
			{ role: "assistant", content: "Older completed response. ".repeat(200), ts: 4 },
			{ role: "user", content: "Intermediate instruction. ".repeat(200), ts: 4.5 },
			{ role: "assistant", content: "Intermediate response.", ts: 4.6 },
			...tail,
		]
		vi.mocked(handler.createMessage)
			.mockImplementationOnce(async function* () {
				yield { type: "text", text: "Discarded partial summary." }
				throw new Error("maximum context length exceeded")
			})
			.mockImplementationOnce(async function* () {
				yield { type: "text", text: "Recovered summary." }
				yield completed
			})
		const result = await summarizeConversation({ ...options, messages, recentTailTokenBudget: 500 })
		expect(result.status).toBe("reduced")
		expect(handler.createMessage).toHaveBeenCalledTimes(2)
		const retryInput = JSON.stringify(vi.mocked(handler.createMessage).mock.calls[1][1])
		expect(retryInput).not.toContain("old-call")
		expect(retryInput).not.toContain("Old tool evidence")
		expect(getEffectiveApiHistory(result.messages).slice(-2)).toEqual(tail)
		expect(JSON.stringify(result.messages)).toContain("omitted from summary input")
	})

	it.each([{ isAutomaticTrigger: false }, { isAutomaticTrigger: true }, { forceCompaction: true }])(
		"preserves durable route replay revocation through compaction (%j)",
		async (trigger) => {
			const { options, messages, handler } = fixture([{ type: "text", text: "Complete summary." }, completed])
			const tail: ApiMessage[] = [
				{ role: "user", content: "Continue from the result.", ts: 4 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Private reasoning", signature: "prior-account-signature" },
						{ type: "tool_use", id: "retained-call", name: "read_file", input: { path: "recent.ts" } },
					],
					ts: 5,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "retained-call", content: "Recent evidence." }],
					ts: 6,
				},
			]
			const invalidated = invalidateOpaqueProviderStateReplay([
				messages[0],
				{
					...messages[1],
					reasoning_details: [{ type: "reasoning.encrypted", data: "prior-account-prefix" }],
				},
				...tail,
			])
			const before = structuredClone(invalidated)
			const result = await summarizeConversation({
				...options,
				...trigger,
				messages: invalidated,
				recentTailTokenBudget: 500,
			})
			expect(result.status).toBe("reduced")
			const request = vi.mocked(handler.createMessage).mock.calls[0][1]
			expect(JSON.stringify(request)).not.toContain("prior-account")
			expect(JSON.stringify(request)).not.toContain("provider_state_replay_disabled")
			const reloaded = JSON.parse(JSON.stringify(result.messages)) as ApiMessage[]
			const active = getEffectiveApiHistory(reloaded)
			expect(active.slice(1)).toEqual(invalidated.slice(2))
			expect(active.at(-2)).toHaveProperty("provider_state_replay_disabled", true)
			expect(reloaded[1]).toHaveProperty("provider_state_replay_disabled", true)
			expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()
			expect(invalidated).toEqual(before)
		},
	)

	it("summarizes accepted standalone reasoning history without exposing opaque prefix or tail state", async () => {
		const { options, messages, handler } = fixture([{ type: "text", text: "Complete summary." }, completed])
		const standaloneReasoning = {
			type: "reasoning",
			encrypted_content: "opaque-legacy-reasoning",
			id: "legacy-reasoning",
			summary: [],
		}
		const tail: ApiMessage[] = [
			{ role: "user", content: "Continue using the recent result.", ts: 4 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Read the file.", signature: "opaque-tail-signature" },
					{ type: "tool_use", id: "recent-read", name: "read_file", input: { path: "recent.ts" } },
				],
				ts: 5,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "recent-read", content: "Recent evidence." }],
				ts: 6,
			},
		]
		const reloaded: ApiMessage[] = JSON.parse(
			JSON.stringify([
				messages[0],
				standaloneReasoning,
				messages[1],
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Earlier reasoning.", signature: "opaque-prefix-signature" },
					],
					ts: 3,
				},
				...tail,
			]),
		)
		const before = structuredClone(reloaded)
		expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()

		const result = await summarizeConversation({ ...options, messages: reloaded, recentTailTokenBudget: 500 })

		expect(result.status).toBe("reduced")
		expect(handler.createMessage).toHaveBeenCalledOnce()
		const request = vi.mocked(handler.createMessage).mock.calls[0][1]
		expect(request.slice(0, -1)).toEqual(messages.slice(0, 2).map(({ role, content }) => ({ role, content })))
		expect(JSON.stringify(request)).not.toContain(standaloneReasoning.encrypted_content)
		expect(JSON.stringify(request)).not.toContain("opaque-prefix-signature")
		expect(JSON.stringify(request)).not.toContain("opaque-tail-signature")
		const active = getEffectiveApiHistory(result.messages)
		expect(active.slice(1)).toEqual(tail)
		active.slice(1).forEach((message, index) => expect(message).toBe(reloaded[index + 4]))
		expect(result.messages[1]).toEqual({ ...standaloneReasoning, condenseParent: result.condenseId })
		expect(invalidPersistedApiMessages(result.messages)).toBeUndefined()
		expect(reloaded).toEqual(before)
	})

	it("summarizes an oversized old window with the previous model and validates the selected model's budget", async () => {
		const { options, handler: previous } = fixture([{ type: "text", text: "Complete summary." }, completed])
		const { handler: selected } = fixture([])
		selected.getModel = () => ({
			id: "smaller-model",
			info: { contextWindow: 2_000, supportsPromptCache: false },
		})
		vi.mocked(selected.createMessage).mockImplementation((_system, messages) => {
			if (JSON.stringify(messages).length > 2_000) throw new Error("context window exceeded")
			throw new Error("Unexpected selected-model summary request")
		})

		const failed = await summarizeConversation({ ...options, apiHandler: selected })
		expect(failed.status).toBe("no_progress")
		expect(failed.messages).toBe(options.messages)
		vi.mocked(selected.createMessage).mockClear()

		const result = await summarizeConversation({
			...options,
			apiHandler: selected,
			compactionApiHandler: previous,
		})
		expect(result.status).toBe("reduced")
		expect(result.newContextTokens).toBeLessThanOrEqual(options.maxContextTokens)
		expect(previous.createMessage).toHaveBeenCalledOnce()
		expect(JSON.stringify(vi.mocked(previous.createMessage).mock.calls[0][1]).length).toBeGreaterThan(2_000)
		expect(selected.createMessage).not.toHaveBeenCalled()
		expect(previous.countTokens).not.toHaveBeenCalled()
		expect(selected.countTokens).toHaveBeenCalled()
	})

	it("uses the compactor's lifecycle contract even when the selected handler accepts text at EOF", async () => {
		const { options, messages, handler: previous } = fixture([{ type: "text", text: "Partial handoff." }])
		const { handler: selected } = fixture([])
		const result = await summarizeConversation({
			...options,
			apiHandler: { ...selected, streamCapabilities: undefined },
			compactionApiHandler: previous,
		})
		expect(result.status).toBe("no_progress")
		expect(result.diagnostic?.reason).toBe("incomplete_outcome")
		expect(result.messages).toBe(messages)
		expect(selected.createMessage).not.toHaveBeenCalled()
	})

	it("does not adopt a previous-model summary that exceeds the selected replacement budget", async () => {
		const {
			options,
			messages,
			handler: previous,
		} = fixture([{ type: "text", text: "Summary. ".repeat(400) }, completed])
		const { handler: selected } = fixture([])
		const result = await summarizeConversation({
			...options,
			apiHandler: selected,
			compactionApiHandler: previous,
		})
		expect(result.status).toBe("no_progress")
		expect(result.diagnostic?.reason).toBe("candidate_over_budget")
		expect(result.messages).toBe(messages)
	})

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
