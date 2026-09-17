import type { ClineMessage } from "@alpha-code/types"
import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { ReasoningSummary } from "../ReasoningSummary"

function harness(createMessage?: ApiHandler["createMessage"]) {
	const handler: ApiHandler = {
		streamCapabilities: { cancellation: true, lifecycle: true },
		getModel: () => ({
			id: "test",
			info: { contextWindow: 100_000, supportsPromptCache: false, inputPrice: 1, outputPrice: 2 },
		}),
		countTokens: vi.fn(),
		createMessage: vi.fn(
			createMessage ??
				async function* (): ApiStream {
					yield {
						type: "text",
						text: "Checking roles against implementation to identify stale documentation.",
					}
					yield { type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.01 }
					yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
				},
		),
	}
	const publish = vi.fn(async () => {})
	const summary = new ReasoningSummary("task-a", publish)
	const message: ClineMessage = {
		ts: 1,
		type: "say",
		say: "reasoning",
		text: "Reasoning paragraph. ".repeat(25),
		partial: true,
	}
	const update = () => summary.update({ message, createHandler: () => handler, protocol: "openai" })
	return { handler, publish, summary, message, update }
}

describe("ReasoningSummary", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("coalesces streamed chunks and requests a tool-free synopsis, preserving the original", async () => {
		const h = harness()
		const original = h.message.text
		for (let i = 0; i < 50; i++) h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).toHaveBeenCalledOnce()
		expect(h.handler.createMessage).toHaveBeenCalledWith(
			expect.any(String),
			[{ role: "user", content: JSON.stringify({ reasoning: original }) }],
			expect.objectContaining({
				taskId: "task-a",
				tools: [],
				tool_choice: "none",
				store: false,
				suppressPreviousResponseId: true,
				signal: expect.any(AbortSignal),
			}),
		)
		expect(h.message.text).toBe(original)
		expect(h.message.reasoningSummary).toContain("Checking roles")
		expect(h.message.reasoningSummaryUsage).toMatchObject({ tokensIn: 100, tokensOut: 20, cost: 0.01 })
		expect(h.publish).toHaveBeenCalledOnce()
		h.summary.dispose()
	})

	it("refreshes once at completion and caps requests per row", async () => {
		const h = harness()
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		h.message.text += "Another direction."
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).toHaveBeenCalledOnce()
		h.message.partial = false
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		h.message.text += " More."
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).toHaveBeenCalledTimes(2)
		expect(h.message.reasoningSummaryUsage?.cost).toBe(0.02)
		h.summary.dispose()
	})

	it.each(["dispose", "deadline"])("cancels a stalled request on %s without publishing late output", async (kind) => {
		let control: ApiHandlerCreateMessageMetadata | undefined
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = harness(async function* (_prompt, _messages, metadata): ApiStream {
			control = metadata
			await pending
			yield { type: "text", text: "Late result" }
		})
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		if (kind === "dispose") h.summary.dispose()
		else await vi.advanceTimersByTimeAsync(15_000)
		expect(control?.signal?.aborted).toBe(true)
		release()
		await vi.advanceTimersByTimeAsync(1)
		expect(h.message.reasoningSummary).toBeUndefined()
		if (kind === "dispose") expect(h.publish).not.toHaveBeenCalled()
		h.summary.dispose()
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["failure", "tool", "long", "incomplete"])("rejects %s output", async (kind) => {
		const h = harness(async function* (): ApiStream {
			yield { type: "text", text: kind === "long" ? "x".repeat(281) : "A synopsis." }
			if (kind === "failure") throw new Error("offline")
			if (kind === "tool") yield { type: "tool_call", id: "no", name: "read_file", arguments: "{}" }
			yield {
				type: "outcome",
				status: kind === "incomplete" ? "incomplete" : "completed",
				terminal: true,
				semanticOutputObserved: true,
			}
		})
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.message.reasoningSummary).toBeUndefined()
		h.summary.dispose()
	})

	it("does not request a synopsis without source or cancellable transport", async () => {
		const h = harness()
		h.message.text = ""
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).not.toHaveBeenCalled()
		h.message.text = "Source reasoning."
		h.message.partial = false
		Object.assign(h.handler, { streamCapabilities: undefined })
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).not.toHaveBeenCalled()
		h.summary.dispose()
	})

	it("serializes requests, coalesces pending rows, and disposes each temporary handler", async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = harness(async function* (): ApiStream {
			await pending
			yield { type: "text", text: "Checking the implementation." }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const dispose = vi.fn()
		Object.assign(h.handler, { dispose })
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		const queued = { ...h.message, ts: 2, text: "Old pending row", partial: false }
		const newest = { ...queued, ts: 3, text: "Most recent direction" }
		for (const message of [queued, newest])
			h.summary.update({ message, createHandler: () => h.handler, protocol: "openai" })
		await vi.advanceTimersByTimeAsync(750)
		expect(h.handler.createMessage).toHaveBeenCalledOnce()
		release()
		await vi.advanceTimersByTimeAsync(751)
		expect(h.handler.createMessage).toHaveBeenCalledTimes(2)
		expect(queued.reasoningSummary).toBeUndefined()
		expect(newest.reasoningSummary).toBe("Checking the implementation.")
		expect(dispose).toHaveBeenCalledTimes(2)
		h.summary.dispose()
	})

	it("retains reported usage when cancellation discards a late summary", async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = harness(async function* (): ApiStream {
			yield { type: "usage", inputTokens: 100, outputTokens: 5, totalCost: 0.01 }
			await pending
			yield { type: "text", text: "Late summary" }
		})
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		h.summary.dispose()
		release()
		await vi.advanceTimersByTimeAsync(1)
		expect(h.message.reasoningSummaryUsage?.cost).toBe(0.01)
		expect(h.message.reasoningSummary).toBeUndefined()
		expect(h.publish).not.toHaveBeenCalled()
	})

	it("does not apply a summary after its source has been replaced", async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = harness(async function* (): ApiStream {
			await pending
			yield { type: "text", text: "Old direction" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		h.update()
		await vi.advanceTimersByTimeAsync(750)
		h.message.text = "Replacement source"
		release()
		await vi.advanceTimersByTimeAsync(1)
		expect(h.message.reasoningSummary).toBeUndefined()
		h.summary.dispose()
	})
})
