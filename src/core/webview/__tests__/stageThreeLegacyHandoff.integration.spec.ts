import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	type ClineMessage,
	type HistoryItem,
	RooCodeEventName,
	agentControlStateSchema,
	historyItemSchema,
} from "@alpha-code/types"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { AgentControlStore, FileAgentControlPersistence } from "../../agent/AgentControlStore"
import { EnvironmentContext } from "../../environment/EnvironmentContext"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { readApiMessages, saveTaskMessages } from "../../task-persistence"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { ProviderTranscriptStore } from "../../task-persistence/ProviderTranscriptStore"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import { Task } from "../../task/Task"
import { WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"
import { ClineProvider } from "../ClineProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const PARENT_ID = "stage-three-legacy-parent"
const CHILD_ID = "stage-three-legacy-child"
const CHANGE_SET_ID = "legacy-child-applied-worker-change"
const RESULT = "The delegated change is ready."

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function observe(promise: Promise<void>) {
	return promise.then(
		() => ({ status: "fulfilled" as const }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	)
}

async function reachBarrier(barrier: Promise<void>, operation: ReturnType<typeof observe>) {
	await Promise.race([
		barrier,
		operation.then((result) => {
			throw new Error("Operation settled before reaching the controlled barrier", {
				cause: result.status === "rejected" ? result.error : undefined,
			})
		}),
	])
}

async function createHarness() {
	const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "stage-three-legacy-handoff-"))
	const storagePath = path.join(directory, "storage")
	const historyPath = path.join(storagePath, "fixture-history.json")
	const persistence = new FileAgentControlPersistence(storagePath)
	const ledger = new AgentControlStore(persistence)
	await ledger.initialize()
	await ledger.ensureRoot({ taskId: CHILD_ID, objective: "Finish the legacy delegated child", status: "running" })
	await ledger.createAgent({
		taskId: "legacy-verification-worker",
		parentTaskId: CHILD_ID,
		rootTaskId: CHILD_ID,
		nickname: "Legacy Verification Worker",
		role: "worker",
		objective: "Produce applied changes for the child to verify",
		status: "completed",
	})

	const originalUi: ClineMessage[] = [
		{ type: "say", say: "text", text: "Parent requested a delegated change.", ts: 100 },
	]
	const originalApi: ApiMessage[] = [
		{ role: "user", content: "Implement the requested change.", ts: 100 },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "delegate-call",
					name: "new_task",
					input: { mode: "code", message: "Implement the child change." },
				},
			],
			ts: 101,
		},
	]
	const originalParent: HistoryItem = {
		id: PARENT_ID,
		number: 1,
		ts: 100,
		task: "Parent delegation",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "delegated",
		delegatedToId: CHILD_ID,
		awaitingChildId: CHILD_ID,
		childIds: [CHILD_ID],
	}
	const originalChild: HistoryItem = {
		...originalParent,
		id: CHILD_ID,
		number: 2,
		task: "Child implementation",
		parentTaskId: PARENT_ID,
		status: "active",
		delegatedToId: undefined,
		awaitingChildId: undefined,
		childIds: [],
	}
	await safeWriteJson(historyPath, [originalParent, originalChild])
	const readHistory = async () => historyItemSchema.array().parse(JSON.parse(await fs.readFile(historyPath, "utf8")))
	const history = async (taskId: string) => {
		const item = (await readHistory()).find((candidate) => candidate.id === taskId)
		if (!item) throw new Error(`Fixture history is missing ${taskId}`)
		return item
	}
	const updateHistory = vi.fn<ClineProvider["updateTaskHistory"]>(async (item) => {
		const items = (await readHistory()).map((current) => (current.id === item.id ? structuredClone(item) : current))
		await safeWriteJson(historyPath, items)
		return items
	})
	const sessions = new TaskSessionRegistry()
	const gate = new WorkspaceMutationGate()
	const buffers = new Map<
		string,
		{ phase: "preparing" | "committing" | "recovering"; messages: { text: string }[] }
	>()
	const ownerGenerations = Reflect.get(Task, "apiConversationHistoryOwnerGenerations") as Map<string, number>
	const persistenceKeys: string[] = []
	const emit = vi.fn<(event: string, ...args: unknown[]) => boolean>(() => true)
	let provider!: ClineProvider

	const makeTask = (taskId: string) => {
		const persistenceKey = `${path.resolve(storagePath)}\u0000${taskId}`
		persistenceKeys.push(persistenceKey)
		ownerGenerations.set(persistenceKey, 1)
		const task = Object.assign(Object.create(Task.prototype), {
			taskId,
			instanceId: `${taskId}-instance`,
			taskKind: "primary",
			parentTaskId: taskId === CHILD_ID ? PARENT_ID : undefined,
			workspacePath: directory,
			globalStoragePath: storagePath,
			abort: false,
			clineMessages: [],
			apiConversationHistory: [],
			commandExecutionEvidence: new Map(),
			pendingCommandVerification: Promise.resolve(),
			verificationRejectionCount: 0,
			messageQueueService: new MessageQueueService(),
			taskCancellationController: new AbortController(),
			providerRef: { deref: () => provider },
			environmentContext: new EnvironmentContext(),
			apiConversationHistoryPersistenceKey: persistenceKey,
			apiConversationHistoryOwnerGeneration: 1,
			providerTranscriptStore: new ProviderTranscriptStore(taskId, storagePath),
			emit: vi.fn(),
			say: vi.fn<Task["say"]>(async () => undefined),
			resumeAfterDelegation: vi.fn<Task["resumeAfterDelegation"]>(async () => undefined),
			waitForTermination: vi.fn<Task["waitForTermination"]>(async () => undefined),
		}) as Task
		task.abortTask = vi.fn<Task["abortTask"]>(async () => {
			task.abort = true
			await task.flushApiConversationHistoryPersistence()
		})
		task.overwriteClineMessages = vi.fn<Task["overwriteClineMessages"]>(async (messages) => {
			task.clineMessages = structuredClone(messages)
			await saveTaskMessages({ messages, taskId, globalStoragePath: storagePath })
		})
		return task
	}
	const parent = makeTask(PARENT_ID)
	const child = makeTask(CHILD_ID)
	await parent.overwriteClineMessages(originalUi)
	if (!(await parent.overwriteApiConversationHistory(originalApi)))
		throw new Error("Initial parent persistence failed")
	await child.overwriteClineMessages([])
	if (!(await child.overwriteApiConversationHistory([{ role: "user", content: "Implement the child change." }]))) {
		throw new Error("Initial child persistence failed")
	}

	const stageParent = async () => {
		sessions.register(parent, { focus: false })
		const stack = Reflect.get(provider, "clineStack") as Task[]
		if (!stack.includes(parent)) stack.push(parent)
		return parent
	}
	const createParent = vi.fn<ClineProvider["createTaskWithHistoryItem"]>(stageParent)
	const getDecision = vi.fn(async (task: Task) => ledger.getParentCompletionDecision(task.taskId, CHILD_ID))
	// Preserve the provider handoff/removal/mutation gate, session registry, child
	// Task gate, and parent's serialized legacy+sidecar persistence. Only host
	// construction, metadata indexing, UI/resume, and abort/join endpoints vary.
	provider = Object.assign(Object.create(ClineProvider.prototype), {
		contextProxy: { globalStorageUri: { fsPath: storagePath } },
		taskSessions: sessions,
		workspaceMutationGate: gate,
		legacyHandoffInputBuffers: buffers,
		taskEventListeners: new WeakMap(),
		clineStack: [child],
		currentView: { type: "task", taskId: CHILD_ID },
		getParentCompletionDecision: getDecision,
		getTaskWithId: vi.fn<ClineProvider["getTaskWithId"]>(async (taskId) => {
			const taskDirPath = await getTaskDirectoryPath(storagePath, taskId)
			return {
				historyItem: await history(taskId),
				taskDirPath,
				uiMessagesFilePath: path.join(taskDirPath, GlobalFileNames.uiMessages),
				apiConversationHistoryFilePath: path.join(taskDirPath, GlobalFileNames.apiConversationHistory),
				apiConversationHistory: await readApiMessages({ taskId, globalStoragePath: storagePath }),
			}
		}),
		updateTaskHistory: updateHistory,
		createTaskWithHistoryItem: createParent,
		focusTask: vi.fn(async (taskId: string) => {
			sessions.focus(taskId)
		}),
		resetNewTaskDraftMode: vi.fn(),
		emit,
		log: vi.fn(),
	}) as ClineProvider
	sessions.register(child)
	const remove = vi.spyOn(provider, "removeClineFromStack")
	const completionGate = vi.spyOn(child, "getCompletionGateDecision")
	const handoff = () =>
		provider.reopenParentFromDelegation({
			parentTaskId: PARENT_ID,
			childTaskId: CHILD_ID,
			completionResultSummary: RESULT,
		})
	const addDebt = () =>
		ledger.recordWorkerChangeSet({
			rootTaskId: CHILD_ID,
			parentTaskId: CHILD_ID,
			workerTaskId: "legacy-verification-worker",
			workerNickname: "Legacy Verification Worker",
			groupId: "legacy-verification-group",
			changeSet: {
				id: CHANGE_SET_ID,
				status: "applied",
				changedFiles: ["src/changed.ts"],
				createdAt: 1_000,
				updatedAt: 2_000,
			},
			reviewSource: "apply",
			at: 2_000,
		})
	const parentTranscripts = async () => ({
		ui: await readTaskMessages({ taskId: PARENT_ID, globalStoragePath: storagePath }),
		api: await readApiMessages({ taskId: PARENT_ID, globalStoragePath: storagePath }),
		sidecar: await new ProviderTranscriptStore(PARENT_ID, storagePath).read(),
	})
	const assertRolledBack = async () => {
		expect(provider.getLiveTask(CHILD_ID)).toBe(child)
		expect(provider.getLiveTask(PARENT_ID)).toBeUndefined()
		expect(child.abortTask).not.toHaveBeenCalled()
		expect(parent.resumeAfterDelegation).not.toHaveBeenCalled()
		expect(await history(PARENT_ID)).toEqual(originalParent)
		const transcripts = await parentTranscripts()
		expect(transcripts.ui).toEqual(originalUi)
		expect(transcripts.api).toEqual(originalApi)
		expect(transcripts.sidecar.messages).toEqual(originalApi)
		expect(buffers.size).toBe(0)
		expect(child.messageQueueService.listenerCount("stateChanged")).toBe(0)
		await expect(gate.runIfIdle(CHILD_ID, "rollback release probe", async () => "released")).resolves.toBe(
			"released",
		)
		expect(emit.mock.calls.some(([name]) => name === RooCodeEventName.TaskDelegationCompleted)).toBe(false)
	}
	return {
		provider,
		parent,
		child,
		sessions,
		gate,
		buffers,
		ledger,
		persistence,
		createParent,
		stageParent,
		getDecision,
		completionGate,
		remove,
		updateHistory,
		handoff,
		addDebt,
		history,
		parentTranscripts,
		assertRolledBack,
		async dispose() {
			await Promise.all([
				parent.flushApiConversationHistoryPersistence(),
				child.flushApiConversationHistoryPersistence(),
			])
			parent.messageQueueService.removeAllListeners()
			child.messageQueueService.removeAllListeners()
			for (const key of persistenceKeys) ownerGenerations.delete(key)
			await ledger.shutdown()
			await fs.rm(directory, { recursive: true, force: true })
		},
	}
}

