import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AlphaCodeEventName, type AlphaMessage } from "@alpha-code/types"

import { AgentMessageInbox } from "../../task-persistence/AgentMessageInbox"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"
import { t } from "../../../i18n"

describe("incoming chat presentation", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-incoming-chat-"))
	})
	afterEach(async () => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	function fixture(overrides: Record<string, unknown> = {}) {
		const history: ApiMessage[] = []
		const inbox = new AgentMessageInbox("recipient", directory)
		const saved: AlphaMessage[][] = []
		const provider = { postTaskMessageToWebview: vi.fn(async () => undefined) }
		let saveQueue = Promise.resolve()
		const enqueue = vi.fn((snapshot: () => AlphaMessage[], committed: () => void) => {
			const write = saveQueue.then(() => {
				saved.push(snapshot())
				committed()
				return true
			})
			saveQueue = write.then(() => undefined)
			return write
		})
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: "recipient",
			taskKind: "primary",
			abort: false,
			alphaMessagesHydrated: true,
			alphaMessages: [{ ts: 10, type: "say", say: "text", text: "Initial prompt" }],
			apiConversationHistory: history,
			agentMessageInbox: inbox,
			agentMessageAdmissions: new Set(),
			lastMessageTs: 10,
			currentAssistantResponseMessageTs: 10,
			isCurrentApiConversationHistoryOwner: vi.fn(() => true),
			providerRef: new WeakRef(provider),
			enqueueAlphaMessagesSave: enqueue,
			emit: vi.fn(),
			saveApiConversationHistory: vi.fn(async () => true),
			addToApiConversationHistory: vi.fn(async (message: ApiMessage) => {
				history.push(message)
				return true
			}),
			...overrides,
		}) as Task
		return { task, inbox, provider, saved, enqueue, history }
	}

	const incoming = { id: "message-1", senderTaskId: "peer", text: "Please review the parser finding." }

	it("persists an attributed stop request once without queuing model input or claiming human input", async () => {
		const { task, inbox, saved, provider, history } = fixture()
		await task.recordAgentStopRequest("peer", "Stop: the investigation is complete.")
		await task.recordAgentStopRequest("peer", "Repeated stop request")
		expect(saved.at(-1)?.at(-1)).toMatchObject({
			say: "agent_message",
			text: "Stop: the investigation is complete.",
			agentMessage: { senderTaskId: "peer", stopStatus: "requested" },
			isProtected: true,
		})
		expect(task.alphaMessages.filter((message) => message.agentMessage?.stopStatus)).toHaveLength(1)
		expect(provider.postTaskMessageToWebview).toHaveBeenCalledTimes(1)
		expect(inbox.hasPending()).toBe(false)
		expect(task.hasPendingAgentMessages()).toBe(false)
		expect(history).toEqual([])
		expect(task.emit).not.toHaveBeenCalledWith(AlphaCodeEventName.TaskUserMessage, task.taskId)
		expect(task.lastMessageTs).toBe(10)
	})

	it("durably marks a successful stop once and reloads it without pending input", async () => {
		const { task, saved } = fixture()
		await task.recordAgentStopRequest("peer", "All work is done.")
		task.abort = true
		const ownership = { guard: () => true, provider: task.providerRef.deref() }
		await task["finalizeAgentStopMessage"](ownership)
		await task["finalizeAgentStopMessage"](ownership)
		expect(saved).toHaveLength(2)
		expect(saved.at(-1)?.at(-1)?.agentMessage?.stopStatus).toBe("stopped")
		const reloaded = fixture({ alphaMessages: structuredClone(saved.at(-1)!) })
		await reloaded.task["deliverAgentMessages"]()
		expect(reloaded.task.alphaMessages.at(-1)?.agentMessage?.stopStatus).toBe("stopped")
		expect(reloaded.task.hasPendingAgentMessages()).toBe(false)
		expect(reloaded.history).toEqual([])
	})

	it("leaves the receipt requested when cancellation no longer owns the task", async () => {
		const { task, saved } = fixture()
		await task.recordAgentStopRequest("peer", "Stop safely.")
		await task["finalizeAgentStopMessage"]({ guard: () => false, provider: task.providerRef.deref() })
		expect(saved).toHaveLength(1)
		expect(task.alphaMessages.at(-1)?.agentMessage?.stopStatus).toBe("requested")
	})

	it("rejects a stop notice before transcript hydration without changing saved history", async () => {
		const { task, saved } = fixture({ alphaMessagesHydrated: false })
		await expect(task.recordAgentStopRequest("peer")).rejects.toThrow(t("common:tasks.peer_stop_loading"))
		expect(saved).toEqual([])
		expect(task.alphaMessages).toHaveLength(1)
	})

	it("does not retain peer cancellation attribution when the notice cannot be persisted", async () => {
		const { task, enqueue, provider, inbox } = fixture()
		enqueue.mockResolvedValue(false)
		await expect(task.recordAgentStopRequest("peer", "Stop safely.")).rejects.toThrow("Unable to persist")
		expect(task["agentStopMessageId"]).toBeUndefined()
		expect(task.alphaMessages).toHaveLength(1)
		expect(provider.postTaskMessageToWebview).not.toHaveBeenCalled()
		expect(inbox.hasPending()).toBe(false)
	})

	it("persists and displays incoming context while preserving a pending human approval", async () => {
		const approval = { type: "tool" }
		const { task, saved, provider, history } = fixture({ activeAsk: approval })
		await task.receiveAgentMessage(incoming)
		expect(saved.at(-1)?.at(-1)).toMatchObject({
			say: "agent_message",
			text: incoming.text,
			agentMessage: { id: incoming.id, senderTaskId: incoming.senderTaskId },
			isProtected: true,
		})
		expect(provider.postTaskMessageToWebview).toHaveBeenCalledWith(
			"messageCreated",
			task.taskId,
			expect.objectContaining({ say: "agent_message" }),
		)
		expect(task["activeAsk"]).toBe(approval)
		expect(task["lastMessageTs"]).toBe(10)
		expect(task["currentAssistantResponseMessageTs"]).toBe(10)
		expect(task.emit).not.toHaveBeenCalledWith(AlphaCodeEventName.TaskUserMessage, task.taskId)
		expect(history).toEqual([])
	})

	it("deduplicates concurrent receipts and retains agent provenance when the inbox is consumed", async () => {
		const { task, history } = fixture()
		await Promise.all([task.receiveAgentMessage(incoming), task.receiveAgentMessage(incoming)])
		await task["deliverAgentMessages"]()
		await task.receiveAgentMessage(incoming)
		await task["deliverAgentMessages"]()
		expect(task.alphaMessages.filter((message) => message.agentMessage?.id === incoming.id)).toHaveLength(1)
		expect(history).toHaveLength(1)
		expect(history[0]).toMatchObject({ input_origin: "agent", agent_message_id: incoming.id })
		expect(JSON.stringify(history)).not.toContain("<user_message>")
	})

	it("defers a cold recipient's receipt until hydration and preserves its saved conversation", async () => {
		const { task, saved } = fixture({ alphaMessagesHydrated: false, alphaMessages: [] })
		await task.receiveAgentMessage(incoming)
		expect(saved).toEqual([])
		const original: AlphaMessage = { ts: 1, type: "say", say: "text", text: "Saved conversation" }
		task.alphaMessages = [original]
		task["alphaMessagesHydrated"] = true
		await task["deliverAgentMessages"]()
		expect(task.alphaMessages[0]).toEqual(original)
		expect(saved.at(-1)).toHaveLength(2)
		expect(saved.at(-1)?.at(-1)?.agentMessage?.id).toBe(incoming.id)
	})

	it("repairs a missing UI receipt without replaying already committed model input", async () => {
		const { task, history } = fixture({ alphaMessagesHydrated: false })
		await task.receiveAgentMessage(incoming)
		history.push({ role: "user", input_origin: "agent", agent_message_id: incoming.id, content: incoming.text })
		task["alphaMessagesHydrated"] = true
		await task["deliverAgentMessages"]()
		expect(history).toHaveLength(1)
		expect(task.alphaMessages.filter((message) => message.agentMessage?.id === incoming.id)).toHaveLength(1)
	})

	it.each(["text", "reasoning", "command_output"] as const)(
		"continues a streamed %s row around an incoming bubble",
		async (say) => {
			const partial: AlphaMessage = { ts: 11, type: "say", say, text: "Working", partial: true }
			const { task } = fixture({
				alphaMessages: [partial],
				currentAssistantResponseMessageTs: 11,
				updateAlphaMessage: vi.fn(async () => undefined),
			})
			await task.receiveAgentMessage(incoming)
			await task.say(say, "Working on the parser", undefined, true)
			expect(task.alphaMessages).toHaveLength(2)
			expect(task.alphaMessages[0]).toMatchObject({ ts: 11, text: "Working on the parser", partial: true })
			expect(task.alphaMessages[1]).toMatchObject({ say: "agent_message", text: incoming.text })
		},
	)

	it("keeps a failed presentation durable in the inbox without exposing an uncommitted bubble", async () => {
		const { task, inbox, enqueue, provider } = fixture()
		const write = enqueue.getMockImplementation()!
		enqueue.mockResolvedValue(false)
		await expect(task.receiveAgentMessage(incoming)).rejects.toThrow("Unable to persist the incoming chat message")
		expect(inbox.hasPending()).toBe(true)
		expect(task.alphaMessages).toHaveLength(1)
		expect(provider.postTaskMessageToWebview).not.toHaveBeenCalled()
		enqueue.mockImplementation(write)
		await task["deliverAgentMessages"]()
		expect(task.alphaMessages.filter((message) => message.agentMessage?.id === incoming.id)).toHaveLength(1)
		expect(inbox.hasPending()).toBe(false)
	})

	it("does not render an internal steering wake as a second human-input bubble", async () => {
		const { task } = fixture()
		const say = vi.spyOn(task, "say").mockResolvedValue(undefined)
		await task["presentSteeringInput"]({ text: "Internal wake", images: [], isAgentMessageWake: true })
		expect(say).not.toHaveBeenCalled()
		await task["presentSteeringInput"]({ text: "Human steering", images: [], inputOrigin: "human" })
		expect(say).toHaveBeenCalledWith("user_feedback", "Human steering", [], undefined, undefined, undefined, {
			queuedMessageIds: undefined,
		})
	})
})
