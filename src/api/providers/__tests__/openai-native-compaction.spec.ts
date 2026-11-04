import { OpenAiNativeHandler } from "../openai-native"
import { OpenAiCodexHandler } from "../openai-codex"
import { buildOpenAiResponsesInput } from "../openai-responses"
import { NativeCompactionUnavailableError } from "../../native-compaction"
import type { NativeCompactionCheckpoint } from "@alpha-code/types"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { invalidPersistedApiMessages } from "../../../core/task-persistence/validatePersistedApiMessages"

const mocks = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("openai", () => ({
	default: vi.fn(function () {
		const client = { post: mocks.post, responses: { create: vi.fn() }, withOptions: () => client }
		return client
	}),
}))

function response() {
	return {
		id: "compact-1",
		output: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Retained requirement" }] },
			{ type: "compaction", id: "checkpoint-1", encrypted_content: "opaque-native-state" },
		],
		usage: { input_tokens: 1_000, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } },
	}
}

function handler() {
	return new OpenAiNativeHandler({ openAiNativeApiKey: "test-key", apiModelId: "gpt-6.1-sol" })
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.post.mockResolvedValue(response())
})

describe("public native compaction", () => {
	it("uses the documented native endpoint and preserves the whole output window", async () => {
		const native = handler().nativeCompaction
		if (!native) throw new Error("Missing verified native capability")
		const observeUsage = vi.fn()
		const result = await native.compact(
			"Current instructions",
			[{ role: "user", content: "Original requirement" }],
			{
				taskId: "native-task",
				observeUsage,
			},
		)
		expect(mocks.post).toHaveBeenCalledWith(
			"/responses/compact",
			expect.objectContaining({
				body: {
					model: "gpt-6.1-sol",
					input: [
						{ role: "system", content: "Current instructions" },
						{ role: "user", content: "Original requirement" },
					],
				},
				signal: expect.any(AbortSignal),
			}),
		)
		expect(result.output).toEqual(response().output)
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 1_000,
				outputTokens: 100,
				cacheReadTokens: 200,
				totalCost: expect.any(Number),
			}),
		)
		expect(JSON.stringify(observeUsage.mock.calls)).not.toContain("opaque-native-state")
	})

	it("does not advertise native compaction for SIWC or unverified model additions", () => {
		expect(new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" }).nativeCompaction).toBeUndefined()
		const native = handler()
		const original = native.getModel()
		vi.spyOn(native, "getModel").mockReturnValue({ ...original, id: "future-unverified-model" })
		expect(native.nativeCompaction).toBeUndefined()
		expect(mocks.post).not.toHaveBeenCalled()
	})

	it("charges delivered usage before rejecting an invalid output window", async () => {
		mocks.post.mockResolvedValue({ ...response(), output: [] })
		const observeUsage = vi.fn()
		await expect(handler().nativeCompaction?.compact("", [], { taskId: "task", observeUsage })).rejects.toThrow(
			"Invalid native compaction checkpoint",
		)
		expect(observeUsage).toHaveBeenCalledOnce()
	})

	it("disables a refused native capability so later recovery uses the local route", async () => {
		const native = handler()
		mocks.post.mockRejectedValue(Object.assign(new Error("Unsupported capability"), { status: 400 }))
		await expect(native.nativeCompaction?.compact("", [])).rejects.toBeInstanceOf(NativeCompactionUnavailableError)
		expect(native.nativeCompaction).toBeUndefined()
		expect(mocks.post).toHaveBeenCalledOnce()
	})

	it("cancels a stalled SDK operation without adopting its late response", async () => {
		let release = (_value: ReturnType<typeof response>) => {}
		mocks.post.mockReturnValue(
			new Promise<ReturnType<typeof response>>((resolve) => {
				release = resolve
			}),
		)
		const controller = new AbortController()
		const reason = new Error("Stop native compaction")
		const observeUsage = vi.fn()
		const pending = handler().nativeCompaction?.compact("", [], {
			taskId: "task",
			signal: controller.signal,
			observeUsage,
		})
		controller.abort(reason)
		await expect(pending).rejects.toBe(reason)
		release(response())
		await Promise.resolve()
		expect(observeUsage).not.toHaveBeenCalled()
	})

	it("retains completed usage when Stop arrives before checkpoint adoption", async () => {
		let release = (_value: ReturnType<typeof response>) => {}
		mocks.post.mockReturnValue(
			new Promise<ReturnType<typeof response>>((resolve) => {
				release = resolve
			}),
		)
		const controller = new AbortController()
		const reason = new Error("Stop after native response completion")
		const observeUsage = vi.fn()
		const pending = handler().nativeCompaction?.compact("", [], {
			taskId: "task",
			signal: controller.signal,
			observeUsage,
		})

		release(response())
		controller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(observeUsage).toHaveBeenCalledOnce()
		expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 1_000, outputTokens: 100 }))
	})

	it("bounds a stalled SDK operation by the captured absolute deadline", async () => {
		vi.useFakeTimers()
		try {
			mocks.post.mockReturnValue(new Promise(() => {}))
			const pending = handler().nativeCompaction?.compact("", [], { taskId: "task", deadline: Date.now() + 50 })
			const assertion = expect(pending).rejects.toMatchObject({ timeoutScope: "compaction_deadline" })
			await vi.advanceTimersByTimeAsync(50)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("native checkpoint persistence and request replay", () => {
	function saved(): ApiMessage {
		const source = response()
		const checkpoint: NativeCompactionCheckpoint = {
			protocol: "openai-responses",
			provider: "openai-native",
			modelId: "gpt-6.1-sol",
			responseId: source.id,
			output: source.output,
		}
		return {
			role: "assistant",
			content: [],
			isSummary: true,
			condenseId: "summary-1",
			native_compaction: checkpoint,
			provider_state_scope: { provider: "openai-native", modelId: "gpt-6.1-sol" },
		}
	}

	it("replays every retained item in order after JSON reload before new input", () => {
		const reloaded: ApiMessage = JSON.parse(JSON.stringify(saved()))
		expect(invalidPersistedApiMessages([reloaded])).toBeUndefined()
		expect(
			buildOpenAiResponsesInput("", [], [reloaded, { role: "user", content: "Continue" }], false, true, {
				providerId: "openai-native",
				modelId: "gpt-6.1-sol",
			}),
		).toEqual([...response().output, { role: "user", content: "Continue" }])
	})

	it("appends current host instructions after an untouched retained window", () => {
		const marker = saved()
		if (!marker.native_compaction) throw new Error("Missing fixture checkpoint")
		marker.native_compaction.output.unshift({ type: "message", role: "developer", content: "Old host rule" })
		const expected = structuredClone(marker.native_compaction.output)

		expect(
			buildOpenAiResponsesInput(
				"Current host rule",
				undefined,
				[marker, { role: "user", content: "Continue" }],
				false,
				true,
				{
					providerId: "openai-native",
					modelId: "gpt-6.1-sol",
				},
			),
		).toEqual([
			...expected,
			{ role: "system", content: "Current host rule" },
			{ role: "user", content: "Continue" },
		])
	})

	it.each(["openai-codex", "vscode-lm", "other-provider"])("rejects ciphertext replay through %s", (providerId) => {
		expect(() =>
			buildOpenAiResponsesInput("", [], [saved()], false, true, { providerId, modelId: "gpt-6.1-sol" }),
		).toThrow("requires its original supported provider and model")
	})

	it("rejects a checkpoint with missing or conflicting saved source scope", () => {
		const marker = saved()
		expect(invalidPersistedApiMessages([{ ...marker, provider_state_scope: undefined }])).toContain(
			"invalid native compaction",
		)
		expect(
			invalidPersistedApiMessages([
				{ ...marker, provider_state_scope: { provider: "openai-native", modelId: "other" } },
			]),
		).toContain("invalid native compaction")
	})
})
