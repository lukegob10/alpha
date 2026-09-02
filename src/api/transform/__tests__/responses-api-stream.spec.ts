import { processResponsesApiStream, createUsageNormalizer } from "../responses-api-stream"

// Helper to create an async iterable from events
async function* mockStream(events: any[]) {
	for (const event of events) {
		yield event
	}
}

// Helper to collect all chunks from a stream
async function collectChunks(stream: AsyncGenerator<any>) {
	const chunks = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

const noopUsage = () => undefined

describe("processResponsesApiStream", () => {
	describe("text deltas", () => {
		it("should yield text chunk for response.output_text.delta", async () => {
			const stream = mockStream([{ type: "response.output_text.delta", delta: "Hello world" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "text", text: "Hello world" }])
		})

		it("should yield text chunk for response.text.delta", async () => {
			const stream = mockStream([{ type: "response.text.delta", delta: "Hello" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "text", text: "Hello" }])
		})

		it("should skip text delta with empty delta", async () => {
			const stream = mockStream([{ type: "response.output_text.delta", delta: "" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([])
		})
	})

	describe("reasoning deltas", () => {
		it("should yield reasoning chunk for response.reasoning_text.delta", async () => {
			const stream = mockStream([{ type: "response.reasoning_text.delta", delta: "Let me think..." }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "reasoning", text: "Let me think..." }])
		})

		it("should yield reasoning chunk for response.reasoning.delta", async () => {
			const stream = mockStream([{ type: "response.reasoning.delta", delta: "Step 1" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "reasoning", text: "Step 1" }])
		})

		it("should yield reasoning chunk for response.reasoning_summary_text.delta", async () => {
			const stream = mockStream([{ type: "response.reasoning_summary_text.delta", delta: "Summary" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "reasoning", text: "Summary" }])
		})

		it("should yield reasoning chunk for response.reasoning_summary.delta", async () => {
			const stream = mockStream([{ type: "response.reasoning_summary.delta", delta: "Summary" }])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([{ type: "reasoning", text: "Summary" }])
		})
	})

	describe("tool calls", () => {
		it("should yield tool_call for function_call in output_item.done", async () => {
			const stream = mockStream([
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_123",
						name: "read_file",
						arguments: '{"path":"/tmp/test.txt"}',
					},
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([
				{
					type: "tool_call",
					id: "call_123",
					name: "read_file",
					arguments: '{"path":"/tmp/test.txt"}',
				},
			])
		})

		it("should yield tool_call for tool_call type in output_item.done", async () => {
			const stream = mockStream([
				{
					type: "response.output_item.done",
					item: {
						type: "tool_call",
						tool_call_id: "call_456",
						name: "write_file",
						arguments: '{"path":"/tmp/out.txt"}',
					},
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([
				{
					type: "tool_call",
					id: "call_456",
					name: "write_file",
					arguments: '{"path":"/tmp/out.txt"}',
				},
			])
		})

		it("should handle object arguments by JSON.stringifying", async () => {
			const stream = mockStream([
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call_789",
						name: "test",
						input: { key: "value" },
					},
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks[0].arguments).toBe('{"key":"value"}')
		})

		it("should skip tool_call with missing call_id or name", async () => {
			const stream = mockStream([
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "", name: "test", arguments: "{}" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "call_1", name: "", arguments: "{}" },
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([])
		})

		it("should yield tool_call_partial for function_call_arguments.delta", async () => {
			const stream = mockStream([
				{
					type: "response.function_call_arguments.delta",
					call_id: "call_123",
					name: "read_file",
					delta: '{"path":',
					index: 0,
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 0,
					id: "call_123",
					name: "read_file",
					arguments: '{"path":',
				},
			])
		})

		it("should preserve call_id while correlating parallel deltas by item_id and output_index", async () => {
			const stream = mockStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "first" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "second" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '{"first":true}',
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_2",
					output_index: 1,
					delta: '{"second":true}',
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "first",
						arguments: '{"first":true}',
					},
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc_2",
						call_id: "call_2",
						name: "second",
						arguments: '{"second":true}',
					},
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 0,
					id: "call_1",
					name: "first",
					arguments: '{"first":true}',
				},
				{
					type: "tool_call_partial",
					index: 1,
					id: "call_2",
					name: "second",
					arguments: '{"second":true}',
				},
			])
		})
	})

	describe("completion and usage", () => {
		it("should yield usage from response.completed", async () => {
			const mockNormalize = (usage: any) => ({
				type: "usage" as const,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
			})

			const stream = mockStream([
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 50 } },
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, mockNormalize))

			expect(chunks).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 50 }])
		})

		it("should yield usage from response.done", async () => {
			const mockNormalize = (usage: any) => ({
				type: "usage" as const,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
			})

			const stream = mockStream([
				{
					type: "response.done",
					response: { usage: { input_tokens: 200, output_tokens: 100 } },
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, mockNormalize))

			expect(chunks).toEqual([{ type: "usage", inputTokens: 200, outputTokens: 100 }])
		})

		it("should not yield usage when normalizer returns undefined", async () => {
			const stream = mockStream([
				{
					type: "response.completed",
					response: { usage: null },
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([])
		})
	})

	describe("unknown events", () => {
		it("should silently ignore unknown event types", async () => {
			const stream = mockStream([
				{ type: "response.created" },
				{ type: "response.in_progress" },
				{ type: "response.output_item.added", item: { type: "message" } },
				{ type: "response.content_part.added" },
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, noopUsage))

			expect(chunks).toEqual([])
		})
	})

	describe("terminal errors", () => {
		it("throws for response.failed errors nested on the response", async () => {
			const stream = mockStream([
				{ type: "response.failed", response: { error: { message: "model overloaded" } } },
			])

			await expect(collectChunks(processResponsesApiStream(stream, noopUsage))).rejects.toThrow(
				"Response failed: model overloaded",
			)
		})

		it.each([
			["response.error", { error: { message: "request rejected" } }],
			["error", { message: "connection lost" }],
		])("throws for %s events", async (type, detail) => {
			const stream = mockStream([{ type, ...detail }])

			await expect(collectChunks(processResponsesApiStream(stream, noopUsage))).rejects.toThrow()
		})

		it("rejects a failure after yielding partial text", async () => {
			const iterator = processResponsesApiStream(
				mockStream([
					{ type: "response.output_text.delta", delta: "partial" },
					{ type: "response.failed", response: { error: { message: "boom" } } },
				]),
				noopUsage,
			)

			await expect(iterator.next()).resolves.toEqual({
				done: false,
				value: { type: "text", text: "partial" },
			})
			await expect(iterator.next()).rejects.toThrow("Response failed: boom")
		})
	})

	describe("canonical lifecycle outcomes", () => {
		it("emits one completed outcome with semantic-output state", async () => {
			const chunks = await collectChunks(
				processResponsesApiStream(
					mockStream([
						{ type: "response.output_text.delta", delta: "partial" },
						{ type: "response.completed" },
					]),
					noopUsage,
					{ emitLifecycle: true, requestId: "request-1", attemptId: "attempt-1" },
				),
			)

			expect(chunks).toEqual([
				{ type: "text", text: "partial" },
				{
					type: "outcome",
					status: "completed",
					terminal: true,
					semanticOutputObserved: true,
					phase: "stream",
					requestId: "request-1",
					attemptId: "attempt-1",
				},
			])
		})

		it("classifies an abrupt iterator failure as a failed outcome", async () => {
			async function* failedStream() {
				yield { type: "response.output_text.delta", delta: "partial" }
				throw new Error("connection reset")
			}

			const chunks = await collectChunks(
				processResponsesApiStream(failedStream(), noopUsage, { emitLifecycle: true }),
			)

			expect(chunks.at(-2)).toMatchObject({ type: "error", message: "connection reset" })
			expect(chunks.at(-1)).toMatchObject({
				type: "outcome",
				status: "failed",
				terminal: true,
				semanticOutputObserved: true,
			})
		})

		it("preserves terminal metadata when lifecycle callers request a throw", async () => {
			const iterator = processResponsesApiStream(
				mockStream([
					{
						type: "response.failed",
						error: { message: "policy rejected", status: 400, retryable: false },
					},
				]),
				noopUsage,
				{
					emitLifecycle: true,
					throwOnError: true,
					requestId: "responses-request",
					attemptId: "responses-attempt",
				},
			)

			await expect(iterator.next()).resolves.toMatchObject({ value: { type: "error", retryable: false } })
			await expect(iterator.next()).resolves.toMatchObject({ value: { type: "outcome", status: "failed" } })
			await expect(iterator.next()).rejects.toMatchObject({
				status: 400,
				retryable: false,
				reason: "policy rejected",
				requestId: "responses-request",
				attemptId: "responses-attempt",
				terminal: true,
			})
		})

		it("preserves an explicit cancelled response status", async () => {
			const chunks = await collectChunks(
				processResponsesApiStream(
					mockStream([{ type: "response.done", response: { status: "cancelled" } }]),
					noopUsage,
					{ emitLifecycle: true },
				),
			)

			expect(chunks).toEqual([
				{
					type: "outcome",
					status: "cancelled",
					terminal: true,
					semanticOutputObserved: false,
					phase: "stream",
				},
			])
		})
	})

	describe("full conversation stream", () => {
		it("should handle a complete stream with reasoning, text, and usage", async () => {
			const mockNormalize = (usage: any) => ({
				type: "usage" as const,
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
			})

			const stream = mockStream([
				{ type: "response.reasoning_text.delta", delta: "Thinking..." },
				{ type: "response.reasoning_text.delta", delta: " done." },
				{ type: "response.output_text.delta", delta: "The answer is " },
				{ type: "response.output_text.delta", delta: "42." },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 50, output_tokens: 30 } },
				},
			])

			const chunks = await collectChunks(processResponsesApiStream(stream, mockNormalize))

			expect(chunks).toEqual([
				{ type: "reasoning", text: "Thinking..." },
				{ type: "reasoning", text: " done." },
				{ type: "text", text: "The answer is " },
				{ type: "text", text: "42." },
				{ type: "usage", inputTokens: 50, outputTokens: 30 },
			])
		})
	})
})