describe("Stage Three legacy delegated handoff integration", () => {
	const harnesses: Awaited<ReturnType<typeof createHarness>>[] = []
	const setup = async () => {
		const harness = await createHarness()
		harnesses.push(harness)
		return harness
	}
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()))
		vi.restoreAllMocks()
	})

	it.each(["parent staging", "parent API persistence"] as const)(
		"rolls back if durable debt arrives during %s",
		async (boundary) => {
			const harness = await setup()
			const entered = deferred()
			const release = deferred()
			if (boundary === "parent staging") {
				harness.createParent.mockImplementationOnce(async () => {
					const parent = await harness.stageParent()
					entered.resolve()
					await release.promise
					return parent
				})
			} else {
				vi.spyOn(harness.parent, "overwriteApiConversationHistory").mockImplementationOnce(async (messages) => {
					const saved = await Task.prototype.overwriteApiConversationHistory.call(harness.parent, messages)
					entered.resolve()
					await release.promise
					return saved
				})
			}
			const operation = observe(harness.handoff())
			try {
				await reachBarrier(entered.promise, operation)
				expect(await harness.history(PARENT_ID)).toMatchObject({
					status: "active",
					completedByChildId: CHILD_ID,
				})
				expect(harness.child.abortTask).not.toHaveBeenCalled()
				await harness.addDebt()
			} finally {
				release.resolve()
				await operation
			}
			expect(await operation).toMatchObject({
				status: "rejected",
				error: expect.objectContaining({ message: expect.stringContaining(CHANGE_SET_ID) }),
			})
			expect(harness.completionGate).toHaveBeenCalledOnce()
			const persisted = agentControlStateSchema.parse(await harness.persistence.read())
			expect(persisted.verificationObligations).toContainEqual(
				expect.objectContaining({ changeSetId: CHANGE_SET_ID, status: "pending", parentTaskId: CHILD_ID }),
			)
			await harness.assertRolledBack()
		},
	)

	it("commits a verified no-debt child without joining its own completion loop", async () => {
		const harness = await setup()
		vi.mocked(harness.child.waitForTermination).mockImplementation(async () => {
			throw new Error("Self-join attempted")
		})

		await harness.handoff()

		expect(harness.completionGate).toHaveBeenCalledOnce()
		expect(harness.remove).toHaveBeenCalledWith({
			taskId: CHILD_ID,
			skipDelegationRepair: true,
			requireAbortSuccess: true,
			ownedDelegationHandoff: true,
		})
		expect(harness.child.abortTask).toHaveBeenCalledOnce()
		expect(harness.child.waitForTermination).not.toHaveBeenCalled()
		expect(harness.provider.getLiveTask(CHILD_ID)).toBeUndefined()
		expect(harness.provider.getLiveTask(PARENT_ID)).toBe(harness.parent)
		expect(harness.parent.resumeAfterDelegation).toHaveBeenCalledOnce()
		expect(await harness.history(PARENT_ID)).toMatchObject({
			status: "active",
			completedByChildId: CHILD_ID,
			completionResultSummary: RESULT,
		})
		expect(await harness.history(CHILD_ID)).toMatchObject({ status: "completed" })
		const transcripts = await harness.parentTranscripts()
		expect(transcripts.ui.filter((message) => message.say === "subtask_result")).toHaveLength(1)
		expect(transcripts.api.at(-1)?.content).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "delegate-call",
				content: expect.stringContaining(RESULT),
			}),
		])
		expect(transcripts.sidecar.messages).toEqual(transcripts.api)
		expect(harness.buffers.size).toBe(0)
		expect(harness.child.messageQueueService.listenerCount("stateChanged")).toBe(0)
	})

	it("holds the workspace reservation from the final gate through child abort and removal", async () => {
		const harness = await setup()
		const gateEntered = deferred()
		const releaseGate = deferred()
		const abortEntered = deferred()
		const releaseAbort = deferred()
		const order: string[] = []
		harness.getDecision.mockImplementationOnce(async (task) => {
			order.push("gate")
			gateEntered.resolve()
			await releaseGate.promise
			return harness.ledger.getParentCompletionDecision(task.taskId, CHILD_ID)
		})
		vi.mocked(harness.child.abortTask).mockImplementationOnce(async () => {
			harness.child.abort = true
			order.push("abort")
			abortEntered.resolve()
			await releaseAbort.promise
			await harness.child.flushApiConversationHistoryPersistence()
			order.push("abort settled")
		})
		const operation = observe(harness.handoff())
		let competing: ReturnType<typeof observe> | undefined
		try {
			await reachBarrier(gateEntered.promise, operation)
			expect(harness.gate.runIfIdle(PARENT_ID, "gate probe", async () => undefined)).toBeUndefined()
			competing = observe(
				harness.provider.runWorkspaceMutation(harness.parent, "competing mutation", async () => {
					order.push("mutation")
					expect(harness.provider.getLiveTask(CHILD_ID)).toBeUndefined()
				}),
			)
			releaseGate.resolve()
			await reachBarrier(abortEntered.promise, operation)
			expect(order).toEqual(["gate", "abort"])
			expect(harness.buffers.get(CHILD_ID)?.phase).toBe("committing")
			expect(harness.provider.getLiveTask(CHILD_ID)).toBe(harness.child)
			expect(harness.gate.runIfIdle(PARENT_ID, "abort probe", async () => undefined)).toBeUndefined()
		} finally {
			releaseGate.resolve()
			releaseAbort.resolve()
			await operation
			await competing
		}
		expect(await operation).toEqual({ status: "fulfilled" })
		expect(await competing).toEqual({ status: "fulfilled" })
		expect(order).toEqual(["gate", "abort", "abort settled", "mutation"])
		await expect(harness.gate.runIfIdle(PARENT_ID, "released probe", async () => "released")).resolves.toBe(
			"released",
		)
	})

	it("rejects cancellation that arrives while the final gate is awaiting evidence", async () => {
		const harness = await setup()
		const entered = deferred()
		const release = deferred()
		harness.getDecision.mockImplementationOnce(async (task) => {
			entered.resolve()
			await release.promise
			return harness.ledger.getParentCompletionDecision(task.taskId, CHILD_ID)
		})
		const operation = observe(harness.handoff())
		try {
			await reachBarrier(entered.promise, operation)
			harness.child.abort = true
		} finally {
			release.resolve()
			await operation
		}
		expect(await operation).toMatchObject({
			status: "rejected",
			error: expect.objectContaining({
				message: expect.stringMatching(/cancel|interrupted|no longer verified/i),
			}),
		})
		await harness.assertRolledBack()
	})

	it("rejects a new handoff without a live child before staging the parent", async () => {
		const harness = await setup()
		harness.sessions.unregister(CHILD_ID)
		await expect(harness.handoff()).rejects.toThrow("without live child")
		expect(harness.createParent).not.toHaveBeenCalled()
		expect(harness.updateHistory).not.toHaveBeenCalled()
		expect(harness.remove).not.toHaveBeenCalled()
		expect(await harness.history(PARENT_ID)).toMatchObject({ status: "delegated", awaitingChildId: CHILD_ID })
	})

	it("allows a matching durable retry without accepting a second child completion", async () => {
		const harness = await setup()
		await harness.handoff()
		const committed = await harness.parentTranscripts()
		await harness.handoff()
		expect(harness.completionGate).toHaveBeenCalledOnce()
		expect(harness.child.abortTask).toHaveBeenCalledOnce()
		expect(harness.remove).toHaveBeenCalledOnce()
		const retried = await harness.parentTranscripts()
		expect(retried.ui).toEqual(committed.ui)
		expect(retried.api).toEqual(committed.api)
		expect(retried.sidecar.messages).toEqual(committed.sidecar.messages)
		expect(harness.parent.resumeAfterDelegation).toHaveBeenCalledTimes(2)
	})

	it("external confirmed removal still waits for the task termination boundary", async () => {
		const harness = await setup()
		const entered = deferred()
		const release = deferred()
		vi.mocked(harness.child.waitForTermination).mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const operation = observe(
			harness.provider.removeClineFromStack({
				taskId: CHILD_ID,
				skipDelegationRepair: true,
				requireAbortSuccess: true,
			}),
		)
		try {
			await reachBarrier(entered.promise, operation)
			expect(harness.child.abortTask).toHaveBeenCalledOnce()
			expect(harness.provider.getLiveTask(CHILD_ID)).toBe(harness.child)
		} finally {
			release.resolve()
			await operation
		}
		expect(await operation).toEqual({ status: "fulfilled" })
		expect(harness.child.waitForTermination).toHaveBeenCalledOnce()
		expect(harness.provider.getLiveTask(CHILD_ID)).toBeUndefined()
	})

	it.each(["missing buffer", "preparing buffer", "repair enabled", "managed worker"] as const)(
		"rejects spoofed owned removal: %s",
		async (scenario) => {
			const harness = await setup()
			if (scenario !== "missing buffer")
				harness.buffers.set(CHILD_ID, {
					phase: scenario === "preparing buffer" ? "preparing" : "committing",
					messages: [],
				})
			if (scenario === "managed worker")
				Object.assign(harness.child, { taskKind: "subagent", subagentRole: "worker" })
			await expect(
				harness.provider.removeClineFromStack({
					taskId: CHILD_ID,
					skipDelegationRepair: scenario !== "repair enabled",
					ownedDelegationHandoff: true,
				}),
			).rejects.toThrow("Only a committing")
			expect(harness.child.abortTask).not.toHaveBeenCalled()
			expect(harness.child.waitForTermination).not.toHaveBeenCalled()
			expect(harness.provider.getLiveTask(CHILD_ID)).toBe(harness.child)
		},
	)
})
