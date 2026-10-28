import type { AlphaProvider } from "../AlphaProvider"
import { MessageEnhancer } from "../messageEnhancer"
import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../messageEnhancer", () => ({
	MessageEnhancer: {
		enhanceMessage: vi.fn(),
		captureTelemetry: vi.fn(),
	},
}))

describe("webviewMessageHandler enhancePrompt", () => {
	const state = { apiConfiguration: {}, includeTaskHistoryInEnhance: true }
	const taskA = { taskId: "task-a", alphaMessages: [{ type: "say", say: "task", text: "A", ts: 1 }] }
	const taskB = { taskId: "task-b", alphaMessages: [{ type: "say", say: "task", text: "B", ts: 2 }] }
	const createProvider = () => ({
		getState: vi.fn().mockResolvedValue(state),
		getCurrentTask: vi.fn<() => typeof taskA | undefined>().mockReturnValue(taskA),
		getLiveTask: vi.fn((taskId: string) => (taskId === taskA.taskId ? taskA : undefined)),
		providerSettingsManager: {},
		postMessageToWebview: vi.fn(),
		log: vi.fn(),
	})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(MessageEnhancer.enhanceMessage).mockResolvedValue({ success: true, enhancedText: "Improved" })
	})

	it("echoes the request ID on success", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider as unknown as AlphaProvider, {
			type: "enhancePrompt",
			requestId: "enhance-a",
			taskId: "task-a",
			text: "Original",
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "enhancedPrompt",
			requestId: "enhance-a",
			text: "Improved",
			enhancementStatus: "success",
		})
		expect(MessageEnhancer.enhanceMessage).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
	})

	it("captures the requested task before asynchronous state loading", async () => {
		const provider = createProvider()
		provider.getCurrentTask.mockReturnValue(taskB)
		let resolveState!: (value: typeof state) => void
		provider.getState.mockImplementationOnce(() => new Promise((resolve) => (resolveState = resolve)))
		const pending = webviewMessageHandler(provider as unknown as AlphaProvider, {
			type: "enhancePrompt",
			requestId: "enhance-a",
			taskId: "task-a",
			text: "Original",
		})
		expect(provider.getLiveTask).toHaveBeenCalledWith("task-a")
		provider.getLiveTask.mockReturnValue(undefined)
		resolveState(state)
		await pending
		expect(MessageEnhancer.enhanceMessage).toHaveBeenCalledWith(
			expect.objectContaining({ currentAlphaMessages: taskA.alphaMessages }),
		)
	})

	it("does not substitute the selected task when the requested task is unavailable", async () => {
		const provider = createProvider()
		await webviewMessageHandler(provider as unknown as AlphaProvider, {
			type: "enhancePrompt",
			requestId: "enhance-unavailable",
			taskId: "unavailable-task",
			text: "Original",
		})
		expect(MessageEnhancer.enhanceMessage).toHaveBeenCalledWith(
			expect.objectContaining({ currentAlphaMessages: undefined }),
		)
		expect(provider.getCurrentTask).not.toHaveBeenCalled()
	})

	it.each(["result", "exception"])("echoes the request ID for a %s failure", async (failure) => {
		const provider = createProvider()
		if (failure === "result") {
			vi.mocked(MessageEnhancer.enhanceMessage).mockResolvedValueOnce({ success: false, error: "Unavailable" })
		} else {
			vi.mocked(MessageEnhancer.enhanceMessage).mockRejectedValueOnce(new Error("Unavailable"))
		}
		await webviewMessageHandler(provider as unknown as AlphaProvider, {
			type: "enhancePrompt",
			requestId: "enhance-a",
			text: "Original",
		})
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "enhancedPrompt",
			requestId: "enhance-a",
			enhancementStatus: "error",
		})
	})

	it("preserves ID-less requests from older webviews without an active task", async () => {
		const provider = createProvider()
		provider.getCurrentTask.mockReturnValue(undefined)
		await webviewMessageHandler(provider as unknown as AlphaProvider, { type: "enhancePrompt", text: "Original" })
		expect(MessageEnhancer.enhanceMessage).toHaveBeenCalledWith(
			expect.objectContaining({ currentAlphaMessages: undefined }),
		)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "enhancedPrompt",
			text: "Improved",
			enhancementStatus: "success",
		})
	})
})
