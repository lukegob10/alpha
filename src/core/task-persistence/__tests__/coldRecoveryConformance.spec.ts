import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Anthropic } from "@anthropic-ai/sdk"
import { agentLifecycleEventSchema, type AlphaMessage } from "@alpha-code/types"

import { Task } from "../../task/Task"
import { AgentLifecycleJournal } from "../../agent/lifecycle/AgentLifecycleJournal"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import { TaskRewindStore } from "../TaskRewindStore"
import { saveTaskMessages, readTaskMessages } from "../taskMessages"
import { invalidateOpaqueProviderStateReplay } from "../providerStateScope"

// Keep the production stores and Task recovery logic real; isolate only the host storage location.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (storage: string, taskId: string) => {
		const directory = path.join(storage, "tasks", taskId)
		await fs.mkdir(directory, { recursive: true })
		return directory
	},
	resolveExistingTaskDirectoryPathReadOnly: async (storage: string, taskId: string) =>
		path.join(storage, "tasks", taskId),
}))

const TASK_ID = "cold-recovery-proof"
const RUN_ID = "persisted-run"
const TURN_ID = "persisted-turn"
const STEP_ID = "persisted-step"
const CALL_ID = "single-owned-mutation"
const instruction = "ORIGINAL: preserve the existing user file."
const steering = "STEERING: change only the generated fixture and retain this direction after reload."
const retained: ApiMessage[] = [
	{ ts: 1, role: "user", content: instruction },
	{ ts: 2, role: "assistant", isSummary: true, content: "Compacted context: preserve the original instruction." },
	{ ts: 3, role: "user", content: steering },
]
const assistant: ApiMessage = {
	ts: 4,
	role: "assistant",
	provider_state_scope: { provider: "anthropic", modelId: "fixture-model" },
	content: [
		{ type: "thinking", thinking: "Preserve this signed reasoning.", signature: "opaque+/=\r\n" },
		{ type: "text", text: "Apply the one approved fixture change." },
		{ type: "tool_use", id: CALL_ID, name: "write_to_file", input: { path: "fixture.txt" } },
	],
}
const successfulResult: ApiMessage = {
	ts: 5,
	role: "user",
	content: [{ type: "tool_result", tool_use_id: CALL_ID, content: "fixture written once", is_error: false }],
}

interface RecoveryBoundary {
	apiConversationHistory: ApiMessage[]
	alphaMessages: AlphaMessage[]
	recoverIncompleteCanonicalToolCallsForResume(): Promise<void>
	recoverConversationRewind(): Promise<void>
	buildCleanConversationHistory(history: ApiMessage[]): Anthropic.MessageParam[]
	executeCanonicalToolCalls: ReturnType<typeof vi.fn>
}

let directory: string
let journals: AgentLifecycleJournal[]
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-cold-recovery-proof-"))
	journals = []
})
afterEach(async () => {
	await Promise.all(journals.map((journal) => journal.close()))
	vi.restoreAllMocks()
	expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(directory)).toMatch(/^alpha-cold-recovery-proof-/)
	await fs.rm(directory, { recursive: true, force: true })
})

async function journal() {
	const value = await AgentLifecycleJournal.open(TASK_ID, directory)
	journals.push(value)
	return value
}

async function append(journal: AgentLifecycleJournal, type: string, payload: unknown, stepId?: string) {
	const event = agentLifecycleEventSchema.parse({
		version: 1,
		eventId: randomUUID(),
		sequence: journal.getSequence() + 1,
		taskId: TASK_ID,
		runId: RUN_ID,
		turnId: TURN_ID,
		occurredAt: 10,
		type,
		payload,
		...(stepId ? { stepId } : {}),
	})
	return journal.append(event, { durable: true })
}

async function save(history: ApiMessage[]) {
	const receipt = await saveApiMessages({ taskId: TASK_ID, globalStoragePath: directory, messages: history })
	await new ProviderTranscriptStore(TASK_ID, directory).commitAuthoritativeTranscript(receipt)
}

