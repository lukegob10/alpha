import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiHandlerOptions } from "../../../shared/api"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"
import { AgentResponseAccumulator } from "../../../core/agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../../../core/task-persistence/canonicalAssistantHistory"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../../shared/cost"
import { buildBedrockHandler } from "../bedrock"

const mocks = vi.hoisted(() => ({ token: vi.fn(), tokenProvider: vi.fn(), fromIni: vi.fn(), defaultChain: vi.fn() }))
vi.mock("@aws/bedrock-token-generator", () => ({ getTokenProvider: mocks.tokenProvider }))
vi.mock("@aws-sdk/credential-providers", () => ({
	fromIni: mocks.fromIni,
	fromNodeProviderChain: mocks.defaultChain,
}))

const claude = "global.anthropic.claude-opus-5-5"
const gpt = "global.openai.gpt-6.1-sol"
const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Find the cause." }]
const tools: ApiHandlerCreateMessageMetadata["tools"] = [
	{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
]
const completeClaudeEvents = [
	{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Done" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
	{ type: "message_stop" },
]

function responseMessage(text = "Done") {
	return {
		type: "message",
		id: "msg_bedrock",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	}
}

function responsesResult(output: unknown[] = [responseMessage()]) {
	return {
		id: "resp_bedrock",
		status: "completed",
		output,
		usage: { input_tokens: 15, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } },
	}
}

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	})
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { promise, resolve }
}

async function collect(stream: ApiStream): Promise<ApiStreamChunk[]> {
	const chunks: ApiStreamChunk[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

type RequestRecord = { url: string; body: Record<string, unknown>; headers: Headers; signal?: AbortSignal | null }
let requests: RequestRecord[]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(() => {
	vi.clearAllMocks()
	requests = []
	mocks.token.mockResolvedValue("generated-bedrock-token")
	mocks.tokenProvider.mockReturnValue(mocks.token)
	mocks.fromIni.mockReturnValue(vi.fn())
	mocks.defaultChain.mockReturnValue(vi.fn())
	fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
		const url = String(input)
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>
		requests.push({ url, body, headers: new Headers(init?.headers), signal: init?.signal })
		if (url.endsWith("/responses")) {
			return body.stream
				? sse([{ type: "response.completed", response: responsesResult() }])
				: json(responsesResult())
		}
		return body.stream
			? sse(completeClaudeEvents)
			: json({ stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] })
	})
	vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.useRealTimers()
})

