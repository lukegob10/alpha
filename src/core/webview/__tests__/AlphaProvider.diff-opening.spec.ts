import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WebviewMessage } from "@alpha-code/types"
import type * as vscode from "vscode"

vi.mock("../webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))

import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((accept) => (resolve = accept))
	return { promise, resolve }
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
	const log = vi.fn()
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		log,
	})
	let receive!: (message: WebviewMessage) => Promise<void> | undefined
	const webview = {
		onDidReceiveMessage: (handler: typeof receive) => {
			receive = handler
			return { dispose: vi.fn() }
		},
	} as unknown as vscode.Webview
	Reflect.get(provider, "setWebviewMessageListener").call(provider, webview)
	return { provider, receive, log }
}

const diffMessage: WebviewMessage = {
	type: "openDiff",
	payload: {
		files: [{ path: "src/file.ts", originalContent: "before\n", finalContent: "after\n" }],
	},
}

beforeEach(() => {
	vi.mocked(webviewMessageHandler).mockReset()
})

describe("captured diff provider dispatch", () => {
	it("opens captured changes while task compaction is pending", async () => {
		const compaction = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "condenseTaskContextRequest") await compaction.promise
		})
		const { provider, receive } = fixture()
		const pendingCompaction = receive({ type: "condenseTaskContextRequest", text: "task-one" })
		await drain()
		const pendingDiff = receive(diffMessage)
		await drain()
		try {
			expect(webviewMessageHandler).toHaveBeenCalledWith(provider, diffMessage, undefined)
		} finally {
			compaction.resolve()
			await Promise.all([pendingCompaction, pendingDiff])
		}
	})

	it("keeps later webview actions available while the editor is opening", async () => {
		const opening = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "openDiff") await opening.promise
		})
		const { provider, receive } = fixture()
		const pendingDiff = receive(diffMessage)
		await drain()
		const laterAction: WebviewMessage = { type: "playSound", text: "notification" }
		const pendingAction = receive(laterAction)
		await drain()
		try {
			expect(webviewMessageHandler).toHaveBeenCalledWith(provider, laterAction, undefined)
		} finally {
			opening.resolve()
			await Promise.all([pendingDiff, pendingAction])
		}
	})

	it("handles an unexpected diff failure and continues accepting webview actions", async () => {
		vi.mocked(webviewMessageHandler).mockRejectedValueOnce(new Error("Controlled editor failure"))
		const { provider, receive, log } = fixture()
		await expect(receive(diffMessage)).resolves.toBeUndefined()
		expect(log).toHaveBeenCalledWith("[webviewMessageHandler] openDiff failed: Controlled editor failure")
		const laterAction: WebviewMessage = { type: "playSound", text: "notification" }
		await receive(laterAction)
		expect(webviewMessageHandler).toHaveBeenCalledWith(provider, laterAction, undefined)
	})
})