async function coldTask(events: AgentLifecycleJournal): Promise<RecoveryBoundary> {
	const task = Object.create(Task.prototype) as RecoveryBoundary
	Object.assign(task, {
		taskId: TASK_ID,
		globalStoragePath: directory,
		apiConversationHistory: await readApiMessages({ taskId: TASK_ID, globalStoragePath: directory }),
		alphaMessages: [],
		canonicalLifecycleQueue: Promise.resolve(),
		api: {
			getModel: () => ({ id: "fixture-model", info: { contextWindow: 100_000, supportsPromptCache: false } }),
		},
		apiConfiguration: { apiProvider: "anthropic", apiModelId: "fixture-model" },
		effectiveApiConfiguration: { apiProvider: "anthropic", apiModelId: "fixture-model" },
		replayCanonicalLifecycle: () => events.replay(),
		getCanonicalLifecycleSnapshot: () => events.getSnapshot(),
		enqueueCanonicalLifecycleEvent: (type: string, payload: unknown, stepId?: string) =>
			append(events, type, payload, stepId),
		flushApiConversationHistoryPersistence: async () => undefined,
		initializeApiConversationHistoryWritePrecondition: async () => undefined,
		overwriteApiConversationHistory: async (messages: ApiMessage[]) => {
			await save(messages)
			task.apiConversationHistory = structuredClone(messages)
			return true
		},
		overwriteAlphaMessages: async (messages: AlphaMessage[]) => {
			await saveTaskMessages({ taskId: TASK_ID, globalStoragePath: directory, messages })
			task.alphaMessages = structuredClone(messages)
			return true
		},
		executeCanonicalToolCalls: vi.fn(() => {
			throw new Error("Recovery must not execute the accepted mutation")
		}),
	})
	return task
}

function results(history: ApiMessage[]) {
	return history.flatMap((message) =>
		Array.isArray(message.content)
			? message.content.filter(
					(block): block is Anthropic.ToolResultBlockParam =>
						block.type === "tool_result" && block.tool_use_id === CALL_ID,
				)
			: [],
	)
}

