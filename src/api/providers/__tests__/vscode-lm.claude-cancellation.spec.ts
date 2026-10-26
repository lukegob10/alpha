import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { sendRequest, selectChatModels, cancellationSources, ThinkingPart } = vi.hoisted(() => ({
	sendRequest: vi.fn(),
	selectChatModels: vi.fn(),
	ThinkingPart: class {
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
	},
	cancellationSources: [] as Array<{
		token: { isCancellationRequested: boolean }
		cancel: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}>,
}))

vi.mock("vscode", () => {
	class TextPart {
		constructor(public value: string) {}
	}
	class ToolCallPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class ToolResultPart {
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
		token = { isCancellationRequested: false }
		cancel = vi.fn(() => {
			this.token.isCancellationRequested = true
		})
		dispose = vi.fn()
		constructor() {
			cancellationSources.push(this)
		}
	}
	return {
		version: "1.138.0",
		workspace: {
			onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
			getConfiguration: vi.fn(() => ({ get: () => 600 })),
		},
		lm: { selectChatModels, onDidChangeChatModels: vi.fn(() => ({ dispose() {} })) },
		LanguageModelTextPart: TextPart,
		LanguageModelThinkingPart: ThinkingPart,
		LanguageModelToolCallPart: ToolCallPart,
		LanguageModelToolResultPart: ToolResultPart,
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
import type { ApiStreamChunk } from "../../transform/stream"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

const client = {
	id: "copilot-claude-sonnet-4.6",
	vendor: "copilot",
	family: "claude-sonnet-4.6",
	version: "claude-sonnet-4.6",
	name: "Claude Sonnet 4.6",
	maxInputTokens: 200_000,
	sendRequest,
	countTokens: vi.fn(),
}
const messages = [{ role: "user" as const, content: "Inspect the fixture." }]
let handler: VsCodeLmHandler

describe("Claude through Copilot cancellation during signed thinking", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		cancellationSources.length = 0
		selectChatModels.mockResolvedValue([client])
		handler = new VsCodeLmHandler({
			vsCodeLmModelSelector: { vendor: client.vendor, id: client.id },
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})
	})

	afterEach(() => {
		handler.dispose()
		vi.mocked(vscode.lm.onDidChangeChatModels).mock.calls[0]?.[0]()
		vi.useRealTimers()
	})

	it.each(["tool-call", "empty-response-error"])(
		"cancels signed thinking without waiting for host cleanup and ignores a late %s",
		async (latePart) => {
			const thinking = new ThinkingPart("Inspect the file first.", "thinking-1", {
				encrypted_content: "opaque-thinking-1",
				vscode_thinking_origin_api: "messages",
			})
			const marker = new TextEncoder().encode("claude-interrupted-response")
			const lateRead = deferred<IteratorResult<unknown>>()
			const readStarted = deferred<void>()
			const parts: unknown[] = [thinking, new vscode.LanguageModelDataPart(marker, "stateful_marker")]
			const close = vi.fn(() => new Promise<IteratorResult<unknown>>(() => undefined))
			sendRequest.mockResolvedValueOnce({
				stream: {
					[Symbol.asyncIterator]() {
						return {
							next: () => {
								if (parts.length > 0) return Promise.resolve({ done: false, value: parts.shift() })
								readStarted.resolve()
								return lateRead.promise
							},
							return: close,
						}
					},
				},
			})
			const controller = new AbortController()
			const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener")
			const stream = handler.createMessage("Instructions", messages, {
				taskId: "claude-cancel",
				signal: controller.signal,
				deadline: Date.now() + 10_000,
				tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
			})
			expect((await stream.next()).value).toMatchObject({
				type: "reasoning",
				text: thinking.value,
				vscodeLmThinking: { ...thinking, modelId: client.id, modelVendor: "copilot" },
			})
			expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({
				includeEncryptedThinking: true,
				modelOptions: { reasoningEffort: "high", _enableThinking: true },
			})
			const pending = stream.next()
			const rejected = expect(pending).rejects.toThrow("Request cancelled by user")
			await readStarted.promise
			controller.abort()
			await rejected
			expect(close).toHaveBeenCalledOnce()
			expect(cancellationSources[0]?.cancel).toHaveBeenCalledOnce()
			expect(cancellationSources[0]?.dispose).toHaveBeenCalledOnce()
			expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
			expect(handler.getStatefulMarker()).toBe(Buffer.from(marker).toString("base64"))
			expect(vi.getTimerCount()).toBe(0)

			if (latePart === "tool-call") {
				lateRead.resolve({
					done: false,
					value: new vscode.LanguageModelToolCallPart("late-call", "read_file", { path: "late.txt" }),
				})
			} else {
				lateRead.reject(new Error("Response contained no choices."))
			}
			await expect(stream.next()).resolves.toMatchObject({ done: true })
			sendRequest.mockResolvedValueOnce({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("Recovered.")
				})(),
			})
			const recovered: ApiStreamChunk[] = []
			for await (const chunk of handler.createMessage("Instructions", messages)) recovered.push(chunk)
			expect(recovered.map((chunk) => chunk.type)).toEqual(["text", "usage"])
			expect(recovered[0]).toEqual({ type: "text", text: "Recovered." })
			expect(handler.getStatefulMarker()).toBeUndefined()
			expect(sendRequest).toHaveBeenCalledTimes(2)
			expect(cancellationSources[1]?.cancel).not.toHaveBeenCalled()
			expect(cancellationSources[1]?.dispose).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it("enforces the absolute deadline while Claude emits signature-only thinking", async () => {
		const readStarted = deferred<void>()
		const nextSignature = deferred<IteratorResult<unknown>>()
		const stalled = deferred<IteratorResult<unknown>>()
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const parts: unknown[] = [
			new ThinkingPart("", "terminal-signature", {
				encrypted_content: "opaque-thinking-only",
				vscode_thinking_origin_api: "messages",
			}),
		]
		let metadataReadStarted = false
		sendRequest.mockResolvedValueOnce({
			stream: {
				[Symbol.asyncIterator]() {
					return {
						next: () => {
							if (parts.length > 0) return Promise.resolve({ done: false, value: parts.shift() })
							if (!metadataReadStarted) {
								metadataReadStarted = true
								return nextSignature.promise
							}
							readStarted.resolve()
							return stalled.promise
						},
						return: close,
					}
				},
			},
		})
		const stream = handler.createMessage("Instructions", messages, {
			taskId: "claude-thinking-deadline",
			deadline: Date.now() + 100,
		})
		expect((await stream.next()).value).toMatchObject({ type: "reasoning", text: "" })
		const signatureRead = stream.next()
		await vi.advanceTimersByTimeAsync(70)
		nextSignature.resolve({
			done: false,
			value: new ThinkingPart("", "terminal-signature", {
				encrypted_content: "opaque-thinking-updated",
				vscode_thinking_origin_api: "messages",
			}),
		})
		await expect(signatureRead).resolves.toMatchObject({ value: { type: "reasoning", text: "" } })
		const pending = stream.next()
		const rejected = expect(pending).rejects.toMatchObject({
			name: "ApiStreamDeadlineError",
			phase: "response-stream",
		})
		await readStarted.promise
		await vi.advanceTimersByTimeAsync(30)
		await rejected
		expect(close).toHaveBeenCalledOnce()
		expect(cancellationSources[0]?.cancel).toHaveBeenCalledOnce()
		expect(cancellationSources[0]?.dispose).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		stalled.resolve({ done: true, value: undefined })
		await expect(stream.next()).resolves.toMatchObject({ done: true })
	})
})