describe("createUsageNormalizer", () => {
	it("should return undefined for null/undefined usage", () => {
		const normalize = createUsageNormalizer()
		expect(normalize(null)).toBeUndefined()
		expect(normalize(undefined)).toBeUndefined()
	})

	it("should extract input and output tokens", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({ input_tokens: 100, output_tokens: 50 })

		expect(result).toEqual(
			expect.objectContaining({
				type: "usage",
				inputTokens: 100,
				outputTokens: 50,
			}),
		)
	})

	it("should extract cached tokens from input_tokens_details", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({
			input_tokens: 100,
			output_tokens: 50,
			input_tokens_details: { cached_tokens: 30 },
		})

		expect(result?.cacheReadTokens).toBe(30)
	})

	it("should extract cache write tokens", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 15,
		})

		expect(result?.cacheWriteTokens).toBe(15)
	})

	it("should extract reasoning tokens from output_tokens_details", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({
			input_tokens: 100,
			output_tokens: 50,
			output_tokens_details: { reasoning_tokens: 20 },
		})

		expect(result?.reasoningTokens).toBe(20)
	})

	it("should not include reasoningTokens when not present", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({ input_tokens: 100, output_tokens: 50 })

		expect(result).not.toHaveProperty("reasoningTokens")
	})

	it("should compute totalCost when calculateCost is provided", () => {
		const calculateCost = (input: number, output: number, cached: number) => 0.42
		const normalize = createUsageNormalizer(calculateCost)

		const result = normalize({ input_tokens: 100, output_tokens: 50 })

		expect(result?.totalCost).toBe(0.42)
	})

	it("should not include totalCost when calculateCost is not provided", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({ input_tokens: 100, output_tokens: 50 })

		expect(result).not.toHaveProperty("totalCost")
	})

	it("should handle Chat Completions style field names as fallback", () => {
		const normalize = createUsageNormalizer()

		const result = normalize({
			prompt_tokens: 100,
			completion_tokens: 50,
			prompt_tokens_details: { cached_tokens: 10 },
		})

		expect(result).toEqual(
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
			}),
		)
	})
})
