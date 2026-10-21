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

// Drain promise continuations without adding a timing dependency to dispatch assertions.
const drain = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture() {
	const getActiveTaskId = vi.fn<() => string | undefined>(() => "task-one")
	const getLiveTask = vi.fn((taskId: string): { taskId: string; cwd: string } | undefined => ({
		taskId,
		cwd: `/workspace/${taskId}`,
	}))
	let cwd = "/workspace"
	const provider: AlphaProvider = Object.assign(Object.create(AlphaProvider.prototype), {
		webviewMessageQueue: Promise.resolve(),
		taskControlMessageQueues: new Map(),
		immediateWebviewOperations: new Set(),
		webviewDisposables: [],
		getActiveTaskId,
		getCurrentTask: () => ({ taskId: getActiveTaskId(), cwd: `/workspace/${getActiveTaskId()}` }),
		getLiveTask,
		clearWebviewResources: vi.fn(),
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
	Reflect.get(provider, "setWebviewMessageListener").call(provider, webview)
	return {
		provider,
		receive,
		getActiveTaskId,
		getLiveTask,
		setCwd: (next: string) => {
			cwd = next
		},
	}
}

function ticketSearch(requestId: string, taskId = "task-one"): WebviewMessage {
	return { type: "searchTickets", requestId, query: requestId, taskId }
}

function dispatchedTicketRequests() {
	return vi
		.mocked(webviewMessageHandler)
		.mock.calls.map(([, message]) => message)
		.filter((message) => message.type === "searchTickets")
}

function ticketSearchOptions(requestId: string) {
	return vi.mocked(webviewMessageHandler).mock.calls.find(([, message]) => message.requestId === requestId)?.[3]
		?.ticketSearch
}

beforeEach(() => {
	vi.mocked(webviewMessageHandler).mockReset()
})

describe("ticket picker provider dispatch", () => {
	it.each<WebviewMessage>([
		{ type: "condenseTaskContextRequest", text: "task-one" },
		{ type: "searchFiles", query: "ticket", requestId: "file-search" },
	])("admits ticket lookup while $type is still pending", async (blockingMessage) => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === blockingMessage.type) await blocked.promise
		})
		const { receive } = fixture()
		const previous = receive(blockingMessage)
		await drain()
		const lookup = receive(ticketSearch("only-ticket"))
		await drain()
		try {
			expect(dispatchedTicketRequests().map((message) => message.requestId)).toEqual(["only-ticket"])
		} finally {
			blocked.resolve()
			await Promise.all([previous, lookup])
		}
	})

	it("preserves mutation ordering when ticket lookups bypass the global queue", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.type === "customInstructions") await blocked.promise
		})
		const { receive } = fixture()
		const firstMutation = receive({ type: "customInstructions", text: "first" })
		await drain()
		const secondMutation = receive({ type: "mode", text: "architect" })
		const lookup = receive(ticketSearch("only-ticket"))
		await drain()
		try {
			expect(dispatchedTicketRequests()).toHaveLength(1)
			expect(vi.mocked(webviewMessageHandler).mock.calls.some(([, message]) => message.type === "mode")).toBe(
				false,
			)
		} finally {
			blocked.resolve()
			await Promise.all([firstMutation, secondMutation, lookup])
		}
		expect(vi.mocked(webviewMessageHandler).mock.calls.at(-1)?.[1].type).toBe("mode")
	})

	it("retains only the latest pending query for the same task", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive } = fixture()
		const first = receive(ticketSearch("first"))
		await drain()
		const superseded = receive(ticketSearch("superseded"))
		const latest = receive(ticketSearch("latest"))
		await drain()
		try {
			expect(dispatchedTicketRequests().map((message) => message.requestId)).toEqual(["first"])
			expect(ticketSearchOptions("first")?.signal.aborted).toBe(true)
		} finally {
			blocked.resolve()
			await Promise.all([first, superseded, latest])
		}
		expect(dispatchedTicketRequests().map((message) => message.requestId)).toEqual(["first", "latest"])
		expect(ticketSearchOptions("latest")?.signal.aborted).toBe(false)
	})

	it("isolates lookups belonging to different conversations", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.taskId === "task-one") await blocked.promise
		})
		const { receive } = fixture()
		const first = receive(ticketSearch("one", "task-one"))
		await drain()
		const second = receive(ticketSearch("two", "task-two"))
		await drain()
		try {
			expect(dispatchedTicketRequests().map((message) => message.taskId)).toEqual(["task-one", "task-two"])
		} finally {
			blocked.resolve()
			await Promise.all([first, second])
		}
	})

	it("captures an implicit task before a queued lookup can outlive a focus change", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive, getActiveTaskId } = fixture()
		const first = receive(ticketSearch("first"))
		await drain()
		const pending = receive({ type: "searchTickets", requestId: "pending", query: "ticket" })
		getActiveTaskId.mockReturnValue("task-two")
		blocked.resolve()
		await Promise.all([first, pending])
		expect(dispatchedTicketRequests().find((message) => message.requestId === "pending")?.taskId).toBe("task-one")
		expect(ticketSearchOptions("pending")?.cwd).toBe("/workspace/task-one")
	})

	it("captures the draft project before workspace navigation changes it", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { receive, getActiveTaskId, setCwd } = fixture()
		getActiveTaskId.mockReturnValue(undefined)
		const first = receive({ type: "searchTickets", requestId: "first", query: "" })
		await drain()
		const pending = receive({ type: "searchTickets", requestId: "pending", query: "ticket" })
		setCwd("/different-project")
		blocked.resolve()
		await Promise.all([first, pending])
		expect(ticketSearchOptions("pending")?.cwd).toBe("/workspace")
	})

	it("reports lookup failure when eight other conversations already have active readers", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async () => blocked.promise)
		const { provider, receive } = fixture()
		const active = Array.from({ length: 8 }, (_, index) =>
			receive(ticketSearch(`request-${index}`, `task-${index}`)),
		)
		await drain()
		const overflow = receive(ticketSearch("overflow", "overflow-task"))
		await drain()
		try {
			expect(dispatchedTicketRequests()).toHaveLength(8)
			expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "ticketSearchResults",
				ticketSearch: { type: "ticketSearchResults", requestId: "overflow", tickets: [], error: true },
			})
		} finally {
			blocked.resolve()
			await Promise.all([...active, overflow])
		}
	})

	it.each([null, 42, ""])(
		"ignores malformed task scope %s instead of searching the active project",
		async (taskId) => {
			const { provider, receive } = fixture()
			await receive({
				type: "searchTickets",
				requestId: "invalid",
				query: "",
				taskId,
			} as unknown as WebviewMessage)
			expect(webviewMessageHandler).not.toHaveBeenCalled()
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		},
	)

	it("rejects a missing task at admission even when it registers again before a pending lookup settles", async () => {
		const blocked = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { provider, receive, getLiveTask } = fixture()
		const first = receive(ticketSearch("first"))
		await drain()
		getLiveTask.mockReturnValue(undefined)
		const missing = receive(ticketSearch("missing"))
		await drain()
		getLiveTask.mockReturnValue({ taskId: "task-one", cwd: "/restored-project" })
		try {
			expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "ticketSearchResults",
				ticketSearch: { type: "ticketSearchResults", requestId: "missing", tickets: [], error: true },
			})
			expect(ticketSearchOptions("first")?.signal.aborted).toBe(false)
		} finally {
			blocked.resolve()
			await Promise.all([first, missing])
		}
		expect(dispatchedTicketRequests().map((message) => message.requestId)).toEqual(["first"])
	})

	it("drops queued lookups during disposal and rejects new picker work", async () => {
		const blocked = deferred()
		const joining = deferred()
		vi.mocked(webviewMessageHandler).mockImplementation(async (_provider, message) => {
			if (message.requestId === "first") await blocked.promise
		})
		const { provider, receive } = fixture()
		const first = receive(ticketSearch("first"))
		await drain()
		const pending = receive(ticketSearch("pending"))
		// Stop disposal at its existing global-operation join to isolate picker cleanup.
		Reflect.set(provider, "webviewMessageQueue", joining.promise)
		const disposal = provider.dispose()
		expect(ticketSearchOptions("first")?.signal.aborted).toBe(true)
		const disposalFailure = new Error("Controlled joined-operation failure")
		const rejected = expect(disposal).rejects.toBe(disposalFailure)
		const afterDisposal = receive(ticketSearch("after-disposal"))
		joining.reject(disposalFailure)
		await rejected
		blocked.resolve()
		await Promise.all([first, pending, afterDisposal])
		expect(dispatchedTicketRequests().map((message) => message.requestId)).toEqual(["first"])
	})

	it.skipIf(process.env.ALPHA_TICKET_PICKER_BENCHMARK !== "1")(
		"measures ticket admission behind a ten-second file search in five providers",
		async () => {
			const fileSearch = deferred()
			const starts = new Map<AlphaProvider, number>()
			const admissions = new Map<AlphaProvider, number>()
			vi.mocked(webviewMessageHandler).mockImplementation(async (provider, message) => {
				if (message.type === "searchFiles") await fileSearch.promise
				if (message.type === "searchTickets") admissions.set(provider, performance.now())
			})
			const fixtures = Array.from({ length: 5 }, fixture)
			const fileRequests: (Promise<void> | undefined)[] = []
			const lookups: (Promise<void> | undefined)[] = []
			const timer = setTimeout(fileSearch.resolve, 10000)
			try {
				for (const { provider, receive } of fixtures) {
					fileRequests.push(receive({ type: "searchFiles", requestId: "file-search", query: "ticket" }))
					await drain()
					starts.set(provider, performance.now())
					lookups.push(receive(ticketSearch("only-ticket")))
				}
				await Promise.all(lookups)
				const admissionMs = fixtures.map(({ provider }) => admissions.get(provider)! - starts.get(provider)!)
				console.info(
					JSON.stringify({
						benchmark: "ticket-picker-dispatch",
						providers: fixtures.length,
						precedingFileSearchDelayMs: 10000,
						admissionMs,
					}),
				)
				expect(admissions.size).toBe(5)
				expect(Math.max(...admissionMs)).toBeLessThan(1000)
			} finally {
				clearTimeout(timer)
				fileSearch.resolve()
				await Promise.all([...fileRequests, ...lookups])
			}
		},
	)
})
