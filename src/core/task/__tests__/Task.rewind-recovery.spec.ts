import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { AgentLifecycleSnapshot, AlphaMessage } from "@alpha-code/types"

import { Task } from "../Task"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { createAgentLifecycleSnapshot } from "../../agent/lifecycle/reducer"
import { TaskRewindStore } from "../../task-persistence/TaskRewindStore"
import { buildCanonicalAssistantHistoryContent } from "../../task-persistence/canonicalAssistantHistory"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { invalidPersistedApiMessages } from "../../task-persistence/validatePersistedApiMessages"

let directory: string
const retainedUi: AlphaMessage[] = [{ ts: 100, type: "say", say: "text", text: "prompt" }]
const retainedApi: ApiMessage[] = [{ ts: 100, role: "user", content: "prompt" }]
const removedCall: ApiMessage = {
	ts: 200,
	role: "assistant",
	content: [{ type: "tool_use", id: "deleted-call", name: "read_file", input: { path: "file.txt" } }],
}

const persistedCallFormats = [
	{ name: "canonical call", call: removedCall.content[0] },
	{
		name: "legacy call",
		call: { type: "tool_call", tool_call_id: "deleted-call", name: "read_file", arguments: { path: "file.txt" } },
	},
	{
		name: "empty canonical alias",
		call: { type: "tool_call", id: "", tool_call_id: "deleted-call", name: "read_file", arguments: {} },
	},
	{
		name: "matching aliases",
		call: { type: "tool_call", id: "deleted-call", tool_call_id: "deleted-call", name: "read_file", arguments: {} },
	},
] as const

function persistedCall(call: unknown): ApiMessage {
	const history: unknown = [{ ...removedCall, content: [call] }]
	expect(invalidPersistedApiMessages(history)).toBeUndefined()
	return (history as ApiMessage[])[0]
}

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-rewind-recovery-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	const resolved = path.resolve(directory)
	expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(resolved)).toMatch(/^alpha-task-rewind-recovery-/)
	await fs.rm(resolved, { recursive: true, force: true })
})

function fixture() {
	const task = Object.create(Task.prototype) as Omit<Task, never> & {
		recoverConversationRewind(): Promise<void>
		recoverIncompleteCanonicalToolCallsForResume(): Promise<void>
		reconcileRecoveredCanonicalToolCallTranscript(snapshot: AgentLifecycleSnapshot): Promise<boolean>
		enqueueCanonicalLifecycleEvent: ReturnType<typeof vi.fn>
	}
	const snapshot = createAgentLifecycleSnapshot({ taskId: "rewind-task", runId: "run", turnId: "turn" })
	snapshot.status = "interrupted"
	snapshot.acceptedToolCallIds = ["deleted-call"]
	snapshot.terminalToolCallIds = ["deleted-call"]
	snapshot.items = [
		{
			itemId: "call-item",
			type: "tool_call",
			toolCallId: "deleted-call",
			name: "read_file",
			arguments: { path: "file.txt" },
			status: "accepted",
		},
		{
			itemId: "result-item",
			type: "tool_result",
			toolCallId: "deleted-call",
			status: "cancelled",
			output: "interrupted",
		},
	]
	Object.assign(task, {
		taskId: "rewind-task",
		globalStoragePath: directory,
		alphaMessages: [...retainedUi, { ts: 200, type: "say", say: "text", text: "deleted" }],
		apiConversationHistory: [...retainedApi, removedCall],
		canonicalLifecycleQueue: Promise.resolve(),
		flushApiConversationHistoryPersistence: vi.fn().mockResolvedValue(undefined),
		replayCanonicalLifecycle: vi.fn().mockResolvedValue(undefined),
		getCanonicalLifecycleSnapshot: vi.fn(() => snapshot),
		enqueueCanonicalLifecycleEvent: vi.fn(),
		overwriteAlphaMessages: vi.fn(async (messages: AlphaMessage[]) => {
			task.alphaMessages = messages
			return true
		}),
		overwriteApiConversationHistory: vi.fn(async (messages: ApiMessage[]) => {
			task.apiConversationHistory = messages
			return true
		}),
	})
	return { task, snapshot, store: new TaskRewindStore(directory, task.taskId) }
}

