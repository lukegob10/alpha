import { afterEach, describe, expect, it, vi } from "vitest"

import type { ThreadReadResult } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import type { CrossTaskOrchestrationProvider } from "../../webview/CrossTaskOrchestration"
import type { ToolCallbacks } from "../BaseTool"
import {
	createThreadTool,
	forkThreadTool,
	listArchivedThreadsTool,
	listThreadsTool,
	readThreadTool,
	sendMessageToThreadTool,
	setThreadArchivedTool,
	setThreadTitleTool,
	waitThreadsTool,
} from "../ThreadOrchestrationTools"

function snapshot(threadId = "peer", status: "idle" | "active" = "idle"): ThreadReadResult {
	return {
		schemaVersion: 1,
		thread: {
			id: threadId,
			kind: "alpha",
			title: "Parser review",
			preview: "Inspect parser",
			status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
			cwd: "/workspace",
			createdAt: 1,
			updatedAt: 2,
		},
		page: { order: "newest_first", limit: 1, hasMore: false, nextCursor: null },
		turns: [
			{
				id: "turn-1",
				status: status === "active" ? "inProgress" : "completed",
				items: [{ type: "agentMessage", id: "message-1", text: "Parser is sound", phase: "final_answer" }],
			},
		],
	}
}

function fixture() {
	const record = {
		task_id: "new-thread",
		objective: "Inspect parser",
		lifecycle: "running" as const,
		workspace_mode: "shared" as const,
		updated_at: 1,
	}
	const provider = {
		listIndependentThreads: vi.fn(async () => ({ threads: [] })),
		readIndependentThread: vi.fn<CrossTaskOrchestrationProvider["readIndependentThread"]>(async (_caller, id) =>
			snapshot(id),
		),
		createIndependentTask: vi.fn(async () => record),
		forkIndependentTask: vi.fn(async () => record),
		sendIndependentTaskMessage: vi.fn(async (_caller, id) => ({ task_id: id, status: "queued" })),
		setIndependentTaskTitle: vi.fn(async (_caller, id, title) => ({ ...record, task_id: id ?? "caller", title })),
		setIndependentTaskArchived: vi.fn(async (_caller, id, archived) => ({
			...record,
			task_id: id ?? "caller",
			archived,
		})),
	} satisfies Partial<CrossTaskOrchestrationProvider>
	const task = {
		taskId: "caller",
		taskKind: "primary",
		providerRef: new WeakRef(provider),
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
	} as unknown as Task
	const results: unknown[] = []
	const metadata: Array<{ status?: string }> = []
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => undefined),
		pushToolResult: vi.fn((result) => results.push(JSON.parse(String(result)))),
		setResultMetadata: vi.fn((result) => metadata.push(result)),
	}
	return { task, provider, callbacks, results, metadata, record }
}

const mutations = [
	{
		tool: createThreadTool,
		args: { prompt: "Inspect parser" },
		method: "createIndependentTask",
		threadId: "new-thread",
	},
	{ tool: forkThreadTool, args: {}, method: "forkIndependentTask", threadId: "new-thread" },
	{
		tool: sendMessageToThreadTool,
		args: { threadId: "peer", prompt: "Summarize" },
		method: "sendIndependentTaskMessage",
		threadId: "peer",
	},
	{ tool: setThreadTitleTool, args: { title: "Renamed" }, method: "setIndependentTaskTitle", threadId: "caller" },
	{
		tool: setThreadArchivedTool,
		args: { threadId: "peer", archived: true },
		method: "setIndependentTaskArchived",
		threadId: "peer",
	},
] as const

