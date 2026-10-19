import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

const { sendRequest, selectChatModels, cancellationSources } = vi.hoisted(() => ({
	sendRequest: vi.fn(),
	selectChatModels: vi.fn(),
	cancellationSources: [] as Array<{ token: { isCancellationRequested: boolean }; cancel: () => void }>,
}))

vi.mock("vscode", () => {
	class TextPart {
		constructor(public value: string) {}
	}
	class ThinkingPart {
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
	}
	class ToolPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class ResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}
	class DataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}
	}
	class CancellationTokenSource {
		token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
		constructor() {
			cancellationSources.push(this)
		}
		cancel() {
			this.token.isCancellationRequested = true
		}
		dispose() {}
	}
	return {
		version: "1.125.0",
		workspace: {
			onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
			getConfiguration: vi.fn(() => ({ get: () => 600 })),
		},
		lm: { selectChatModels, onDidChangeChatModels: vi.fn(() => ({ dispose() {} })) },
		LanguageModelTextPart: TextPart,
		LanguageModelThinkingPart: ThinkingPart,
		LanguageModelToolCallPart: ToolPart,
		LanguageModelToolResultPart: ResultPart,
		LanguageModelDataPart: DataPart,
		LanguageModelChatMessage: {
			User: (content: string | unknown[]) => ({
				role: "user",
				content: typeof content === "string" ? [new TextPart(content)] : content,
			}),
			Assistant: (content: string | unknown[]) => ({
				role: "assistant",
				content: typeof content === "string" ? [new TextPart(content)] : content,
			}),
		},
		CancellationTokenSource,
		CancellationError: class extends Error {},
	}
})

import * as vscode from "vscode"
import { VsCodeLmHandler } from "../vscode-lm"
import { collectAgentResponse, AgentTurnEngine } from "../../../core/agent/AgentTurnEngine"
import { resolveCodexModelPrompt } from "../../../core/prompts/codex-model-instructions"
import type { ApiStreamChunk } from "../../transform/stream"

const client = {
	id: "opaque-host-route",
	vendor: "copilot",
	family: "gpt-5.6-sol",
	version: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	maxInputTokens: 921_793,
	countTokens: vi.fn(),
	sendRequest,
}
const modelProvenance = { modelId: client.id, modelVendor: client.vendor, modelVersion: client.version }
const tools = [
	{
		type: "function" as const,
		function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
	},
]
const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Complete the requested work." }]
let handler: VsCodeLmHandler

function response(parts: unknown[]) {
	return {
		stream: (async function* () {
			yield* parts
		})(),
	}
}

async function observe(parts: unknown[]) {
	sendRequest.mockResolvedValueOnce(response(parts))
	const chunks: ApiStreamChunk[] = []
	const result = await collectAgentResponse(
		(async function* () {
			for await (const chunk of handler.createMessage("Instructions", messages, {
				taskId: "lm-contract",
				tools,
				requestId: "request-1",
				attemptId: "attempt-1",
			})) {
				chunks.push(chunk)
				yield chunk
			}
		})(),
	)
	return { result, chunks }
}