describe("cold recovery conformance across durable owners", () => {
	// Codex ac558e2a normalize.rs repairs missing outputs without executing calls.
	// Alpha intentionally preserves indeterminate effects rather than generic aborted text.
	it.each([
		{ cut: "accepted", effect: false, apiResult: false, journalResult: false, status: "cancelled" },
		{ cut: "effect-started", effect: true, apiResult: false, journalResult: false, status: "indeterminate" },
		{ cut: "api-result", effect: true, apiResult: true, journalResult: false, status: "success" },
		{ cut: "journal-result", effect: true, apiResult: false, journalResult: true, status: "success" },
	])("pairs exactly one truthful result after the $cut crash cut without repeating the mutation", async (cut) => {
		const before = await journal()
		await append(before, "turn_started", { phase: "starting", effectTrackingVersion: 1 })
		await append(before, "step_started", { phase: "working" }, STEP_ID)
		await append(
			before,
			"tool_call_accepted",
			{
				item: {
					itemId: "accepted-item",
					stepId: STEP_ID,
					type: "tool_call",
					toolCallId: CALL_ID,
					name: "write_to_file",
					arguments: { path: "fixture.txt" },
					status: "accepted",
				},
			},
			STEP_ID,
		)
		if (cut.effect) await append(before, "tool_effect_started", { toolCallId: CALL_ID }, STEP_ID)
		await fs.writeFile(path.join(directory, "effect.log"), cut.effect ? "written once\n" : "")
		await save([...retained, assistant, ...(cut.apiResult ? [successfulResult] : [])])
		if (cut.journalResult)
			await append(
				before,
				"tool_result_recorded",
				{
					item: {
						itemId: "terminal-item",
						stepId: STEP_ID,
						type: "tool_result",
						toolCallId: CALL_ID,
						status: "success",
						output: "fixture written once",
					},
				},
				STEP_ID,
			)
		await before.close()

		for (let restart = 0; restart < 2; restart++) {
			const reopened = await journal()
			const task = await coldTask(reopened)
			await task.recoverIncompleteCanonicalToolCallsForResume()
			await task.recoverIncompleteCanonicalToolCallsForResume()
			const snapshot = await reopened.replay()
			expect(
				snapshot?.items.filter((item) => item.type === "tool_result" && item.toolCallId === CALL_ID),
			).toEqual([expect.objectContaining({ status: cut.status })])
			expect(snapshot?.terminalToolCallIds).toEqual([CALL_ID])
			expect(task.executeCanonicalToolCalls).not.toHaveBeenCalled()
			const history = (await new ProviderTranscriptStore(TASK_ID, directory).read()).messages
			expect(history.slice(0, retained.length)).toEqual(retained)
			expect(results(history)).toHaveLength(1)
			expect(results(history)[0]).toMatchObject({ is_error: cut.status !== "success" })
			if (cut.status === "indeterminate") expect(results(history)[0].content).toContain("outcome is unknown")
			expect(await fs.readFile(path.join(directory, "effect.log"), "utf8")).toBe(
				cut.effect ? "written once\n" : "",
			)
			await reopened.close()
		}
	})

	it("retains steering and durable account revocation through a between-projection rewind and repeated reload", async () => {
		const removed: ApiMessage[] = [
			{ ts: 6, role: "user", content: "DISCARDED-FUTURE: this later turn must stay rewound." },
			{
				ts: 7,
				role: "assistant",
				content: [
					{ type: "tool_use", id: "removed-call", name: "write_to_file", input: { path: "discarded.txt" } },
				],
			},
			{
				ts: 8,
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "removed-call",
						content: "removed future output",
						is_error: false,
					},
				],
			},
		]
		await save([...retained, assistant, successfulResult, ...removed])
		const options = { taskId: TASK_ID, globalStoragePath: directory }
		const target = invalidateOpaqueProviderStateReplay([...retained, assistant, successfulResult])
		const ui: AlphaMessage[] = [{ ts: 3, type: "say", say: "user_feedback", text: steering }]
		await saveTaskMessages({
			...options,
			messages: [{ ts: 10, type: "say", say: "text", text: "later discarded turn" }],
		})
		const rewind = new TaskRewindStore(directory, TASK_ID)
		await rewind.begin(ui, target, { runId: RUN_ID, turnId: "removed-turn", toolCallIds: ["removed-call"] })
		await saveTaskMessages({ ...options, messages: ui })
		// Process loss here: only the UI projection committed. The existing write-ahead target remains authoritative.
		for (let restart = 0; restart < 2; restart++) {
			const reopened = await journal()
			const task = await coldTask(reopened)
			await task.recoverConversationRewind()
			expect((await new TaskRewindStore(directory, TASK_ID).read())?.pending).toBeUndefined()
			expect(await readTaskMessages({ ...options, requireExisting: true })).toEqual(ui)
			const saved = (await new ProviderTranscriptStore(TASK_ID, directory).read()).messages
			expect(saved).toEqual(target)
			expect(saved.slice(0, retained.length)).toEqual(retained)
			expect(results(saved)).toHaveLength(1)
			expect(
				JSON.stringify(task.buildCleanConversationHistory([...retained, assistant, successfulResult])),
			).toContain("opaque+/=")
			const projected = JSON.stringify(task.buildCleanConversationHistory(saved))
			expect(projected).toContain(instruction)
			expect(projected).toContain(steering)
			expect(projected).toContain(CALL_ID)
			expect(projected).not.toContain("opaque+/=")
			expect(projected).not.toContain("DISCARDED-FUTURE")
			expect(projected).not.toContain("removed-call")
			expect(saved[retained.length]).toHaveProperty("provider_state_replay_disabled", true)
			await reopened.close()
		}
	})
})
