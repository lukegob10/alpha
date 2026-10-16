import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { AlphaCodeEventName } from "@alpha-code/types"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { AgentMessageInbox } from "../../task-persistence/AgentMessageInbox"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("Task durable independent-agent steering", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-steering-"))
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		const resolved = path.resolve(directory)
		if (
			path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
			!path.basename(resolved).startsWith("alpha-agent-steering-")
		)
			throw new Error("Unexpected agent steering cleanup path")
		await fs.rm(resolved, { recursive: true, force: true })
	})

	function fixture(overrides: Record<string, unknown> = {}) {
		const history: ApiMessage[] = [{ role: "user", input_origin: "human", content: "Inspect safely" }]
		const inbox = new AgentMessageInbox("child", directory)
		const request = new AbortController()
		const wait = new AbortController()
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "child",
			taskKind: "primary",
			orchestrationParentTaskId: "parent",
			abort: false,
			didComplete: false,
			isStreaming: true,
			agentMessageInbox: inbox,
			agentMessageAdmissions: new Set(),
			apiConversationHistory: history,
			currentRequestAbortController: request,
			agentWaitAbortController: wait,
			taskCancellationController: new AbortController(),
			providerRef: { deref: () => undefined },
			messageQueueService: new MessageQueueService(),
			invalidateGoalContinuation: vi.fn(),
			resetMistakeRecoveryState: vi.fn(),
			resetCompletionRecoveryState: vi.fn(),
			cancelAutoApprovalTimeout: vi.fn(),
			handleWebviewAskResponse: vi.fn(),
			emit: vi.fn(),
			saveApiConversationHistory: vi.fn(async () => true),
			addToApiConversationHistory: vi.fn(async (message: ApiMessage) => {
				history.push(message)
				return true
			}),
			...overrides,
		}) as Task
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			assertCrossTaskRoot: vi.fn(),
			getDirectCrossTask: vi.fn(async () => ({ task: child })),
		}) as AlphaProvider
		const steer = () => provider.steerIndependentTask({ taskId: "parent" } as Task, "child", "New guidance")
		return { child, inbox, request, wait, history, steer }
	}

	it("commits sender-attributed agent input before interrupting or acknowledging steering", async () => {
		const { child, inbox, request, wait, steer } = fixture()
		const entered = deferred()
		const release = deferred()
		const receive = inbox.receive.bind(inbox)
		vi.spyOn(inbox, "receive").mockImplementation(async (message) => {
			entered.resolve()
			await release.promise
			await receive(message)
		})
		const steering = steer()
		try {
			const first = await Promise.race([
				entered.promise.then(() => "persisting"),
				steering.then(() => "acknowledged"),
			])
			expect(first).toBe("persisting")
			expect(request.signal.aborted).toBe(false)
			expect(wait.signal.aborted).toBe(false)
			expect(child.hasPendingAgentMessages()).toBe(true)
			release.resolve()
			await expect(steering).resolves.toEqual({ task_id: "child", status: "steered" })
			expect(request.signal.aborted).toBe(true)
			expect(wait.signal.aborted).toBe(true)
			expect(Reflect.get(child, "pendingSteerMessage")).toMatchObject({ inputOrigin: "agent" })
			expect(child.emit).not.toHaveBeenCalledWith(AlphaCodeEventName.TaskUserMessage, "child")
			expect(child.messageQueueService.hasUnconsumedInput()).toBe(false)
			// A host restart loses volatile interruption state, but keeps acknowledged guidance.
			const recovered = vi.fn(async () => undefined)
			await new AgentMessageInbox("child", directory).deliver(recovered)
			expect(recovered).toHaveBeenCalledExactlyOnceWith({
				id: expect.any(String),
				senderTaskId: "parent",
				text: "New guidance",
			})
		} finally {
			release.resolve()
			await steering
		}
	})

	it("persists the actual guidance once with agent provenance and its receipt at the next step", async () => {
		const { child, inbox, history, steer } = fixture()
		await steer()
		const message = vi.mocked(child["addToApiConversationHistory"])
		await child["deliverAgentMessages"]()
		expect(message).toHaveBeenCalledOnce()
		expect(history).toEqual([
			{ role: "user", input_origin: "human", content: "Inspect safely" },
			expect.objectContaining({ input_origin: "agent", agent_message_id: expect.any(String) }),
		])
		const content = history[1].content
		const text = Array.isArray(content)
			? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
			: content
		expect(text).toContain('"sender_task_id":"parent"')
		expect(text).toContain("New guidance")
		expect(text).not.toContain("<user_message>")
		const accepted = vi.fn(async () => undefined)
		await inbox.deliver(accepted)
		expect(accepted).not.toHaveBeenCalled()
	})

	it("does not interrupt if durable admission fails", async () => {
		const { child, inbox, request, wait, steer } = fixture()
		vi.spyOn(inbox, "receive").mockRejectedValue(new Error("Inbox persistence failed"))
		await expect(steer()).rejects.toThrow("Inbox persistence failed")
		expect(request.signal.aborted).toBe(false)
		expect(wait.signal.aborted).toBe(false)
		expect(Reflect.get(child, "pendingSteerMessage")).toBeUndefined()
	})

	it("retries a failed transcript commit with the same receipt without duplicating guidance", async () => {
		const { child, inbox, history, steer } = fixture()
		await steer()
		vi.mocked(child["addToApiConversationHistory"]).mockImplementationOnce(async (message) => {
			history.push(message)
			return false
		})
		await expect(child["deliverAgentMessages"]()).rejects.toThrow("Agent message was not persisted")
		expect(inbox.hasPending()).toBe(true)
		await child["deliverAgentMessages"]()
		expect(child["addToApiConversationHistory"]).toHaveBeenCalledOnce()
		expect(child["saveApiConversationHistory"]).toHaveBeenCalledOnce()
		expect(history.filter((message) => message.agent_message_id)).toHaveLength(1)
		expect(inbox.hasPending()).toBe(false)
	})

	it.each(["tool", "followup", "command_output"] as const)(
		"buffers guidance without answering or interrupting the human %s ask",
		async (type) => {
			const { child, request, wait, steer } = fixture({ activeAsk: { type } })
			await expect(steer()).resolves.toEqual({ task_id: "child", status: "buffered" })
			expect(child.handleWebviewAskResponse).not.toHaveBeenCalled()
			expect(request.signal.aborted).toBe(false)
			expect(wait.signal.aborted).toBe(false)
			expect(Reflect.get(child, "pendingSteerMessage")).toBeUndefined()
			expect(child.hasPendingAgentMessages()).toBe(true)
		},
	)

	it.each([
		{ activeToolApprovalRequest: { requestId: "approval" } },
		{ contextCondenseAbortController: new AbortController() },
		{ askResponse: "messageResponse" },
		{ deferredAskResponse: { response: "messageResponse" } },
		{ isPaused: true },
	])("retains accepted guidance if a control boundary appears during admission: %j", async (boundary) => {
		const { child, inbox, request, steer } = fixture()
		const receive = inbox.receive.bind(inbox)
		vi.spyOn(inbox, "receive").mockImplementation(async (message) => {
			await receive(message)
			Object.assign(child, boundary)
		})
		await expect(steer()).resolves.toEqual({ task_id: "child", status: "buffered" })
		expect(request.signal.aborted).toBe(false)
		expect(Reflect.get(child, "pendingSteerMessage")).toBeUndefined()
		expect(inbox.hasPending()).toBe(true)
	})

	it("preserves concurrent human steering while retaining accepted agent guidance", async () => {
		const pending = { text: "Human correction", images: [], inputOrigin: "human" }
		const { child, steer } = fixture({ pendingSteerMessage: pending, steerMessageAwaitingPersistence: true })
		await expect(steer()).resolves.toEqual({ task_id: "child", status: "buffered" })
		expect(Reflect.get(child, "pendingSteerMessage")).toBe(pending)
		expect(child.hasPendingAgentMessages()).toBe(true)
	})

	it.each(["abort", "didComplete"] as const)(
		"retains input without restarting work if %s wins during admission",
		async (field) => {
			const { child, inbox, request, steer } = fixture()
			const receive = inbox.receive.bind(inbox)
			vi.spyOn(inbox, "receive").mockImplementation(async (message) => {
				await receive(message)
				Reflect.set(child, field, true)
			})
			await expect(steer()).resolves.toEqual({ task_id: "child", status: "buffered" })
			expect(request.signal.aborted).toBe(false)
			expect(Reflect.get(child, "pendingSteerMessage")).toBeUndefined()
			const recovered = vi.fn(async () => undefined)
			await new AgentMessageInbox("child", directory).deliver(recovered)
			expect(recovered).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ senderTaskId: "parent", text: "New guidance" }),
			)
		},
	)
})
