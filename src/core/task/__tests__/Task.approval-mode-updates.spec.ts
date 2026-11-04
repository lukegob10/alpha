import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AlphaMessage, ApprovalMode } from "@alpha-code/types"

import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../Task"

const edit = JSON.stringify({ tool: "appliedDiff", path: "src/example.ts" })

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((accept) => (resolve = accept))
	return { promise, resolve }
}

function fixture(mode: ApprovalMode = "ask") {
	const state = {
		approvalMode: mode,
		alwaysAllowWriteProtected: false,
		alwaysAllowMcp: false,
		deniedCommands: [] as string[],
	}
	const provider = {
		getState: vi.fn(async () => ({ ...state })),
		isTaskOnScreen: () => true,
		log: vi.fn(),
	}
	const policy = createToolPolicySnapshot({ visibleTools: [], approvalMode: mode })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "approval-update",
		instanceId: "approval-update-instance",
		taskKind: "primary",
		taskApprovalMode: mode,
		taskApprovalModePersistence: Promise.resolve(true),
		taskCancellationController: new AbortController(),
		currentAgentStep: { snapshot: { context: { policy } } },
		providerRef: { deref: () => provider },
		alphaMessages: [],
		messageQueueService: new MessageQueueService(),
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.alphaMessages.push(message)),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		emit: vi.fn(),
	}) as Task
	return { task, state, provider, policy }
}

function request(task: Task, ...args: Parameters<Task["ask"]>) {
	let result: Awaited<ReturnType<Task["ask"]>> | undefined
	const pending = task.ask(...args).then((answer) => (result = answer))
	return { pending, result: () => result }
}

async function finish(task: Task, pending: Promise<unknown>) {
	task.denyAsk()
	await vi.advanceTimersByTimeAsync(100)
	await pending
}

describe("explicit task approval-mode updates", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it.each(["auto", "bypass"] as const)(
		"applies %s to an already pending edit without changing its step snapshot",
		async (mode) => {
			const { task, policy } = fixture()
			const ask = request(task, "tool", edit)
			await vi.advanceTimersByTimeAsync(0)
			try {
				expect(task.getActiveAskTimestamp()).toBeDefined()
				expect(task.setTaskApprovalMode(mode)).toBe(true)
				await vi.advanceTimersByTimeAsync(100)
				expect(ask.result()).toMatchObject({ response: "yesButtonClicked" })
				expect(policy.approval.mode).toBe("ask")
				expect(task.getStepApprovalMode()).toBe("ask")
			} finally {
				await finish(task, ask.pending)
			}
		},
	)

	it.each([
		["tool", JSON.stringify({ tool: "appliedDiff", isOutsideWorkspace: true }), false],
		["tool", edit, true],
		["command", "blocked-command", false],
		["use_mcp_server", JSON.stringify({ type: "use_mcp_tool", serverName: "fixture", toolName: "write" }), false],
	] as const)("retains the pending %s protection after switching to Auto: %s", async (type, text, protectedWrite) => {
		const { task, state } = fixture()
		state.deniedCommands = ["blocked-command"]
		const ask = request(task, type, text, undefined, undefined, protectedWrite)
		await vi.advanceTimersByTimeAsync(0)
		try {
			task.setTaskApprovalMode("auto")
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()?.response).not.toBe("yesButtonClicked")
		} finally {
			await finish(task, ask.pending)
		}
	})

	it("revokes automatic approval for subsequent actions from the same step", async () => {
		const { task, policy } = fixture("bypass")
		task.setTaskApprovalMode("ask")
		const ask = request(task, "tool", edit)
		await vi.advanceTimersByTimeAsync(100)
		try {
			expect(ask.result()).toBeUndefined()
			expect(task.getActiveAskTimestamp()).toBeDefined()
			expect(policy.approval.mode).toBe("bypass")
		} finally {
			await finish(task, ask.pending)
		}
	})

	it("applies Auto to a pending command and later actions from the same step", async () => {
		const { task } = fixture()
		const ask = request(task, "command", "echo approval-update")
		await vi.advanceTimersByTimeAsync(0)
		try {
			task.setTaskApprovalMode("auto")
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()).toMatchObject({ response: "yesButtonClicked" })
			await expect(task.ask("tool", edit)).resolves.toMatchObject({ response: "yesButtonClicked" })
		} finally {
			await finish(task, ask.pending)
		}
	})

	it("keeps an inherited child ceiling when its task dial is raised", async () => {
		const { task } = fixture()
		Object.assign(task, { taskKind: "subagent" })
		const ask = request(task, "tool", edit)
		await vi.advanceTimersByTimeAsync(0)
		try {
			task.setTaskApprovalMode("bypass")
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()?.response).not.toBe("yesButtonClicked")
		} finally {
			await finish(task, ask.pending)
		}
	})

	it("revalidates a mode change received while the permission prompt is being published", async () => {
		const { task } = fixture()
		const publication = deferred<void>()
		vi.mocked(task["addToAlphaMessages"]).mockImplementationOnce(async (message) => {
			task.alphaMessages.push(message)
			await publication.promise
		})
		const ask = request(task, "tool", edit)
		await vi.advanceTimersByTimeAsync(0)
		try {
			task.setTaskApprovalMode("auto")
			publication.resolve()
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()).toMatchObject({ response: "yesButtonClicked" })
		} finally {
			publication.resolve()
			await finish(task, ask.pending)
		}
	})

	it("keeps a revoked automatic decision pending when publication was already in progress", async () => {
		const { task } = fixture("auto")
		const publication = deferred<void>()
		vi.mocked(task["addToAlphaMessages"]).mockImplementationOnce(async (message) => {
			task.alphaMessages.push(message)
			await publication.promise
		})
		const ask = request(task, "tool", edit)
		await vi.advanceTimersByTimeAsync(0)
		try {
			task.setTaskApprovalMode("ask")
			publication.resolve()
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()).toBeUndefined()
			expect(task.alphaMessages.at(-1)?.isAnswered).not.toBe(true)
		} finally {
			publication.resolve()
			await finish(task, ask.pending)
		}
	})

	it("does not approve after cancellation wins an in-flight revalidation", async () => {
		const { task, provider, state } = fixture()
		const controller = new AbortController()
		const ask = request(
			task,
			"tool",
			edit,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			controller.signal,
		)
		await vi.advanceTimersByTimeAsync(0)
		const revalidation = deferred<typeof state>()
		provider.getState.mockImplementationOnce(() => revalidation.promise)
		try {
			task.setTaskApprovalMode("auto")
			controller.abort()
			revalidation.resolve({ ...state })
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()).toMatchObject({ response: "noButtonClicked" })
		} finally {
			revalidation.resolve({ ...state })
			await finish(task, ask.pending)
		}
	})

	it("ignores an automatic decision superseded while settings are being revalidated", async () => {
		const { task, provider, state } = fixture()
		const ask = request(task, "tool", edit)
		await vi.advanceTimersByTimeAsync(0)
		const revalidation = deferred<typeof state>()
		provider.getState.mockImplementationOnce(() => revalidation.promise)
		try {
			task.setTaskApprovalMode("auto")
			task.setTaskApprovalMode("ask")
			revalidation.resolve({ ...state })
			await vi.advanceTimersByTimeAsync(100)
			expect(ask.result()).toBeUndefined()
		} finally {
			revalidation.resolve({ ...state })
			await finish(task, ask.pending)
		}
	})
})