describe("native thread orchestration tools", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("reads independent peers without approval and applies upstream defaults", async () => {
		const { task, provider, callbacks, results } = fixture()
		await listThreadsTool.execute({}, task, callbacks)
		await listArchivedThreadsTool.execute({ cursor: "next-page" }, task, callbacks)
		await readThreadTool.execute({ threadId: "unrelated-root" }, task, callbacks)
		expect(provider.listIndependentThreads).toHaveBeenNthCalledWith(
			1,
			task,
			{ limit: 10, archived: false },
			undefined,
		)
		expect(provider.listIndependentThreads).toHaveBeenNthCalledWith(
			2,
			task,
			{ limit: 10, archived: true, cursor: "next-page" },
			undefined,
		)
		expect(provider.readIndependentThread).toHaveBeenCalledWith(
			task,
			"unrelated-root",
			{ cursor: undefined, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 2_000 },
			undefined,
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(results).toHaveLength(3)
	})

	it("creates and messages with native camelCase contracts and forwards requested model overrides", async () => {
		const { task, provider, callbacks, results } = fixture()
		await createThreadTool.execute(
			{ prompt: "Review parser", title: "Review", model: "selected-model" },
			task,
			callbacks,
		)
		await sendMessageToThreadTool.execute(
			{ threadId: "peer", prompt: "Summarize", model: "selected-model" },
			task,
			callbacks,
		)
		expect(provider.createIndependentTask).toHaveBeenCalledWith(task, "Review parser", "shared", undefined, {
			title: "Review",
			model: "selected-model",
			notifyOnCompletion: false,
		})
		expect(provider.sendIndependentTaskMessage).toHaveBeenCalledWith(task, "peer", "Summarize", {
			model: "selected-model",
			signal: undefined,
		})
		expect(results).toEqual([{ threadId: "new-thread" }, { threadId: "peer" }])
		expect(callbacks.askApproval).toHaveBeenCalledTimes(2)
	})

	it("approval-gates idle forks, titles, and archive changes without granting mode authority", async () => {
		const { task, provider, callbacks, results } = fixture()
		await forkThreadTool.execute({}, task, callbacks)
		await setThreadTitleTool.execute({ title: "  Renamed  " }, task, callbacks)
		await setThreadArchivedTool.execute({ threadId: "peer", archived: true }, task, callbacks)
		expect(provider.forkIndependentTask).toHaveBeenCalledWith(task, undefined, undefined)
		expect(provider.setIndependentTaskTitle).toHaveBeenCalledWith(task, undefined, "Renamed", undefined)
		expect(provider.setIndependentTaskArchived).toHaveBeenCalledWith(task, "peer", true, undefined)
		expect(results[0]).toMatchObject({
			environment: { type: "same-directory" },
			sourceThreadId: "caller",
			threadId: "new-thread",
		})
		expect(callbacks.askApproval).toHaveBeenCalledTimes(3)
	})

	it("emits one denied result and never creates a thread without approval", async () => {
		const { task, provider, callbacks, results, metadata } = fixture()
		callbacks.askApproval = vi.fn(async () => false)
		await createThreadTool.execute({ prompt: "Review parser" }, task, callbacks)
		expect(provider.createIndependentTask).not.toHaveBeenCalled()
		expect(results).toEqual([{ status: "denied", tool: "create_thread" }])
		expect(metadata).toEqual([{ status: "denied" }])
	})

	it.each(mutations)("rejects $method before effects when its receipt cannot fit", async ({ tool, args, method }) => {
		const { task, provider, callbacks, results, metadata } = fixture()
		callbacks.getRemainingOutputChars = () => 1
		callbacks.handleError = vi.fn(async (_action, error) => {
			callbacks.pushToolResult(JSON.stringify({ status: "error", error: error.message }))
		})

		await tool.execute(args as never, task, callbacks)

		expect(provider[method]).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(callbacks.handleError).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(results).toMatchObject([{ status: "error" }])
		expect(metadata).toEqual([{ status: "error" }])
	})

	it("reserves the receipt after approval feedback consumes output capacity", async () => {
		const { task, provider, callbacks, metadata } = fixture()
		let remaining = 800
		callbacks.getRemainingOutputChars = () => remaining
		callbacks.askApproval = vi.fn(async () => {
			remaining = 1
			return true
		})

		await createThreadTool.execute({ prompt: "Inspect parser" }, task, callbacks)

		expect(provider.createIndependentTask).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledOnce()
		expect(metadata).toEqual([{ status: "error" }])
	})

	it.each(mutations)(
		"retains the stable receipt for $method when capacity is available",
		async ({ tool, args, method, threadId }) => {
			const { task, provider, callbacks, results, metadata } = fixture()
			callbacks.getRemainingOutputChars = () => 800

			await tool.execute(args as never, task, callbacks)

			expect(provider[method]).toHaveBeenCalledOnce()
			expect(results).toMatchObject([{ threadId }])
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(String(vi.mocked(callbacks.pushToolResult).mock.calls[0][0]).length).toBeLessThanOrEqual(800)
			expect(metadata).toEqual([{ status: "success" }])
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it("keeps a maximum-length generated thread identity within the reserved budget", async () => {
		const { task, provider, callbacks, results, record } = fixture()
		const threadId = "x".repeat(64)
		callbacks.getRemainingOutputChars = () => 80
		provider.createIndependentTask.mockResolvedValueOnce({ ...record, task_id: threadId })

		await createThreadTool.execute({ prompt: "Inspect parser" }, task, callbacks)

		expect(provider.createIndependentTask).toHaveBeenCalledOnce()
		expect(results).toEqual([{ threadId }])
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("rejects oversized multibyte prompts at direct dispatch before approval or effects", async () => {
		const { task, provider, callbacks, results, metadata } = fixture()
		await createThreadTool.execute({ prompt: "é".repeat(501) }, task, callbacks)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(provider.createIndependentTask).not.toHaveBeenCalled()
		expect(results).toMatchObject([{ status: "error" }])
		expect(metadata).toEqual([{ status: "error" }])
	})

	it("preserves host refusal of model overrides as an error result", async () => {
		const { task, provider, callbacks, results, metadata } = fixture()
		provider.createIndependentTask.mockRejectedValueOnce(new Error("Unsupported model override"))
		await createThreadTool.execute({ prompt: "Inspect", model: "unsupported" }, task, callbacks)
		expect(results).toEqual([{ status: "error", error: "Unsupported model override" }])
		expect(metadata).toEqual([{ status: "error" }])
	})

	it("waits on bounded peer snapshots concurrently and preserves deterministic target order", async () => {
		const { task, provider, callbacks, results } = fixture()
		const releases: Array<() => void> = []
		provider.readIndependentThread.mockImplementation(
			async (_caller, id) =>
				new Promise<ThreadReadResult>((resolve) => releases.push(() => resolve(snapshot(id)))),
		)
		const pending = waitThreadsTool.execute(
			{ targets: [{ threadId: "first" }, { threadId: "second" }], timeoutMs: 0 },
			task,
			callbacks,
		)
		expect(provider.readIndependentThread).toHaveBeenCalledTimes(2)
		for (const release of releases) release()
		await pending
		expect(results[0]).toMatchObject({
			timedOut: false,
			wake: { threadId: "first", reason: "turnCompleted", turnId: "turn-1" },
			polls: [{ thread: { id: "first" } }, { thread: { id: "second" } }],
		})
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("selects the latest assistant and tool items without reordering the thread history", async () => {
		const { task, provider, callbacks, results } = fixture()
		const read = snapshot()
		read.turns[0].items = [
			{ type: "agentMessage", id: "earlier-answer", text: "Initial findings." },
			{ type: "toolCall", id: "earlier-tool", name: "read_file", status: "completed" },
			{ type: "agentMessage", id: "answer", text: "Verified outcome.", phase: "final_answer" },
			{ type: "toolCall", id: "tool", name: "exec_command", status: "completed" },
			{ type: "toolResult", id: "result", text: "Passed.", status: "completed" },
		]
		Object.freeze(read.turns[0].items)
		provider.readIndependentThread.mockResolvedValueOnce(read)

		await waitThreadsTool.execute({ targets: [{ threadId: "peer" }], timeoutMs: 0 }, task, callbacks)

		expect(results[0]).toMatchObject({
			polls: [
				{
					latestAssistantMessageId: "answer",
					latestAssistantMessage: { id: "answer", text: "Verified outcome.", phase: "final_answer" },
					latestToolMarkerId: "tool",
					latestToolMarker: { id: "tool", name: "exec_command", status: "completed" },
				},
			],
		})
		expect(read.turns[0].items.map(({ id }) => id)).toEqual([
			"earlier-answer",
			"earlier-tool",
			"answer",
			"tool",
			"result",
		])
	})

	it("uses afterCursor to avoid waking repeatedly on the same completed turn", async () => {
		vi.useFakeTimers()
		const { task, callbacks, results } = fixture()
		await waitThreadsTool.execute({ targets: [{ threadId: "peer" }], timeoutMs: 0 }, task, callbacks)
		const previous = results[0] as { polls: Array<{ cursor: string }> }
		const pending = waitThreadsTool.execute(
			{ targets: [{ threadId: "peer", afterCursor: previous.polls[0].cursor }], timeoutMs: 1_000 },
			task,
			callbacks,
		)
		await vi.advanceTimersByTimeAsync(1_000)
		await pending
		expect(results[1]).toMatchObject({
			timedOut: true,
			wake: null,
			polls: [{ changed: false, latestAssistantMessage: null }],
		})
		expect(vi.getTimerCount()).toBe(0)
	})

	it("returns an actionable peer promptly when another target read stalls", async () => {
		vi.useFakeTimers()
		const { task, provider, callbacks, results } = fixture()
		let stalledSignal: AbortSignal | undefined
		provider.readIndependentThread.mockImplementation(async (_caller, id, _options, signal) => {
			if (id === "ready") return snapshot(id)
			stalledSignal = signal
			return new Promise<ThreadReadResult>((_resolve, reject) =>
				signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
			)
		})
		await waitThreadsTool.execute(
			{ targets: [{ threadId: "stalled" }, { threadId: "ready" }], timeoutMs: 120_000 },
			task,
			callbacks,
		)
		expect(results[0]).toMatchObject({ timedOut: false, wake: { threadId: "ready", reason: "turnCompleted" } })
		expect(stalledSignal?.aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("cancels all wait reads and releases refresh/deadline resources", async () => {
		vi.useFakeTimers()
		const { task, provider, callbacks, results, metadata } = fixture()
		const controller = new AbortController()
		callbacks.signal = controller.signal
		const readSignals: AbortSignal[] = []
		provider.readIndependentThread.mockImplementation(async (_caller, _id, _options, signal) => {
			readSignals.push(signal!)
			return new Promise<ThreadReadResult>((_resolve, reject) =>
				signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
			)
		})
		const pending = waitThreadsTool.execute({ targets: [{ threadId: "peer" }] }, task, callbacks)
		expect(readSignals).toHaveLength(1)
		controller.abort(new Error("User cancelled"))
		await pending
		expect(readSignals.every((signal) => signal.aborted)).toBe(true)
		expect(results).toEqual([{ status: "cancelled", tool: "wait_threads" }])
		expect(metadata).toEqual([{ status: "cancelled" }])
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each([["caller"], ["peer", "peer"]])("rejects self and duplicate wait targets: %j", async (...ids) => {
		const { task, provider, callbacks, results } = fixture()
		await waitThreadsTool.execute({ targets: ids.map((threadId) => ({ threadId })) }, task, callbacks)
		expect(provider.readIndependentThread).not.toHaveBeenCalled()
		expect(results).toMatchObject([{ status: "error" }])
	})
})