describe("Task rewind/reload consistency", () => {
	it("does not change either transcript if the write-ahead boundary fails", async () => {
		const { task } = fixture()
		vi.spyOn(TaskRewindStore.prototype, "begin").mockRejectedValueOnce(new Error("receipt disk failure"))
		await expect(task.commitConversationRewind(retainedUi, retainedApi)).rejects.toThrow("receipt disk failure")
		expect(task.overwriteAlphaMessages).not.toHaveBeenCalled()
		expect(task.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it.each(["ui", "api"] as const)("keeps a recoverable receipt and rejects a false %s save", async (source) => {
		const { task, store } = fixture()
		if (source === "ui") vi.mocked(task.overwriteAlphaMessages).mockResolvedValueOnce(false)
		else vi.mocked(task.overwriteApiConversationHistory).mockResolvedValueOnce(false)

		await expect(task.commitConversationRewind(retainedUi, retainedApi)).rejects.toThrow(
			"could not be durably saved",
		)
		expect((await store.read())?.pending).toEqual({ uiMessages: retainedUi, apiHistory: retainedApi })

		const replacement = fixture().task
		await replacement.recoverConversationRewind()
		expect(replacement.alphaMessages).toEqual(retainedUi)
		expect(replacement.apiConversationHistory).toEqual(retainedApi)
		expect((await store.read())?.pending).toBeUndefined()
	})

	it("stages the rollback before either projection write and finishes a between-write crash on reload", async () => {
		const { task, store } = fixture()
		vi.mocked(task.overwriteAlphaMessages).mockImplementationOnce(async (messages) => {
			expect((await store.read())?.pending).toEqual({ uiMessages: retainedUi, apiHistory: retainedApi })
			task.alphaMessages = messages
			return true
		})
		vi.mocked(task.overwriteApiConversationHistory).mockRejectedValueOnce(new Error("process exited"))
		await expect(task.commitConversationRewind(retainedUi, retainedApi)).rejects.toThrow("process exited")

		const replacement = fixture().task
		await replacement.recoverConversationRewind()
		await replacement.recoverConversationRewind()
		expect(replacement.overwriteAlphaMessages).toHaveBeenCalledTimes(1)
		expect(replacement.overwriteApiConversationHistory).toHaveBeenCalledTimes(1)
		expect(replacement.apiConversationHistory).toEqual(retainedApi)
	})

	it("preserves Copilot thinking state when a pending rewind reload excludes deleted tools", async () => {
		const { task, store } = fixture()
		const accumulator = new AgentResponseAccumulator()
		const provenance = { modelVendor: "copilot", modelId: "selected-model", modelVersion: "version-1" }
		await accumulator.add({
			type: "reasoning",
			text: "Retained thinking",
			vscodeLmThinking: {
				value: ["Retained", "thinking"],
				id: "thinking-1",
				metadata: { signature: "retained-state" },
				...provenance,
			},
		})
		await accumulator.add({ type: "text", text: "Retained answer" })
		await accumulator.add({
			type: "reasoning",
			text: "",
			vscodeLmThinking: {
				value: "",
				id: "thinking-1",
				metadata: { _completeThinking: true },
				...provenance,
			},
		})
		const keptAssistant: ApiMessage = {
			role: "assistant",
			ts: 150,
			content: buildCanonicalAssistantHistoryContent(await accumulator.finish()),
		}
		const keptHistory = [...retainedApi, keptAssistant]
		task.apiConversationHistory = [...keptHistory, removedCall]
		vi.mocked(task.overwriteApiConversationHistory).mockRejectedValueOnce(new Error("process exited"))

		await expect(task.commitConversationRewind(retainedUi, keptHistory)).rejects.toThrow("process exited")
		expect((await store.read())?.pending?.apiHistory).toEqual(keptHistory)

		const { task: replacement, snapshot } = fixture()
		await replacement.recoverConversationRewind()
		expect(await replacement.reconcileRecoveredCanonicalToolCallTranscript(snapshot)).toBe(true)
		expect(replacement.apiConversationHistory).toEqual(keptHistory)
		expect(JSON.stringify(replacement.apiConversationHistory)).not.toContain("deleted-call")
		expect((await store.read())?.pending).toBeUndefined()
	})

	it("does not resurrect intentionally deleted tool transactions after interrupted-turn reload", async () => {
		const { task } = fixture()
		await task.commitConversationRewind(retainedUi, retainedApi)
		const { task: replacement, snapshot } = fixture()
		await replacement.recoverConversationRewind()
		replacement.apiConversationHistory = [...retainedApi]
		vi.mocked(replacement.overwriteApiConversationHistory).mockClear()

		expect(await replacement.reconcileRecoveredCanonicalToolCallTranscript(snapshot)).toBe(true)
		expect(replacement.apiConversationHistory).toEqual(retainedApi)
		expect(replacement.overwriteApiConversationHistory).not.toHaveBeenCalled()
	})

	it("still repairs missing calls in a successor turn that reuses a deleted call ID", async () => {
		const { task } = fixture()
		await task.commitConversationRewind(retainedUi, retainedApi)
		const { task: replacement, snapshot } = fixture()
		await replacement.recoverConversationRewind()
		replacement.apiConversationHistory = [...retainedApi]
		snapshot.turnId = "successor-turn"

		expect(await replacement.reconcileRecoveredCanonicalToolCallTranscript(snapshot)).toBe(true)
		expect(replacement.apiConversationHistory).toHaveLength(3)
		expect(replacement.apiConversationHistory[2].content).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "deleted-call", is_error: true }),
		])
	})

	it("closes removed unresolved calls in the journal without restoring their provider transactions", async () => {
		const { task } = fixture()
		await task.commitConversationRewind(retainedUi, retainedApi)
		const { task: replacement, snapshot } = fixture()
		await replacement.recoverConversationRewind()
		replacement.apiConversationHistory = [...retainedApi]
		snapshot.status = "in_progress"
		snapshot.terminalToolCallIds = []
		snapshot.items = snapshot.items.filter((item) => item.type === "tool_call")

		await replacement.recoverIncompleteCanonicalToolCallsForResume()
		expect(replacement.enqueueCanonicalLifecycleEvent).toHaveBeenCalledWith(
			"tool_result_recorded",
			expect.objectContaining({ item: expect.objectContaining({ toolCallId: "deleted-call" }) }),
			expect.any(String),
			undefined,
			{ required: true },
		)
		expect(replacement.enqueueCanonicalLifecycleEvent).toHaveBeenCalledWith(
			"turn_terminal",
			{ status: "interrupted", reason: "process_recovery" },
			undefined,
			undefined,
			{ required: true },
		)
		expect(replacement.apiConversationHistory).toEqual(retainedApi)
	})

	it.each(persistedCallFormats)(
		"does not restore a deliberately deleted result for a retained $name after reload",
		async ({ call }) => {
			const { task, store } = fixture()
			const assistant = persistedCall(call)
			const previous: ApiMessage[] = [
				...retainedApi,
				assistant,
				{
					role: "user",
					ts: 250,
					content: [{ type: "tool_result", tool_use_id: "deleted-call", content: "DELETED_OUTPUT" }],
				},
			]
			const before = structuredClone(previous)
			task.apiConversationHistory = previous
			await task.commitConversationRewind(retainedUi, [...retainedApi, assistant])
			expect(previous).toEqual(before)
			expect((await store.read())?.exclusions).toEqual([{ runId: "run", turnId: "turn", toolCallIds: [] }])
			const savedHistory = structuredClone(task.apiConversationHistory)

			const { task: replacement, snapshot } = fixture()
			snapshot.items = snapshot.items.map((item) =>
				item.type === "tool_result" ? { ...item, output: "DELETED_OUTPUT" } : item,
			)
			replacement.apiConversationHistory = savedHistory
			await replacement.recoverConversationRewind()
			await replacement.reconcileRecoveredCanonicalToolCallTranscript(snapshot)
			expect(replacement.apiConversationHistory).toEqual(savedHistory)
			expect(JSON.stringify(replacement.apiConversationHistory)).not.toContain("DELETED_OUTPUT")
			expect(replacement.apiConversationHistory[2]).toMatchObject({
				role: "user",
				content: [
					expect.objectContaining({ type: "tool_result", tool_use_id: "deleted-call", is_error: true }),
				],
			})
		},
	)

	it.each(persistedCallFormats)("preserves recoverability for a retained $name", async ({ call }) => {
		const { task, store, snapshot } = fixture()
		const assistant = persistedCall(call)
		task.apiConversationHistory = [...retainedApi, assistant]
		await task.commitConversationRewind(retainedUi, [...retainedApi, assistant])
		expect((await store.read())?.exclusions).toEqual([{ runId: "run", turnId: "turn", toolCallIds: [] }])
		expect(await task.reconcileRecoveredCanonicalToolCallTranscript(snapshot)).toBe(true)
		expect(task.apiConversationHistory).toHaveLength(3)
		expect(task.apiConversationHistory[1]).toEqual(assistant)
	})
})