describe("VS Code LM canonical contracts", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		cancellationSources.length = 0
		selectChatModels.mockResolvedValue([client])
		handler = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: client.vendor, id: client.id } })
	})
	afterEach(() => {
		vi.mocked(vscode.lm.onDidChangeChatModels).mock.calls[0]?.[0]()
		handler.dispose()
	})

	it("preserves every host thinking part in order with text and tool calls", async () => {
		const firstThinking = {
			value: "Inspect the request",
			id: "segment-1",
			metadata: { signature: "sig-1" },
			modelId: "untrusted-response-route",
			modelVendor: "untrusted-response-vendor",
			modelVersion: "untrusted-response-version",
		}
		const arrayThinking = {
			value: ["Check", "the result"],
			id: "segment-2",
			metadata: { provider: { signature: "sig-2", flags: [true, null] } },
		}
		const signatureOnly = { value: [], id: "segment-2", metadata: { signature: "sig-3" } }
		const done = { value: "", id: "segment-2", metadata: { done: true } }
		const { chunks } = await observe([
			firstThinking,
			new vscode.LanguageModelTextPart("Reading the file."),
			new vscode.LanguageModelToolCallPart("read-1", "read_file", { path: "README.md" }),
			arrayThinking,
			signatureOnly,
			done,
			new vscode.LanguageModelTextPart("Complete."),
		])

		expect(chunks.filter((chunk) => chunk.type !== "usage")).toEqual([
			{
				type: "reasoning",
				text: "Inspect the request",
				vscodeLmThinking: { ...firstThinking, ...modelProvenance },
			},
			{ type: "text", text: "Reading the file." },
			{ type: "tool_call", id: "read-1", name: "read_file", arguments: '{"path":"README.md"}' },
			{ type: "tool_call_end", id: "read-1" },
			{
				type: "reasoning",
				text: "Check\nthe result",
				vscodeLmThinking: { ...arrayThinking, ...modelProvenance },
			},
			{ type: "reasoning", text: "", vscodeLmThinking: { ...signatureOnly, ...modelProvenance } },
			{ type: "reasoning", text: "", vscodeLmThinking: { ...done, ...modelProvenance } },
			{ type: "text", text: "Complete." },
		])
	})

	it("snapshots host thinking before the provider reuses its value or metadata objects", async () => {
		const part = {
			value: ["First"],
			id: "first-id",
			metadata: { provider: { signature: "first-signature", flags: [true] } },
		}
		sendRequest.mockResolvedValueOnce(response([part, part]))
		const stream = handler.createMessage("Instructions", messages)
		try {
			const first = await stream.next()
			part.value.push("Second")
			part.id = "second-id"
			part.metadata.provider.signature = "second-signature"
			part.metadata.provider.flags.push(false)
			const second = await stream.next()

			expect(first.value).toEqual({
				type: "reasoning",
				text: "First",
				vscodeLmThinking: {
					value: ["First"],
					id: "first-id",
					metadata: { provider: { signature: "first-signature", flags: [true] } },
					...modelProvenance,
				},
			})
			expect(second.value).toEqual({
				type: "reasoning",
				text: "First\nSecond",
				vscodeLmThinking: { ...part, ...modelProvenance },
			})
		} finally {
			await stream.return(undefined)
		}
	})

	it("replays matching and legacy thinking while excluding known model, vendor, and version mismatches", async () => {
		const marker = new TextEncoder().encode("continuation-marker")
		const matching = {
			type: "vscode_lm_thinking",
			value: ["Current", "model"],
			id: "matching-thinking",
			metadata: { signature: "matching-signature" },
			...modelProvenance,
		}
		const foreign = {
			type: "vscode_lm_thinking",
			value: "Another model's reasoning",
			id: "foreign-thinking",
			metadata: { signature: "foreign-signature" },
			modelId: "different-host-route",
		}
		const foreignVendor = {
			...matching,
			id: "foreign-vendor-thinking",
			metadata: { signature: "foreign-vendor-signature" },
			modelVendor: "different-provider",
		}
		const foreignVersion = {
			...matching,
			id: "foreign-version-thinking",
			metadata: { signature: "foreign-version-signature" },
			modelVersion: "different-provider-version",
		}
		const legacy = {
			type: "vscode_lm_thinking",
			value: "",
			id: "legacy-thinking",
			metadata: { signature: "legacy-signature" },
		}
		const history = [
			...messages,
			{
				role: "assistant",
				content: [
					matching,
					{ type: "text", text: "Reading the file." },
					foreign,
					foreignVendor,
					foreignVersion,
					{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "README.md" } },
					legacy,
				],
				vscodeLmStatefulMarker: Buffer.from(marker).toString("base64"),
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "read-1", content: "Read completed." }],
			},
		] as Anthropic.Messages.MessageParam[]
		const savedHistory = structuredClone(history)
		sendRequest.mockResolvedValueOnce(response([new vscode.LanguageModelTextPart("Complete.")]))

		await collectAgentResponse(handler.createMessage("Instructions", history, { taskId: "lm-contract", tools }))

		const projected = sendRequest.mock.calls[0]![0] as vscode.LanguageModelChatMessage[]
		const assistant = projected.find((message) => String(message.role) === "assistant")!
		expect(assistant.content).toEqual([
			expect.objectContaining({ value: matching.value, id: matching.id, metadata: matching.metadata }),
			expect.objectContaining({ value: "Reading the file." }),
			expect.objectContaining({ callId: "read-1", name: "read_file", input: { path: "README.md" } }),
			expect.objectContaining({ value: legacy.value, id: legacy.id, metadata: legacy.metadata }),
			expect.objectContaining({ mimeType: "stateful_marker", data: expect.any(Uint8Array) }),
		])
		expect(Array.from((assistant.content.at(-1) as vscode.LanguageModelDataPart).data)).toEqual(Array.from(marker))
		expect(assistant.content[0]).toBeInstanceOf(Reflect.get(vscode, "LanguageModelThinkingPart"))
		expect(assistant.content[3]).toBeInstanceOf(Reflect.get(vscode, "LanguageModelThinkingPart"))
		expect(assistant.content[0]).not.toHaveProperty("modelId")
		expect(assistant.content[0]).not.toHaveProperty("modelVendor")
		expect(assistant.content[0]).not.toHaveProperty("modelVersion")
		expect(JSON.stringify(projected)).not.toContain("foreign-thinking")
		expect(JSON.stringify(projected)).not.toContain("foreign-signature")
		expect(JSON.stringify(projected)).not.toContain("foreign-vendor-thinking")
		expect(JSON.stringify(projected)).not.toContain("foreign-vendor-signature")
		expect(JSON.stringify(projected)).not.toContain("foreign-version-thinking")
		expect(JSON.stringify(projected)).not.toContain("foreign-version-signature")
		expect(projected.at(-1)?.content).toContainEqual(expect.objectContaining({ callId: "read-1" }))
		expect(history).toEqual(savedHistory)
	})

	it.each(["circular", "bigint", "array", "primitive", "invalid-id"])(
		"keeps visible reasoning when %s thinking state cannot be persisted",
		async (variant) => {
			const circular: Record<string, unknown> = {}
			circular.self = circular
			const metadata =
				variant === "circular"
					? circular
					: variant === "bigint"
						? { signature: 1n }
						: variant === "array"
							? []
							: variant === "primitive"
								? "invalid metadata"
								: { signature: "valid" }
			const id = variant === "invalid-id" ? 123 : "segment"
			const { chunks } = await observe([
				{ value: ["Visible", "reasoning"], id, metadata },
				{ value: "", id, metadata },
				new vscode.LanguageModelTextPart("Complete."),
			])

			expect(chunks.filter((chunk) => chunk.type !== "usage")).toEqual([
				{ type: "reasoning", text: "Visible\nreasoning" },
				{ type: "text", text: "Complete." },
			])
		},
	)

	it("keeps metadata-only thinking separate from semantic output for empty-response recovery", async () => {
		const part = { value: "", id: "segment", metadata: { signature: "signature-only" } }
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield part
				throw new Error("Response contained no choices.")
			})(),
		})
		const stream = handler.createMessage("Instructions", messages)
		expect((await stream.next()).value).toEqual({
			type: "reasoning",
			text: "",
			vscodeLmThinking: { ...part, ...modelProvenance },
		})
		await expect(stream.next()).rejects.toMatchObject({
			retryCategory: "empty-response",
			retryable: true,
			semanticOutputObserved: false,
		})
	})

	it("retains terminal host usage when followed by metadata-only thinking", async () => {
		const { chunks } = await observe([
			new vscode.LanguageModelTextPart("Complete."),
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify({ prompt_tokens: 321, completion_tokens: 45 })),
				"usage",
			),
			{ value: "", id: "segment", metadata: { signature: "terminal-signature" } },
		])
		expect(chunks.at(-1)).toEqual({
			type: "usage",
			usageSource: "provider",
			inputTokens: 321,
			outputTokens: 45,
		})
	})

	it("isolates thinking and opaque state when a cancelled request is followed by a stalled successor", async () => {
		vi.useFakeTimers()
		const oldMarker = new TextEncoder().encode("cancelled-state")
		const newMarker = new TextEncoder().encode("successor-state")
		const oldThinking = { value: "Old reasoning", id: "old", metadata: { signature: "old-signature" } }
		const newThinking = { value: "", id: "new", metadata: { signature: "new-signature" } }
		const oldController = new AbortController()
		let releaseOldRead!: (value: IteratorResult<unknown>) => void
		const oldReadGate = new Promise<IteratorResult<unknown>>((resolve) => {
			releaseOldRead = resolve
		})
		let oldReadStarted!: () => void
		const oldReading = new Promise<void>((resolve) => {
			oldReadStarted = resolve
		})
		let newReadStarted!: () => void
		const newReading = new Promise<void>((resolve) => {
			newReadStarted = resolve
		})
		const oldParts = [oldThinking, new vscode.LanguageModelDataPart(oldMarker, "stateful_marker")]
		const oldIterator = {
			[Symbol.asyncIterator]() {
				return this
			},
			next() {
				if (oldParts.length > 0) return Promise.resolve({ done: false as const, value: oldParts.shift() })
				oldReadStarted()
				return oldReadGate
			},
			return: vi.fn(async () => ({ done: true as const, value: undefined })),
		}
		const newParts = [new vscode.LanguageModelDataPart(newMarker, "stateful_marker"), newThinking]
		const newIterator = {
			[Symbol.asyncIterator]() {
				return this
			},
			next() {
				if (newParts.length > 0) return Promise.resolve({ done: false as const, value: newParts.shift() })
				newReadStarted()
				return new Promise<IteratorResult<unknown>>(() => undefined)
			},
			return: vi.fn(async () => ({ done: true as const, value: undefined })),
		}
		sendRequest.mockResolvedValueOnce({ stream: oldIterator }).mockResolvedValueOnce({ stream: newIterator })
		try {
			const oldStream = handler.createMessage("Instructions", messages, {
				taskId: "cancelled-task",
				signal: oldController.signal,
			})
			expect((await oldStream.next()).value).toEqual({
				type: "reasoning",
				text: "Old reasoning",
				vscodeLmThinking: { ...oldThinking, ...modelProvenance },
			})
			const oldPending = oldStream.next().catch((error: unknown) => error)
			await oldReading
			oldController.abort()

			const successor = handler.createMessage("Instructions", messages, {
				taskId: "successor-task",
				deadline: Date.now() + 1_000,
			})
			expect((await successor.next()).value).toEqual({
				type: "reasoning",
				text: "",
				vscodeLmThinking: { ...newThinking, ...modelProvenance },
			})
			expect(await oldPending).toMatchObject({ message: expect.stringContaining("Request cancelled by user") })
			expect(cancellationSources[1]!.token.isCancellationRequested).toBe(false)
			expect(handler.getStatefulMarker()).toBeUndefined()
			releaseOldRead({ done: false, value: oldThinking })

			const stalledRead = successor.next()
			const rejected = expect(stalledRead).rejects.toMatchObject({
				name: "ApiStreamDeadlineError",
				phase: "response-stream",
			})
			await newReading
			await vi.advanceTimersByTimeAsync(1_000)
			await rejected
			expect(handler.getStatefulMarker()).toBe(Buffer.from(newMarker).toString("base64"))
			expect(oldIterator.return).toHaveBeenCalledOnce()
			expect(newIterator.return).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)

			const { chunks } = await observe([new vscode.LanguageModelTextPart("Recovered.")])
			expect(chunks.filter((chunk) => chunk.type !== "usage")).toEqual([{ type: "text", text: "Recovered." }])
			expect(handler.getStatefulMarker()).toBeUndefined()
		} finally {
			releaseOldRead({ done: true, value: undefined })
			vi.useRealTimers()
		}
	})

	it.each(["missing-id", "missing-name", "null-input", "array-input", "unserializable-input"])(
		"fails closed for recognized %s tool intent after visible text",
		async (variant) => {
			const circular: Record<string, unknown> = {}
			circular.self = circular
			const input =
				variant === "null-input"
					? null
					: variant === "array-input"
						? []
						: variant === "unserializable-input"
							? circular
							: { path: "README.md" }
			const { result, chunks } = await observe([
				new vscode.LanguageModelTextPart("Continuing the implementation."),
				new vscode.LanguageModelToolCallPart(
					variant === "missing-id" ? "" : "bad-call",
					variant === "missing-name" ? "" : "read_file",
					input as object,
				),
			])
			expect(result.text).toBe("Continuing the implementation.")
			expect(result.toolCalls).toEqual([])
			expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
			expect(chunks).toContainEqual(
				expect.objectContaining({
					type: "error",
					code: "InvalidToolCall",
					retryable: false,
					phase: "response-stream",
					requestId: "request-1",
					attemptId: "attempt-1",
					semanticOutputObserved: true,
				}),
			)
			const turn = await new AgentTurnEngine<string>({
				shouldAbort: () => false,
				runStep: async () => ({ response: result, nextInput: "complete" }),
			}).run("initial")
			expect(turn.status).toBe("failed")
		},
	)

	it.each(["before", "after"])(
		"retains an accepted call and its opaque marker %s invalid intent, without accepting later calls",
		async (position) => {
			const marker = new TextEncoder().encode("opaque-response-state")
			const markerPart = new vscode.LanguageModelDataPart(marker, "stateful_marker")
			const { result } = await observe([
				new vscode.LanguageModelTextPart("Reading the requested file."),
				new vscode.LanguageModelToolCallPart("accepted-call", "read_file", { path: "README.md" }),
				...(position === "before" ? [markerPart] : []),
				new vscode.LanguageModelToolCallPart("bad-call", "read_file", null as unknown as object),
				...(position === "after" ? [markerPart] : []),
				new vscode.LanguageModelToolCallPart("later-call", "read_file", { path: "SECRET.md" }),
				new vscode.LanguageModelTextPart("This cannot certify completion."),
			])
			expect(result.toolCalls).toEqual([
				{ type: "tool_call", id: "accepted-call", name: "read_file", arguments: { path: "README.md" } },
			])
			expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
			expect(result.text).toBe("Reading the requested file.")
			const persistedMarker = handler.getStatefulMarker()
			expect(persistedMarker).toBe(Buffer.from(marker).toString("base64"))
			sendRequest.mockResolvedValueOnce(response([new vscode.LanguageModelTextPart("Recovered.")]))
			const replay = [
				...messages,
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "accepted-call", name: "read_file", input: { path: "README.md" } },
					],
					vscodeLmStatefulMarker: persistedMarker,
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "accepted-call",
							content: "Tool did not execute because the provider response failed.",
							is_error: true,
						},
					],
				},
			] as Anthropic.Messages.MessageParam[]
			await collectAgentResponse(handler.createMessage("Instructions", replay, { taskId: "lm-contract", tools }))
			const projected = sendRequest.mock.calls[1]![0] as vscode.LanguageModelChatMessage[]
			expect(projected[2]!.content).toContainEqual(expect.objectContaining({ callId: "accepted-call" }))
			expect(projected[2]!.content).toContainEqual(
				expect.objectContaining({ mimeType: "stateful_marker", data: marker }),
			)
			expect(projected[3]!.content).toContainEqual(expect.objectContaining({ callId: "accepted-call" }))
		},
	)

	it.each(["undefined", "array", "throw"])(
		"fails closed when argument serialization produces %s",
		async (variant) => {
			const input = {
				toJSON() {
					if (variant === "throw") throw new Error("private serialization error")
					return variant === "array" ? [] : undefined
				},
			}
			const { result } = await observe([new vscode.LanguageModelToolCallPart("bad-call", "read_file", input)])
			expect(result.toolCalls).toEqual([])
			expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
			expect(result.outcome?.reason).not.toContain("private serialization error")
		},
	)

	it("rejects structurally recognized invalid intent while retaining bounded safe correlation", async () => {
		const { result, chunks } = await observe([{ callId: "c".repeat(400), name: "read_file", input: null }])
		expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
		expect(chunks).toContainEqual(
			expect.objectContaining({
				type: "error",
				metadata: { callId: "c".repeat(256), toolName: "read_file" },
			}),
		)
	})

	it.each(["text", "reasoning"])(
		"does not misclassify recognized tool intent carrying %s-like extra fields",
		async (kind) => {
			const part = Object.assign(
				new vscode.LanguageModelToolCallPart("bad-call", "read_file", null as unknown as object),
				{
					value: "This is not a completed response.",
					...(kind === "reasoning" ? { id: "thinking-id", metadata: {} } : {}),
				},
			)
			const { result } = await observe([part])
			expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
			expect(result.text).toBe("")
			expect(result.reasoning).toBe("")
		},
	)

	it.each(["usage", "stateful_marker"])(
		"does not accept later semantic parts carrying %s metadata fields after invalid intent",
		async (mimeType) => {
			const { result, chunks } = await observe([
				new vscode.LanguageModelToolCallPart("bad-call", "read_file", null as unknown as object),
				Object.assign(new vscode.LanguageModelToolCallPart("later-call", "read_file", { path: "later.ts" }), {
					mimeType,
					data: new TextEncoder().encode("untrusted tool metadata"),
				}),
				Object.assign(new vscode.LanguageModelTextPart("Cannot certify completion."), {
					mimeType,
					data: new TextEncoder().encode("untrusted text metadata"),
				}),
			])
			expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
			expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
			expect(result.toolCalls).toEqual([])
			expect(result.text).toBe("")
			expect(handler.getStatefulMarker()).toBeUndefined()
		},
	)

	it("rejects recognized tool intent when no tools were offered", async () => {
		sendRequest.mockResolvedValueOnce(
			response([new vscode.LanguageModelToolCallPart("unexpected-call", "read_file", {})]),
		)
		const result = await collectAgentResponse(handler.createMessage("Instructions", messages))
		expect(result.toolCalls).toEqual([])
		expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
	})

	it("retains observed opaque state when cancellation interrupts metadata draining after invalid intent", async () => {
		const marker = new TextEncoder().encode("state-before-cancellation")
		const controller = new AbortController()
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield new vscode.LanguageModelToolCallPart("bad-call", "read_file", null as unknown as object)
				yield new vscode.LanguageModelDataPart(marker, "stateful_marker")
				controller.abort(new Error("cancel metadata draining"))
			})(),
		})
		await expect(
			collectAgentResponse(
				handler.createMessage("Instructions", messages, {
					taskId: "lm-contract",
					tools,
					signal: controller.signal,
				}),
			),
		).rejects.toThrow("Request cancelled by user")
		expect(handler.getStatefulMarker()).toBe(Buffer.from(marker).toString("base64"))
		expect(cancellationSources[0]!.token.isCancellationRequested).toBe(true)
	})

	it("preserves observed opaque state on host stream errors", async () => {
		const marker = new TextEncoder().encode("state-before-host-error")
		sendRequest.mockResolvedValueOnce({
			stream: (async function* () {
				yield new vscode.LanguageModelToolCallPart("accepted-call", "read_file", { path: "README.md" })
				yield new vscode.LanguageModelDataPart(marker, "stateful_marker")
				throw new Error("host iterator failed")
			})(),
		})
		await expect(
			collectAgentResponse(handler.createMessage("Instructions", messages, { taskId: "lm-contract", tools })),
		).rejects.toThrow("host iterator failed")
		expect(handler.getStatefulMarker()).toBe(Buffer.from(marker).toString("base64"))
	})

	it("does not let failed predecessor cleanup overwrite the successor's opaque state", async () => {
		const oldMarker = new TextEncoder().encode("old-state")
		const newMarker = new TextEncoder().encode("new-state")
		let finishOldRead!: (value: IteratorResult<unknown>) => void
		const oldReadGate = new Promise<IteratorResult<unknown>>((resolve) => {
			finishOldRead = resolve
		})
		const parts = [
			new vscode.LanguageModelDataPart(oldMarker, "stateful_marker"),
			new vscode.LanguageModelToolCallPart("bad-call", "read_file", null as unknown as object),
		]
		let partIndex = 0
		const oldIterator = {
			[Symbol.asyncIterator]() {
				return this
			},
			next() {
				return partIndex < parts.length
					? Promise.resolve({ done: false as const, value: parts[partIndex++] })
					: oldReadGate
			},
			return: vi.fn(async () => ({ done: true as const, value: undefined })),
		}
		sendRequest.mockResolvedValueOnce({ stream: oldIterator })
		const predecessor = handler.createMessage("Instructions", messages, { taskId: "lm-contract", tools })
		expect((await predecessor.next()).value).toMatchObject({ type: "error", retryable: false })
		const oldRead = predecessor.next().catch((error: unknown) => error)
		sendRequest.mockResolvedValueOnce(
			response([
				new vscode.LanguageModelDataPart(newMarker, "stateful_marker"),
				new vscode.LanguageModelTextPart("Complete."),
			]),
		)
		try {
			await collectAgentResponse(
				handler.createMessage("Instructions", messages, { taskId: "lm-contract", tools }),
			)
			expect(await oldRead).toBeInstanceOf(Error)
			expect(handler.getStatefulMarker()).toBe(Buffer.from(newMarker).toString("base64"))
			expect(oldIterator.return).toHaveBeenCalledOnce()
		} finally {
			finishOldRead({ done: true, value: undefined })
		}
	})

	it("keeps unknown future response parts compatible without turning valid text into failure", async () => {
		const { result } = await observe([new vscode.LanguageModelTextPart("Complete."), { futurePart: true }])
		expect(result.text).toBe("Complete.")
		expect(result.outcome).toBeUndefined()
	})

	it.each(["gpt-5.6-sol", "gpt-6-luna"])(
		"uses verified host family %s for instructions while preserving its opaque execution identity",
		async (family) => {
			selectChatModels.mockResolvedValueOnce([{ ...client, family }])
			await handler.prepareModel()
			const model = handler.getModel()
			expect(model.id).toBe(client.id)
			expect(model.instructionModelId).toBe(family)
			expect(resolveCodexModelPrompt(model.instructionModelId).isFallback).toBe(false)
		},
	)

	it("uses the verified family instead of a conflicting recognized routing suffix", async () => {
		handler.dispose()
		const selected = { ...client, id: "copilot-gpt-6-astra", family: "gpt-6-luna" }
		selectChatModels.mockResolvedValueOnce([selected])
		handler = new VsCodeLmHandler({ vsCodeLmModelSelector: { id: selected.id } })
		await handler.prepareModel()
		const model = handler.getModel()
		expect(model.id).toBe(selected.id)
		expect(resolveCodexModelPrompt(model.instructionModelId).promptSlug).toBe("gpt-6-luna")
	})

	it("keeps unknown verified families on the conservative instruction fallback", async () => {
		selectChatModels.mockResolvedValueOnce([{ ...client, family: "unregistered-family" }])
		await handler.prepareModel()
		expect(handler.getModel().instructionModelId).toBe("unregistered-family")
		expect(resolveCodexModelPrompt(handler.getModel().instructionModelId).isFallback).toBe(true)
	})

	it("pins the verified instruction family until the next step prepares a replacement", async () => {
		await handler.prepareModel()
		const changed = { ...client, family: "gpt-6-luna" }
		selectChatModels.mockResolvedValueOnce([changed])
		vi.mocked(vscode.lm.onDidChangeChatModels).mock.calls[0]?.[0]()
		expect(handler.getModel().instructionModelId).toBe("gpt-5.6-sol")
		await handler.prepareModel()
		expect(handler.getModel().instructionModelId).toBe("gpt-6-luna")
		expect(handler.getModel().id).toBe(client.id)
	})
})
