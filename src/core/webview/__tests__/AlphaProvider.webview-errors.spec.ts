import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WebviewMessage, WebviewErrorMessage } from "@alpha-code/types"
import type * as vscode from "vscode"

vi.mock("../webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))

import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { hashAgentTurnEvidenceId } from "../../agent/AgentTurnEventLog"

const secret = "private-renderer-canary"
const diagnostic: WebviewErrorMessage = {
	type: "webviewError",
	source: "render",
	errorType: "RangeError",
	failure: "invalid_string_length",
	visibility: "hidden",
}

function fixture() {
	const log = vi.fn()
	const getCurrentTask = vi.fn(() => ({
		taskId: secret,
		clineMessages: [{ text: secret }, { text: secret }],
		apiConversationHistory: [{ content: secret }],
	}))
	const getMetadataForTask = vi.fn(() => ({ activityPhase: "compacting", providerData: secret }))
	const getAgentLifecycleSnapshot = vi.fn()
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		getCurrentTask,
		taskSessions: { getMetadataForTask },
		getAgentLifecycleSnapshot,
		log,
	})
	let receive!: (message: WebviewMessage) => Promise<void> | undefined
	let current = true
	const webview = {
		onDidReceiveMessage: (handler: typeof receive) => {
			receive = handler
			return { dispose: vi.fn() }
		},
	} as unknown as vscode.Webview
	const attach = () => Reflect.get(provider, "setWebviewMessageListener").call(provider, webview, () => current)
	attach()
	return {
		provider,
		receive,
		log,
		getCurrentTask,
		getMetadataForTask,
		getAgentLifecycleSnapshot,
		attach: () => {
			attach()
			return receive
		},
		replace: () => {
			current = false
		},
	}
}

beforeEach(() => {
	vi.mocked(webviewMessageHandler).mockReset()
})

describe("local renderer diagnostic admission", () => {
	it("writes sanitized host context immediately while compaction blocks the global message queue", async () => {
		let complete!: () => void
		const compaction = new Promise<void>((resolve) => (complete = resolve))
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "condenseTaskContextRequest") await compaction
		})
		const { receive, log, getMetadataForTask, getAgentLifecycleSnapshot } = fixture()
		const pending = receive({ type: "condenseTaskContextRequest", text: "task" })
		await Promise.resolve()
		try {
			receive(diagnostic)
			expect(log).toHaveBeenCalledTimes(1)
			const entry = JSON.parse(log.mock.calls[0][0].slice("[webviewError] ".length))
			expect(entry).toEqual({
				timestamp: expect.any(Number),
				...diagnostic,
				taskIdSha256: hashAgentTurnEvidenceId(secret),
				messageCount: 2,
				apiMessageCount: 1,
				phase: "compacting",
			})
			expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
			expect(getMetadataForTask).toHaveBeenCalledWith(secret)
			expect(getAgentLifecycleSnapshot).not.toHaveBeenCalled()
			expect(webviewMessageHandler).toHaveBeenCalledTimes(1)
		} finally {
			complete()
			await pending
		}
	})

	it.each([
		{ message: secret },
		{ stack: secret },
		{ url: secret },
		{ taskId: secret },
		{ source: secret },
		{ errorType: secret },
		{ line: -1 },
		{ column: Number.POSITIVE_INFINITY },
	])("silently rejects malformed or content-bearing messages: %j", (fields) => {
		const { receive, log, getCurrentTask } = fixture()
		receive({ ...diagnostic, ...fields } as unknown as WebviewMessage)
		expect(log).not.toHaveBeenCalled()
		expect(getCurrentTask).not.toHaveBeenCalled()
		expect(webviewMessageHandler).not.toHaveBeenCalled()
	})

	it("deduplicates and caps host reports even if a webview bypasses its client budget", () => {
		const { receive, log, attach } = fixture()
		receive(diagnostic)
		receive(diagnostic)
		expect(log).toHaveBeenCalledTimes(1)
		for (let line = 0; line < 20; line++) receive({ ...diagnostic, line })
		expect(log).toHaveBeenCalledTimes(10)
		const replacementReceive = attach()
		replacementReceive(diagnostic)
		expect(log).toHaveBeenCalledTimes(11)
	})

	it("ignores reports from a detached view", () => {
		const { receive, log, replace } = fixture()
		replace()
		receive(diagnostic)
		expect(log).not.toHaveBeenCalled()
	})

	it("keeps the renderer event when host context is unavailable and omits unknown lifecycle values", () => {
		const { receive, log, getMetadataForTask, getAgentLifecycleSnapshot } = fixture()
		getMetadataForTask.mockImplementationOnce(() => {
			throw new Error(secret)
		})
		receive(diagnostic)
		expect(JSON.parse(log.mock.calls[0][0].slice("[webviewError] ".length))).toMatchObject(diagnostic)
		getMetadataForTask.mockReturnValue({ activityPhase: secret, providerData: secret })
		receive({ ...diagnostic, source: "window" })
		expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
		expect(getAgentLifecycleSnapshot).not.toHaveBeenCalled()
	})

	it("contains output failures and continues accepting ordinary webview actions", async () => {
		const { receive, log } = fixture()
		log.mockImplementationOnce(() => {
			throw new Error(secret)
		})
		expect(() => receive(diagnostic)).not.toThrow()
		const action: WebviewMessage = { type: "playSound", text: "notification" }
		await receive(action)
		expect(webviewMessageHandler).toHaveBeenCalledWith(expect.anything(), action, undefined)
	})
})
