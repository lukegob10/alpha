import { describe, expect, it, vi } from "vitest"
import type { WebviewMessage } from "@alpha-code/types"
import type * as vscode from "vscode"

vi.mock("../webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))

import { AlphaProvider } from "../AlphaProvider"
import { beginPromptEnhancement } from "../promptEnhancementRequests"
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("prompt enhancement provider dispatch and disposal", () => {
	it("admits enhancement and cancellation immediately without blocking unrelated controls", async () => {
		let release!: () => void
		const pending = new Promise<void>((resolve) => (release = resolve))
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "enhancePrompt") await pending
		})
		const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
			webviewMessageQueue: Promise.resolve(),
			taskControlMessageQueues: new Map(),
			immediateWebviewOperations: new Set(),
			webviewDisposables: [],
			log: vi.fn(),
		})
		let receive!: (message: WebviewMessage) => Promise<void>
		const webview = {
			onDidReceiveMessage: (handler: typeof receive) => {
				receive = handler
				return { dispose: vi.fn() }
			},
		} as unknown as vscode.Webview
		Reflect.get(provider, "setWebviewMessageListener").call(provider, webview)

		const enhancement = receive({ type: "enhancePrompt", requestId: "pending", text: "Original" })
		expect(webviewMessageHandler).toHaveBeenCalledWith(
			provider,
			expect.objectContaining({ type: "enhancePrompt" }),
			undefined,
		)
		await receive({ type: "cancelEnhancePrompt", requestId: "pending" })
		await receive({ type: "playSound", text: "notification" })
		expect(webviewMessageHandler).toHaveBeenCalledWith(
			provider,
			expect.objectContaining({ type: "cancelEnhancePrompt" }),
			undefined,
		)
		expect(webviewMessageHandler).toHaveBeenCalledWith(
			provider,
			expect.objectContaining({ type: "playSound" }),
			undefined,
		)
		release()
		await enhancement
	})

	it("aborts accepted enhancement before joining provider disposal", async () => {
		let failJoin!: (error: Error) => void
		const joining = new Promise<void>((_resolve, reject) => (failJoin = reject))
		const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
			webviewMessageQueue: joining,
			clearWebviewResources: vi.fn(),
			log: vi.fn(),
		})
		const request = beginPromptEnhancement(provider, "pending")
		const disposal = provider.dispose()
		expect(request.signal.aborted).toBe(true)
		const failure = new Error("Controlled joined-operation failure")
		failJoin(failure)
		await expect(disposal).rejects.toBe(failure)
		request.finish()
	})
})