describe("curated Amazon Bedrock adapter", () => {
	it.each(["global.openai.gpt-5.6-sol", "global.openai.gpt-5.6-terra", "global.openai.gpt-5.6-luna"])(
		"sends %s's default, reasoning efforts, and explicit Off through the Responses route",
		async (apiModelId) => {
			for (const [settings, effort] of [
				[{}, "medium"],
				...(["none", "low", "medium", "high", "xhigh", "max"] as const).map(
					(reasoningEffort) => [{ reasoningEffort, enableReasoningEffort: true }, reasoningEffort] as const,
				),
				[{ enableReasoningEffort: false, reasoningEffort: "disable" }, "none"],
			] as const) {
				const handler = buildBedrockHandler({
					apiModelId,
					awsUseApiKey: true,
					awsApiKey: "bedrock-key",
					...settings,
				})
				await collect(handler.createMessage("", messages))
				expect(requests.at(-1)).toMatchObject({
					url: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
					body: { model: apiModelId, reasoning: { effort } },
				})
				await expect(handler.completePrompt("Enhance")).resolves.toBe("Done")
				expect(requests.at(-1)?.body).toMatchObject({ model: apiModelId, reasoning: { effort } })
			}
		},
	)

	it.each([
		{ apiModelId: claude, prices: [4, 20, 5, 0.2], expected: 0.0196 },
		{ apiModelId: "global.anthropic.claude-sonnet-5-5", prices: [2, 10, 2.5, 0.1], expected: 0.0098 },
		{ apiModelId: "global.anthropic.claude-fable-5-1", prices: [10, 50, 12.5, 0.25], expected: 0.04825 },
		{ apiModelId: gpt, prices: [2, 10, 2.5, 0.1], expected: 0.0098 },
		{ apiModelId: "global.openai.gpt-6-astra", prices: [10, 50, 12.5, 1], expected: 0.0505 },
	])("estimates nonzero Global Standard cost for $apiModelId", ({ apiModelId, prices, expected }) => {
		const { info } = buildBedrockHandler({ apiModelId }).getModel()
		expect(info).toMatchObject({
			inputPrice: prices[0],
			outputPrice: prices[1],
			cacheWritesPrice: prices[2],
			cacheReadsPrice: prices[3],
		})
		const cost = apiModelId.includes("anthropic.")
			? calculateApiCostAnthropic(info, 1_000, 250, 2_000, 3_000)
			: calculateApiCostOpenAI(info, 6_000, 250, 2_000, 3_000)
		expect(cost.totalCost).toBeGreaterThan(0)
		expect(cost.totalCost).toBeCloseTo(expected, 12)
		expect(cost.totalInputTokens).toBe(6_000)
		expect(cost.totalOutputTokens).toBe(250)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each(["us", "eu", "au", "jp"].flatMap((prefix) => [false, true].map((arn) => ({ prefix, arn }))))(
		"applies the geographic premium to all token categories ($prefix, ARN=$arn)",
		({ prefix, arn }) => {
			const profileId = `${prefix}.anthropic.claude-opus-5-5`
			const awsCustomArn = arn
				? `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${profileId}`
				: profileId
			const base = buildBedrockHandler({}).getModel()
			const handler = buildBedrockHandler({ awsCustomArn })
			const priced = handler.getModel()
			expect(priced.info.inputPrice).toBeCloseTo(4.4, 12)
			expect(priced.info.outputPrice).toBeCloseTo(22, 12)
			expect(priced.info.cacheWritesPrice).toBeCloseTo(5.5, 12)
			expect(priced.info.cacheReadsPrice).toBeCloseTo(0.22, 12)
			expect(calculateApiCostAnthropic(priced.info, 1_000, 250, 2_000, 3_000).totalCost).toBeCloseTo(0.02156, 12)
			const { inputPrice, outputPrice, cacheWritesPrice, cacheReadsPrice, ...capabilities } = priced.info
			expect(base.info).toMatchObject(capabilities)
			expect(priced.id).toBe(base.id)
			expect(priced.toolIdentity).toEqual(base.toolIdentity)
			expect(handler.getModel().info).toEqual(priced.info)
			expect(buildBedrockHandler({}).getModel().info).toEqual(base.info)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ awsRegion: "us-east-1" },
		{ awsRegion: "eu-west-2" },
		{ awsRegion: "ap-northeast-1" },
		{ awsCustomArn: "global.anthropic.claude-opus-5-5" },
		{ awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5" },
		{ awsCustomArn: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/us.application" },
	])("keeps Global Standard estimates for global/opaque targets (%j)", (options) => {
		expect(buildBedrockHandler(options).getModel().info).toEqual(buildBedrockHandler({}).getModel().info)
	})

	it.each(
		[
			{ apiModelId: gpt, inputTokens: 272_000, expected: 0.16933 },
			{ apiModelId: gpt, inputTokens: 272_001, expected: 0.338499 },
			{ apiModelId: "global.openai.gpt-6-astra", inputTokens: 272_000, expected: 0.94665 },
			{ apiModelId: "global.openai.gpt-6-astra", inputTokens: 272_001, expected: 1.892495 },
		].flatMap((example) => ["global", "geo", "geo-arn"].map((profile) => ({ ...example, profile }))),
	)(
		"prices cached GPT input and fractional output at the threshold ($apiModelId, $inputTokens, $profile)",
		({ apiModelId, inputTokens, expected, profile }) => {
			const geoId = apiModelId.replace(/^global\./, "us.")
			const awsCustomArn =
				profile === "geo-arn"
					? `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${geoId}`
					: profile === "geo"
						? geoId
						: undefined
			const { info } = buildBedrockHandler({ apiModelId, awsCustomArn }).getModel()
			const cost = calculateApiCostOpenAI(info, inputTokens, 33, 10_000, 200_000)
			expect(cost.totalInputTokens).toBe(inputTokens)
			expect(cost.totalOutputTokens).toBe(33)
			expect(cost.totalCost).toBeCloseTo(expected * (profile === "global" ? 1 : 1.1), 12)
			expect(info.longContextPricing).toEqual({
				thresholdTokens: 272_000,
				inputPriceMultiplier: 2,
				outputPriceMultiplier: 1.5,
				cacheWritesPriceMultiplier: 2,
				cacheReadsPriceMultiplier: 2,
			})
		},
	)

	it.each([claude, gpt])("keeps %s capabilities synchronous without credentials or discovery", (apiModelId) => {
		const handler = buildBedrockHandler({ apiModelId })
		expect(handler.getModel()).toMatchObject({
			id: apiModelId,
			info: { requiredReasoningEffort: true, reasoningEffort: "medium" },
		})
		expect(handler.streamCapabilities).toEqual({ lifecycle: true, cancellation: true })
		expect(mocks.tokenProvider).not.toHaveBeenCalled()
		expect(mocks.defaultChain).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([claude, gpt])("uses only the AWS route and fresh token for %s", async (apiModelId) => {
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-organization")
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-project")
		const options: ApiHandlerOptions = {
			apiModelId,
			awsRegion: "us-west-2",
			awsAccessKey: "access",
			awsSecretKey: "secret",
			awsSessionToken: "session",
			openAiBaseUrl: "https://unrelated.example.test/v1",
			openAiApiKey: "other-key",
			openAiUseAzure: true,
			openAiHeaders: { Authorization: "other-auth" },
			apiKey: "other-anthropic-key",
			reasoningEffort: "max",
			modelTemperature: 0.4,
			verbosity: "high",
		}
		const before = structuredClone(options)
		const handler = buildBedrockHandler(options)
		await collect(handler.createMessage("system", messages, { taskId: "task", tools, tool_choice: "auto" }))
		await collect(handler.createMessage("system", messages))
		expect(options).toEqual(before)
		expect(mocks.tokenProvider).toHaveBeenCalledOnce()
		expect(mocks.tokenProvider).toHaveBeenCalledWith({
			region: "us-west-2",
			credentials: { accessKeyId: "access", secretAccessKey: "secret", sessionToken: "session" },
		})
		expect(mocks.token).toHaveBeenCalledTimes(2)
		expect(requests[0].url).toBe(
			`https://bedrock-runtime.us-west-2.amazonaws.com/${apiModelId === claude ? "anthropic/v1/messages" : "openai/v1/responses"}`,
		)
		expect(requests[0].headers.get("authorization")).toBe("Bearer generated-bedrock-token")
		expect(requests[0].headers.has("x-api-key")).toBe(false)
		expect(requests[0].headers.has("openai-organization")).toBe(false)
		expect(requests[0].headers.has("openai-project")).toBe(false)
		expect(requests[0].body).toMatchObject(
			apiModelId === claude
				? {
						model: claude,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						output_config: { effort: "max" },
						tools: [{ name: "read_file" }],
					}
				: {
						model: gpt,
						reasoning: { effort: "max", summary: "auto" },
						store: false,
						tools: [{ name: "read_file" }],
					},
		)
		expect(requests[0].body).not.toHaveProperty("temperature")
		expect(requests[0].body).not.toHaveProperty("text")
	})

	it("resolves profile/default credential providers lazily with bounded network attempts", async () => {
		const profile = buildBedrockHandler({ awsUseProfile: true, awsProfile: "work", awsAccessKey: "inactive" })
		await profile.completePrompt("prompt")
		expect(mocks.fromIni).toHaveBeenCalledWith({
			profile: "work",
			clientConfig: expect.objectContaining({ region: "us-east-1", maxAttempts: 1 }),
		})
		expect(mocks.defaultChain).not.toHaveBeenCalled()
		await buildBedrockHandler({}).completePrompt("prompt")
		expect(mocks.defaultChain).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1_000, maxRetries: 0 }))
	})

	it("supports an explicit Bedrock API key without credential discovery or token generation", async () => {
		await buildBedrockHandler({
			awsUseApiKey: true,
			awsApiKey: " bedrock-key ",
			awsAccessKey: "inactive",
		}).completePrompt("prompt")
		expect(requests[0].headers.get("authorization")).toBe("Bearer bedrock-key")
		expect(mocks.tokenProvider).not.toHaveBeenCalled()
		expect(mocks.fromIni).not.toHaveBeenCalled()
		expect(mocks.defaultChain).not.toHaveBeenCalled()
	})

	it.each([
		{ awsUseApiKey: true },
		{ awsUseProfile: true },
		{ awsUseApiKey: true, awsApiKey: "key", awsUseProfile: true, awsProfile: "work" },
		{ awsAccessKey: "access" },
		{ awsSecretKey: "secret" },
		{ awsSessionToken: "session" },
		{ awsRegion: "" },
		{ awsRegion: "us-east-1.example.test" },
		{ apiModelId: "unsupported-model" },
		{ apiModelId: "toString" },
		{ apiModelId: "" },
	])("rejects an invalid local configuration before authentication (%j)", (options) => {
		expect(() => buildBedrockHandler(options)).toThrow()
		expect(mocks.tokenProvider).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([claude, gpt])(
		"uses a matching inference profile while retaining static %s capabilities",
		async (apiModelId) => {
			const awsCustomArn = apiModelId.replace(/^global\./, "us.")
			const handler = buildBedrockHandler({ apiModelId, awsCustomArn })
			await handler.completePrompt("prompt")
			expect(requests[0].body.model).toBe(awsCustomArn)
			expect(handler.getModel().id).toBe(apiModelId)
		},
	)

	it("accepts a declared Claude application profile and rejects incompatible profile routing", async () => {
		const applicationArn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/application"
		await buildBedrockHandler({ awsCustomArn: applicationArn }).completePrompt("prompt")
		expect(requests[0].body.model).toBe(applicationArn)
		for (const options of [
			{ apiModelId: gpt, awsCustomArn: applicationArn },
			{ awsCustomArn: gpt },
			{
				awsCustomArn:
					"arn:aws:bedrock:eu-west-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
			},
			{ awsCustomArn: "https://other.example.test/model" },
		]) {
			expect(() => buildBedrockHandler(options)).toThrow(/profile/i)
		}
	})

	it("preserves signed Claude history and ordered tool/usage/lifecycle events", async () => {
		fetchMock.mockResolvedValueOnce(
			sse([
				{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "Summary", signature: "" },
				},
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: "call", name: "read_file", input: {} },
				},
				{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
				{ type: "content_block_stop", index: 1 },
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
				{ type: "message_stop" },
			]),
		)
		const handler = buildBedrockHandler({})
		const chunks = await collect(handler.createMessage("system", messages, { taskId: "task", tools }))
		expect(chunks.map((chunk) => chunk.type)).toEqual([
			"usage",
			"reasoning",
			"thinking_complete",
			"tool_call_partial",
			"tool_call_partial",
			"tool_call_end",
			"usage",
			"outcome",
		])
		expect(chunks[2]).toMatchObject({ type: "thinking_complete", signature: "signed", outputIndex: 0 })
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "completed" })
		if (!("getThoughtSignature" in handler)) throw new Error("Expected Messages transport")
		expect(handler.getThoughtSignature()).toBe("signed")
		const history: Anthropic.Messages.MessageParam[] = [
			...messages,
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Summary", signature: "signed" },
					{ type: "redacted_thinking", data: "opaque" },
					{ type: "tool_use", id: "call", name: "read_file", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "file" }] },
		]
		await collect(handler.createMessage("system", history))
		expect((requests[0].body.messages as Anthropic.Messages.MessageParam[])[1]).toEqual(history[1])
	})

	it("retains ordered encrypted Responses reasoning and tool transactions", async () => {
		const reasoning = {
			type: "reasoning",
			id: "rs_bedrock",
			encrypted_content: "opaque",
			summary: [{ type: "summary_text", text: "Summary" }],
		}
		const call = {
			type: "function_call",
			id: "fc_bedrock",
			call_id: "call",
			name: "read_file",
			arguments: "{}",
			status: "completed",
		}
		fetchMock.mockResolvedValueOnce(
			sse([{ type: "response.completed", response: responsesResult([reasoning, call]) }]),
		)
		const handler = buildBedrockHandler({ apiModelId: gpt })
		const chunks = await collect(handler.createMessage("system", messages, { taskId: "task", tools }))
		expect(chunks.filter((chunk) => chunk.type === "reasoning" || chunk.type === "tool_call")).toEqual([
			{ type: "reasoning", text: "Summary", outputIndex: 0 },
			{
				type: "reasoning",
				text: "",
				encryptedContent: "opaque",
				id: "rs_bedrock",
				summary: reasoning.summary,
				outputIndex: 0,
			},
			expect.objectContaining({ type: "tool_call", id: "call", name: "read_file", arguments: "{}" }),
		])
		expect(chunks).toContainEqual(
			expect.objectContaining({ type: "usage", inputTokens: 15, outputTokens: 9, reasoningTokens: 4 }),
		)
		expect(chunks.at(-1)).toMatchObject({ type: "outcome", status: "completed" })
		if (!("getReasoningItems" in handler)) throw new Error("Expected Responses transport")
		expect(handler.getReasoningItems()).toEqual([
			{ id: "rs_bedrock", encrypted_content: "opaque", summary: reasoning.summary },
		])
	})

	it("replays persisted Responses item IDs and opaque bytes at their original tool boundaries", async () => {
		const before = { type: "reasoning", id: "rs_before", encrypted_content: "before+/=\r\n", summary: [] }
		const after = { type: "reasoning", id: "rs_after", encrypted_content: "after+/=\n", summary: [] }
		const call = {
			type: "function_call",
			id: "fc_bedrock",
			call_id: "call",
			name: "read_file",
			arguments: '{"path":"a.ts"}',
			status: "completed",
		}
		fetchMock.mockResolvedValueOnce(
			sse([{ type: "response.completed", response: responsesResult([before, call, after, responseMessage()]) }]),
		)
		const original = buildBedrockHandler({ apiModelId: gpt })
		const accumulator = new AgentResponseAccumulator()
		for await (const chunk of original.createMessage("", messages, { taskId: "task", tools })) {
			await accumulator.add(chunk)
		}
		const response = await accumulator.finish()
		if (!("getResponseId" in original)) throw new Error("Expected Responses transport")
		expect(original.getResponseId()).toBe("resp_bedrock")
		const history: Anthropic.Messages.MessageParam[] = [
			...messages,
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "File contents" }] },
		]
		const reloaded: Anthropic.Messages.MessageParam[] = JSON.parse(JSON.stringify(history))
		await collect(buildBedrockHandler({ apiModelId: gpt }).createMessage("", reloaded))
		expect((requests[0].body.input as unknown[]).slice(1)).toEqual([
			before,
			{ type: "function_call", call_id: "call", name: "read_file", arguments: call.arguments },
			after,
			{
				type: "message",
				role: "assistant",
				id: "msg_bedrock",
				content: [{ type: "output_text", text: "Done", annotations: [] }],
			},
			{ type: "function_call_output", call_id: "call", output: "File contents" },
		])
		expect(requests[0].body.store).toBe(false)
		expect(requests[0].body).not.toHaveProperty("previous_response_id")
	})

	it.each([claude, gpt])(
		"does not disable required reasoning and supports completePrompt for %s",
		async (apiModelId) => {
			const handler = buildBedrockHandler({
				apiModelId,
				enableReasoningEffort: false,
				reasoningEffort: "disable",
			})
			await expect(handler.completePrompt("prompt")).resolves.toBe("Done")
			expect(requests[0].body).toMatchObject(
				apiModelId === claude ? { output_config: { effort: "medium" } } : { reasoning: { effort: "medium" } },
			)
			handler.setReasoningOptions({ enableReasoningEffort: true, reasoningEffort: "high" })
			await handler.completePrompt("prompt")
			expect(requests[1].body).toMatchObject(
				apiModelId === claude ? { output_config: { effort: "high" } } : { reasoning: { effort: "high" } },
			)
		},
	)

	it.each([claude, gpt])("aborts a stalled credential wait before HTTP dispatch for %s", async (apiModelId) => {
		const entered = deferred<void>()
		const pending = deferred<string>()
		mocks.token.mockImplementationOnce(() => {
			entered.resolve()
			return pending.promise
		})
		const controller = new AbortController()
		const operation = collect(
			buildBedrockHandler({ apiModelId }).createMessage("system", messages, {
				taskId: "task",
				signal: controller.signal,
			}),
		)
		await entered.promise
		const reason = new Error("cancel credentials")
		controller.abort(reason)
		await expect(operation).rejects.toBe(reason)
		expect(fetchMock).not.toHaveBeenCalled()
		pending.resolve("late-token")
	})

	it.each([claude, gpt])("aborts auxiliary credential waits and rejects late success for %s", async (apiModelId) => {
		const entered = deferred<void>()
		const pending = deferred<string>()
		mocks.token.mockImplementationOnce(() => {
			entered.resolve()
			return pending.promise
		})
		const controller = new AbortController()
		const operation = buildBedrockHandler({ apiModelId }).completePrompt("prompt", { signal: controller.signal })
		await entered.promise
		const reason = new Error("cancel completion credentials")
		controller.abort(reason)
		await expect(operation).rejects.toBe(reason)
		pending.resolve("late-token")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([claude, gpt])("cancels an active SSE response without reporting success for %s", async (apiModelId) => {
		const entered = deferred<AbortSignal>()
		fetchMock.mockImplementationOnce(async (_input, init) => {
			if (!init?.signal) throw new Error("Expected cancellable transport")
			const signal = init.signal
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					signal.addEventListener("abort", () => controller.error(signal.reason), { once: true })
					entered.resolve(signal)
				},
			})
			return new Response(body, { headers: { "content-type": "text/event-stream" } })
		})
		const controller = new AbortController()
		const operation = collect(
			buildBedrockHandler({ apiModelId }).createMessage("system", messages, {
				taskId: "task",
				signal: controller.signal,
			}),
		)
		const transportSignal = await entered.promise
		const reason = new Error("cancel stream")
		controller.abort(reason)
		await expect(operation).rejects.toBe(reason)
		expect(transportSignal.aborted).toBe(true)
	})

	it.each([claude, gpt])("does not accept SSE EOF as a completed %s response", async (apiModelId) => {
		fetchMock.mockResolvedValueOnce(
			apiModelId === claude
				? sse(completeClaudeEvents.slice(0, 3))
				: sse([{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" }]),
		)
		const chunks: ApiStreamChunk[] = []
		try {
			for await (const chunk of buildBedrockHandler({ apiModelId }).createMessage("", messages))
				chunks.push(chunk)
		} catch (error) {
			if (apiModelId === claude) throw error
			expect(error).toBeInstanceOf(Error)
		}
		expect(chunks.at(-1)).toMatchObject({
			type: "outcome",
			status: apiModelId === claude ? "incomplete" : "failed",
		})
		expect(chunks.some((chunk) => chunk.type === "outcome" && chunk.status === "completed")).toBe(false)
	})

	it.each([claude, gpt])(
		"propagates access errors and rejects incomplete auxiliary responses for %s",
		async (apiModelId) => {
			fetchMock.mockResolvedValueOnce(
				json({ error: { type: "access_denied_error", message: "Model access denied" } }, 403),
			)
			const handler = buildBedrockHandler({ apiModelId })
			await expect(handler.completePrompt("prompt")).rejects.toThrow(/403|denied/i)
			expect(fetchMock).toHaveBeenCalledOnce()
			fetchMock.mockResolvedValueOnce(
				json(
					apiModelId === claude
						? { stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }
						: {
								...responsesResult(),
								status: "incomplete",
								incomplete_details: { reason: "max_output_tokens" },
							},
				),
			)
			await expect(handler.completePrompt("prompt")).rejects.toThrow(/complete|incomplete/i)
		},
	)

	it("supports Claude auto/none and rejects forced tools before authentication", async () => {
		const handler = buildBedrockHandler({})
		await collect(handler.createMessage("system", messages, { taskId: "task", tools, tool_choice: "none" }))
		expect(requests[0].body.tool_choice).toEqual({ type: "none" })
		await expect(
			collect(handler.createMessage("system", messages, { taskId: "task", tools, tool_choice: "required" })),
		).rejects.toThrow("forced tool use")
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
