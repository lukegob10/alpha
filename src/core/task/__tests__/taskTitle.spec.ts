import type { ApiHandler } from "../../../api"
import { fallbackTaskTitle, generateTaskTitle, normalizeGeneratedTaskTitle } from "../taskTitle"

async function* stream(chunks: Array<{ type: string; [key: string]: unknown }>) {
	for (const chunk of chunks) yield chunk as never
}

function createHandler(chunks: Array<{ type: string; [key: string]: unknown }>) {
	return {
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
})
