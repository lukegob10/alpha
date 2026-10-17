import type { ApiHandler } from "../../../api"
import { fallbackTaskTitle, generateTaskTitle, normalizeGeneratedTaskTitle } from "../taskTitle"

async function* stream(chunks: Array<{ type: string; [key: string]: unknown }>) {
	for (const chunk of chunks) yield chunk as never
}

function createHandler(chunks: Array<{ type: string; [key: string]: unknown }>) {
	return {
		streamCapabilities: { cancellation: true },
		prepareModel: vi.fn().mockResolvedValue(undefined),
		setReasoningOptions: vi.fn(),
		createMessage: vi.fn(() => stream(chunks)),
		dispose: vi.fn(),
	} as unknown as ApiHandler & {
		prepareModel: ReturnType<typeof vi.fn>
		setReasoningOptions: ReturnType<typeof vi.fn>
		createMessage: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("automatic task titles", () => {
	it("normalizes provider formatting and bounds titles by Unicode characters", () => {
		expect(normalizeGeneratedTaskTitle('  # "Add concise chat titles!"\nExtra details')).toBe(
			"Add concise chat titles",
		)
		const title = normalizeGeneratedTaskTitle("Create a meaningfully descriptive title for conversations")
		expect(title).toBe("Create a meaningfully descriptive")
		expect(Array.from(title!).length).toBeLessThanOrEqual(36)
	})

	it("falls back to a short imperative label from the first request", () => {
		expect(fallbackTaskTitle("Could you please fix chat naming? More context follows.")).toBe("Fix chat naming")
		expect(fallbackTaskTitle("😀".repeat(40))).toBe("😀".repeat(36))
	})

	it("uses a bounded tools-disabled request and disposes its separate handler", async () => {
		const handler = createHandler([
			{ type: "text", text: "Add concise chat titles." },
			{ type: "outcome", status: "completed", terminal: true },
		])
		const signal = new AbortController().signal

		await expect(generateTaskTitle(handler, "title-task", "Long request 😀".repeat(100), signal)).resolves.toBe(
			"Add concise chat titles",
		)

		const [systemPrompt, messages, metadata] = handler.createMessage.mock.calls[0] as [
			string,
			Array<{ content: string }>,
			Record<string, unknown>,
		]
		expect(Buffer.byteLength(systemPrompt + messages[0].content, "utf8")).toBeLessThanOrEqual(960)
		expect(metadata).toMatchObject({
			taskId: "title-task",
			store: false,
			suppressPreviousResponseId: true,
			tools: [],
			tool_choice: "none",
			parallelToolCalls: false,
		})
		expect(handler.setReasoningOptions).toHaveBeenCalledWith({
			enableReasoningEffort: true,
			reasoningEffort: "low",
		})
		expect(handler.dispose).toHaveBeenCalledOnce()
	})

	it("does not save output from a cancelled provider request", async () => {
		const handler = createHandler([
			{ type: "text", text: "A title that should not be saved" },
			{ type: "outcome", status: "cancelled", terminal: true },
		])

		await expect(
			generateTaskTitle(handler, "title-task", "Summarize this", new AbortController().signal),
		).resolves.toBe(undefined)
	})

	it.each([false, undefined])(
		"skips optional requests on a transport without cancellation: %s",
		async (cancellation) => {
			const handler = createHandler([])
			Object.assign(handler, { streamCapabilities: { cancellation } })

			await expect(
				generateTaskTitle(handler, "title-task", "Summarize this", new AbortController().signal),
			).resolves.toBeUndefined()

			expect(handler.prepareModel).not.toHaveBeenCalled()
			expect(handler.createMessage).not.toHaveBeenCalled()
			expect(handler.dispose).toHaveBeenCalledOnce()
		},
	)

	it.each([
		["prepare", "parent-abort"],
		["prepare", "deadline"],
		["stream", "parent-abort"],
		["stream", "deadline"],
	] as const)("releases a stalled %s request after %s", async (stage, interruption) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const entered = deferred()
		const release = deferred()
		const parent = new AbortController()
		const handler = createHandler([])
		if (stage === "prepare") {
			handler.prepareModel.mockImplementation(async () => {
				entered.resolve()
				await release.promise
			})
		} else {
			handler.createMessage.mockImplementation(async function* () {
				entered.resolve()
				await release.promise
				yield { type: "text", text: "Late title" }
			})
		}
		const completed = vi.fn()
		const result = generateTaskTitle(handler, "title-task", "Summarize this", parent.signal).then((value) => {
			completed(value)
			return value
		})
		try {
			await entered.promise
			if (interruption === "parent-abort") parent.abort(new Error("The task was stopped"))
			else await vi.advanceTimersByTimeAsync(15_000)
			await vi.advanceTimersByTimeAsync(0)

			expect(completed).toHaveBeenCalledWith(undefined)
			expect(handler.dispose).toHaveBeenCalledOnce()
			expect(vi.getTimerCount()).toBe(0)
			if (stage === "prepare") expect(handler.createMessage).not.toHaveBeenCalled()
		} finally {
			release.resolve()
			await result
		}
	})
})
