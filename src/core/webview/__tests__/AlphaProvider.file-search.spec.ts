import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WebviewMessage } from "@alpha-code/types"
import type * as vscode from "vscode"

vi.mock("../webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))

import { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((accept, fail) => {
		resolve = accept
		reject = fail
	})
	return { promise, resolve, reject }
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
	const getActiveTaskId = vi.fn<() => string | undefined>(() => "task-one")
	const tasks = new Map<string, { taskId: string; cwd: string }>()
	const getLiveTask = vi.fn((taskId: string): { taskId: string; cwd: string } | undefined => {
		if (!tasks.has(taskId)) tasks.set(taskId, { taskId, cwd: `/workspace/${taskId}` })
		return tasks.get(taskId)
	})
	let cwd = "/workspace"
	let attached = true
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskSessions: { getOwnedTasks: () => [] },
		taskStack: [],
		subagentRunFinalizations: new Map(),
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		getActiveTaskId,
		getCurrentTask: () => {
			const taskId = getActiveTaskId()
			return taskId ? getLiveTask(taskId) : undefined
		},
		getLiveTask,
		clearWebviewFocus: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	})
	Object.defineProperty(provider, "cwd", { get: () => cwd })
	let receive!: (message: WebviewMessage) => Promise<void> | undefined
	const webview = {
		onDidReceiveMessage: (handler: typeof receive) => {
			receive = handler
			return { dispose: vi.fn() }
		},
	} as unknown as vscode.Webview
	Reflect.get(provider, "setWebviewMessageListener").call(
		provider,
		webview,
		() => attached && Reflect.get(provider, "_disposed") !== true,
	)
	return {
		provider,
		receive,
		getActiveTaskId,
		getLiveTask,
		setCwd: (next: string) => (cwd = next),
		detach: () => {
			attached = false
			Reflect.get(provider, "clearWebviewResources").call(provider)
		},
	}
}

function fileSearch(requestId: string, taskId?: string): WebviewMessage {
	return { type: "searchFiles", requestId, query: requestId, ...(taskId ? { taskId } : {}) }
}

function dispatchedFileRequests() {
	return vi
		.mocked(webviewMessageHandler)
		.mock.calls.map(([, message]) => message)
		.filter((message) => message.type === "searchFiles")
}

function fileSearchOptions(requestId: string) {
	return vi.mocked(webviewMessageHandler).mock.calls.find(([, message]) => message.requestId === requestId)?.[3]
		?.fileSearch
}

beforeEach(() => {
	vi.mocked(webviewMessageHandler).mockReset()
})

describe("file picker provider dispatch", () => {
	it("coalesces twenty queries behind one joined reader while unrelated commands remain available", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive } = fixture()
		const first = receive(fileSearch("first"))
		await drain()
		const later = Array.from({ length: 19 }, (_, index) => receive(fileSearch(`query-${index + 1}`)))
		const mutation = receive({ type: "customInstructions", text: "current rules" })
		await drain()
		try {
			expect(fileSearchOptions("first")?.signal.aborted).toBe(true)
			expect(dispatchedFileRequests().map((message) => message.requestId)).toEqual(["first"])
			expect(
				vi
					.mocked(webviewMessageHandler)
					.mock.calls.some(([, message]) => message.type === "customInstructions"),
			).toBe(true)
		} finally {
			blocked.resolve()
			await Promise.all([first, ...later, mutation])
		}
		expect(dispatchedFileRequests().map((message) => message.requestId)).toEqual(["first", "query-19"])
	})

	it("admits file lookup during a queued command without changing command ordering", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "customInstructions") await blocked.promise
		})
		const { receive } = fixture()
		const firstMutation = receive({ type: "customInstructions", text: "first" })
		await drain()
		const secondMutation = receive({ type: "mode", text: "architect" })
		const lookup = receive(fileSearch("lookup"))
		await drain()
		try {
			expect(dispatchedFileRequests()).toHaveLength(1)
			expect(vi.mocked(webviewMessageHandler).mock.calls.some(([, message]) => message.type === "mode")).toBe(
				false,
			)
		} finally {
			blocked.resolve()
			await Promise.all([firstMutation, secondMutation, lookup])
		}
		expect(vi.mocked(webviewMessageHandler).mock.calls.at(-1)?.[1].type).toBe("mode")
	})

	it("isolates file queries from another provider and from ticket lookup in the same conversation", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const firstView = fixture()
		const otherView = fixture()
		const first = firstView.receive(fileSearch("first"))
		await drain()
		const sibling = otherView.receive(fileSearch("sibling"))
		const ticket = firstView.receive({ type: "searchTickets", requestId: "ticket", query: "ticket" })
		await drain()
		try {
			expect(dispatchedFileRequests().map((message) => message.requestId)).toEqual(["first", "sibling"])
			expect(fileSearchOptions("first")?.signal.aborted).toBe(false)
			expect(
				vi.mocked(webviewMessageHandler).mock.calls.some(([, message]) => message.type === "searchTickets"),
			).toBe(true)
		} finally {
			blocked.resolve()
			await Promise.all([first, sibling, ticket])
		}
	})

	it("captures the draft project before the latest pending query can outlive navigation", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive, getActiveTaskId, setCwd } = fixture()
		getActiveTaskId.mockReturnValue(undefined)
		const first = receive(fileSearch("first"))
		await drain()
		const latest = receive(fileSearch("latest"))
		setCwd("/different-project")
		blocked.resolve()
		await Promise.all([first, latest])
		expect(fileSearchOptions("latest")?.cwd).toBe("/workspace")
	})

	it("cancels discovery and drops pending queries when the owning webview is replaced", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive, detach } = fixture()
		const first = receive(fileSearch("first"))
		await drain()
		const pending = receive(fileSearch("pending"))
		detach()
		try {
			expect(fileSearchOptions("first")?.signal.aborted).toBe(true)
			await receive(fileSearch("old-view"))
		} finally {
			blocked.resolve()
			await Promise.all([first, pending])
		}
		expect(dispatchedFileRequests().map((message) => message.requestId)).toEqual(["first"])
	})

	it("cancels file discovery before provider disposal joins the existing global queue", async () => {
		const blocked = deferred()
		const joining = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { provider, receive } = fixture()
		const first = receive(fileSearch("first"))
		await drain()
		const pending = receive(fileSearch("pending"))
		Reflect.set(provider, "webviewMessageQueue", joining.promise)
		const disposal = provider.dispose()
		const failure = new Error("controlled global queue join failure")
		const rejected = expect(disposal).rejects.toBe(failure)
		try {
			expect(fileSearchOptions("first")?.signal.aborted).toBe(true)
		} finally {
			joining.reject(failure)
			await rejected
			blocked.resolve()
			await Promise.all([first, pending])
		}
		expect(dispatchedFileRequests().map((message) => message.requestId)).toEqual(["first"])
	})
})
