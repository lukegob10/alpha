import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import { API } from "../api"
import { AlphaProvider } from "../../core/webview/AlphaProvider"

vi.mock("vscode")
vi.mock("../../core/webview/AlphaProvider")

describe("API - DeleteQueuedMessage Command", () => {
	let api: API
	let mockOutputChannel: vscode.OutputChannel
	let mockProvider: AlphaProvider
	let mockRemoveMessage: ReturnType<typeof vi.fn>
	let mockLog: ReturnType<typeof vi.fn>

	beforeEach(() => {
		mockOutputChannel = {
			appendLine: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockRemoveMessage = vi.fn().mockReturnValue(true)

		mockProvider = {
			context: {} as vscode.ExtensionContext,
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getCurrentTask: vi.fn().mockReturnValue({
				messageQueueService: {
					removeMessage: mockRemoveMessage,
					flush: vi.fn().mockResolvedValue(undefined),
				},
			}),
			viewLaunched: true,
		} as unknown as AlphaProvider

		mockLog = vi.fn()

		api = new API(mockOutputChannel, mockProvider, undefined, true)
		;(api as any).log = mockLog
	})

	it("should remove a queued message by id", async () => {
		const messageId = "msg-abc-123"

		await api.deleteQueuedMessage(messageId)

		expect(mockRemoveMessage).toHaveBeenCalledWith(messageId)
		expect(mockRemoveMessage).toHaveBeenCalledTimes(1)
	})

	it("should handle missing current task gracefully and log a message", async () => {
		;(mockProvider.getCurrentTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

		// Should not throw
		await expect(api.deleteQueuedMessage("msg-abc-123")).resolves.toBeUndefined()
		expect(mockLog).toHaveBeenCalledWith(
			"[API#deleteQueuedMessage] no current task; ignoring delete for messageId msg-abc-123",
		)
		expect(mockRemoveMessage).not.toHaveBeenCalled()
	})

	it("should handle non-existent message id gracefully", async () => {
		mockRemoveMessage.mockReturnValue(false)

		// Should not throw even when removeMessage returns false
		await expect(api.deleteQueuedMessage("non-existent-id")).resolves.toBeUndefined()
		expect(mockRemoveMessage).toHaveBeenCalledWith("non-existent-id")
	})
})
