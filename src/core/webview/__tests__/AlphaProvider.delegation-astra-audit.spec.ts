import type { AgentControlState, HistoryItem, ProviderSettings, SubagentGroupState } from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"
import { WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskRunner } from "../../agent/BoundedDelegationManager"
import { SubagentNicknameRegistry } from "../../agent/SubagentNicknameRegistry"

class FailingFollowupPersistence extends InMemoryAgentControlPersistence {
	failFollowupWrite = false
	failRollbackWrite = false

	override async write(state: AgentControlState): Promise<void> {
		if (
			this.failRollbackWrite &&
			state.agents.some((record) => record.status === "completed" && record.pendingFollowupEventId)
		) {
			this.failRollbackWrite = false
			throw new Error("Injected rollback storage failure")
		}
		if (this.failFollowupWrite && state.mailbox.some((entry) => entry.name === "followup_started")) {
			this.failFollowupWrite = false
			throw new Error("Injected follow-up mailbox storage failure")
		}
		await super.write(state)
	}
}

const makeHarness = (
	settings: { subagentRootTokenBudget?: number; subagentRootCostBudget?: number } = {},
	storedState?: AgentControlState,
) => {
	const persistence = new FailingFollowupPersistence(storedState)
	const store = new AgentControlStore(persistence)
	const ready = store.initialize()
	const sessions = new TaskSessionRegistry(3)
	const parentConfiguration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "alpha-model",
		openAiApiKey: "astra-audit-fixture-key",
		openAiBaseUrl: "https://astra-audit.example.invalid/v1",
	}
	const parentProfile = { id: "astra-parent-profile", name: "Parent", ...parentConfiguration }
	const history = new Map<string, HistoryItem>([
		[
			"parent-1",
			{
				id: "parent-1",
				number: 1,
				ts: 1,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				apiConfigName: parentProfile.name,
				threadModelRoute: {
					source: "parent",
					resolution: "selected",
					profileId: parentProfile.id,
					profileName: parentProfile.name,
					provider: parentConfiguration.apiProvider,
					modelId: parentConfiguration.openAiModelId,
				},
			},
		],
	])
	const parentAbort = new AbortController()
	const parent = {
		taskId: "parent-1",
		taskKind: "primary",
		metadata: { task: "parent" },
		alphaMessages: [] as Array<{ subagentGroup: SubagentGroupState }>,
		apiConversationHistory: [],
		cwd: "F:/workspace",
		historyWorkspacePath: "F:/workspace",
		apiConfiguration: structuredClone(parentConfiguration),
		getTaskMode: vi.fn(async () => "code"),
		getTaskApiConfigName: vi.fn(async () => "Parent"),
		captureEffectiveInheritedInstructions: vi.fn(async () => ({
			effectiveText: "Language Preference: English",
			sources: [{ kind: "aggregate", ref: "task:parent-1:instructions", text: "Language Preference: English" }],
		})),
		getTaskLifetimeCancellationSignal: () => parentAbort.signal,
		getSubagentFileWriteScope: () => [],
		admitAgentMessage: async (persist: () => Promise<unknown>) => persist(),
		emit: vi.fn(),
		say: vi.fn(async () => undefined),
		upsertSubagentGroup: vi.fn(async (group: SubagentGroupState) => {
			const old = parent.alphaMessages.findIndex((message) => message.subagentGroup.groupId === group.groupId)
			const message = { subagentGroup: structuredClone(group) }
			if (old < 0) parent.alphaMessages.push(message)
			else parent.alphaMessages[old] = message
		}),
	}
	const runner = vi.fn<InternalTaskRunner>(async (envelope) => ({
		taskId: envelope.id,
		status: "completed",
		summary: "Inspection complete",
		evidence: [],
		changedFiles: [],
		verification: [],
		remainingRisks: [],
		usage: { durationMs: 1 },
	}))
	const bounded = new BoundedDelegationManager(runner)
	const runs = new AsyncSubagentRunManager(bounded)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStoreLoadedAt: Date.now(),
		contextProxy: { getValues: () => settings },
		providerSettingsManager: {
			getProfile: vi.fn(async (selection: { id: string } | { name: string }) => {
				const matches =
					"id" in selection ? selection.id === parentProfile.id : selection.name === parentProfile.name
				if (!matches) throw new Error("Profile not found")
				return structuredClone(parentProfile)
			}),
			listConfig: vi.fn(async () => [{ id: parentProfile.id, name: parentProfile.name, apiProvider: "openai" }]),
		},
		taskSessions: sessions,
		getSkillsManager: vi.fn(async () => undefined),
		taskHistoryStore: {
			get: (taskId: string) => history.get(taskId),
			getAll: () => [...history.values()],
			upsert: vi.fn(async (item: HistoryItem) => {
				history.set(item.id, structuredClone(item))
			}),
		},
		subagentNicknameRegistry: new SubagentNicknameRegistry({ pickIndex: () => 0 }),
		preparedSubagentGroups: new Map(),
		subagentGroupControllers: new Map(),
		reservedSubagentSlots: new Map(),
		exhaustedSubagentRootBudgets: new Map(),
		publishedSubagentResults: new Set(),
		subagentDescriptors: new Map(),
		agentControlStore: store,
		agentControlStoreReady: ready,
		agentControlRootStatusWrites: new Map(),
		taskLifecycleHistoryWrites: new Map(),
		agentFollowupAdmissions: new Map(),
		subagentRunFinalizations: new Map(),
		subagentResidencyEvictions: new Map(),
		agentLifecycleJournals: new Map(),
		agentLifecycleProjector: { clear: vi.fn() },
		agentLifecycleDegradedSignals: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		taskEventListeners: new Map(),
		taskStack: [],
		pendingManagedTaskCompletions: new Map(),
		workspaceMutationGate: new WorkspaceMutationGate(),
		boundedDelegationManager: bounded,
		asyncSubagentRunManager: runs,
		getTaskWithId: vi.fn(async (taskId: string) => ({ historyItem: history.get(taskId) })),
		updateTaskHistory: vi.fn(async (item: HistoryItem) => {
			history.set(item.id, structuredClone(item))
		}),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postTaskSessionStateToWebview: vi.fn(async () => undefined),
		log: vi.fn(),
	}) as AlphaProvider
	const launch = async () => {
		const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
			{ objective: "Inspect the existing source", agent_kind: "review", fork_turns: "none" },
		])
		const handle = await provider.launchPreparedSubagentGroup(
			parent as unknown as Task,
			prepared,
			parentAbort.signal,
		)
		await runs.waitForResult(handle.taskId)
		await ownedFinalization(Reflect.get(provider, "subagentRunFinalizations").get(handle.taskId))
		const record = store.getAgent(handle.taskId, parent.taskId)
		expect(record?.status).toBe("completed")
		expect(record?.snapshot?.contextManifest?.modelRoute).toMatchObject({
			profileId: parentProfile.id,
			profileName: parentProfile.name,
			provider: "openai",
			modelId: "alpha-model",
		})
		expect(record?.snapshot?.contextManifest?.modelRoute?.unboundProfile).toBeUndefined()
		return { prepared, handle }
	}
	return { provider, persistence, store, sessions, history, parent, parentAbort, runner, runs, launch, ready }
}

const reloadHarness = async (previous: ReturnType<typeof makeHarness>) => {
	const reloaded = makeHarness({}, await previous.persistence.read())
	await reloaded.ready
	for (const [id, item] of previous.history) reloaded.history.set(id, structuredClone(item))
	reloaded.parent.alphaMessages = structuredClone(previous.parent.alphaMessages)
	return reloaded
}

const rootUsage = ({ provider, parent }: ReturnType<typeof makeHarness>) =>
	Reflect.get(provider, "getSubagentRootUsage").call(provider, parent.taskId)

const settleRun = async ({ provider, runs }: ReturnType<typeof makeHarness>, taskId: string) => {
	await runs.waitForResult(taskId)
	await ownedFinalization(Reflect.get(provider, "subagentRunFinalizations").get(taskId))
}

function ownedFinalization(entry: Promise<void> | { readonly promise: Promise<void> } | undefined) {
	return entry && ("promise" in entry ? entry.promise : entry)
}

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("managed spawn request admission", () => {
	it.each(["mode", "history"] as const)("cancels an interrupted request during %s preparation", async (stage) => {
		const { provider, parent, parentAbort, runner, store, sessions, ready } = makeHarness()
		await ready
		const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
			{ objective: "Inspect source", agent_kind: "review", fork_turns: "none" },
		])
		const entered = deferred()
		const held = deferred()
		const request = new AbortController()
		const reason = new Error("Invoking step was interrupted")
		let restore: (() => void) | undefined
		if (stage === "mode") {
			parent.getTaskMode.mockImplementationOnce(async () => {
				entered.resolve()
				await held.promise
				return "code"
			})
		} else {
			const update = provider.updateTaskHistory.bind(provider)
			const spy = vi.spyOn(provider, "updateTaskHistory").mockImplementationOnce(async (item) => {
				entered.resolve()
				await held.promise
				return update(item)
			})
			restore = () => spy.mockRestore()
		}
		const operation = provider.launchPreparedSubagentGroup(
			parent as unknown as Task,
			prepared,
			parentAbort.signal,
			request.signal,
		)
		const rejected = expect(operation).rejects.toBe(reason)
		try {
			await entered.promise
			request.abort(reason)
			held.resolve()
			await rejected
			expect(runner).not.toHaveBeenCalled()
			expect(parentAbort.signal.aborted).toBe(false)
			expect(sessions.getReservedTaskSlots(parent.taskId, () => false)).toEqual({ total: 0, root: 0 })
			const record = store.getAgent(prepared.envelopes[0].id, parent.taskId)
			if (stage === "history") expect(record?.status).toBe("cancelled")
			else expect(record).toBeUndefined()
			await ownedFinalization(Reflect.get(provider, "subagentRunFinalizations").get(prepared.envelopes[0].id))
		} finally {
			held.resolve()
			await operation.catch(() => undefined)
			restore?.()
			await store.shutdown()
		}
	})

	it("keeps an accepted child alive after its spawning request ends and retains parent cancellation", async () => {
		const harness = makeHarness()
		const { provider, parent, parentAbort, runner, store, runs, ready } = harness
		await ready
		const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
			{ objective: "Inspect source", agent_kind: "review", fork_turns: "none" },
		])
		const entered = deferred<AbortSignal>()
		const held = deferred()
		const complete = runner.getMockImplementation()!
		runner.mockImplementationOnce(async (envelope, signal) => {
			entered.resolve(signal)
			await held.promise
			return complete(envelope, signal)
		})
		const request = new AbortController()
		const handle = await provider.launchPreparedSubagentGroup(
			parent as unknown as Task,
			prepared,
			parentAbort.signal,
			request.signal,
		)
		try {
			const childSignal = await entered.promise
			request.abort(new Error("Spawning request finished"))
			expect(childSignal.aborted).toBe(false)
			parentAbort.abort(new Error("Parent task stopped"))
			expect(childSignal.aborted).toBe(true)
		} finally {
			held.resolve()
			await runs.waitForResult(handle.taskId)
			await settleRun(harness, handle.taskId)
			await store.shutdown()
		}
	})
})

describe("Astra delegation durability audit", () => {
	it.each([
		{ setting: { subagentRootTokenBudget: 50_000 }, stopReason: "root_token_budget" },
		{ setting: { subagentRootCostBudget: 5 }, stopReason: "root_cost_budget" },
	])("keeps closed child spend in $stopReason admission", async ({ setting, stopReason }) => {
		const harness = makeHarness(setting)
		const { provider, store, history, parent, launch } = harness
		const first = await launch()
		const record = store.getAgent(first.handle.taskId, parent.taskId)
		if (!record || !record.snapshot) throw new Error("Missing completed child snapshot")
		const manifest = record.snapshot.contextManifest
		if (!manifest || !manifest.orchestration) throw new Error("Missing completed child orchestration")
		history.set(first.handle.taskId, {
			id: first.handle.taskId,
			number: 2,
			ts: 2,
			task: "First completed inspection",
			tokensIn: 40_000,
			tokensOut: 0,
			totalCost: 4,
			subagentContextManifest: manifest,
		})
		expect(Reflect.get(provider, "getSubagentRootUsage").call(provider, parent.taskId)).toEqual({
			tokens: 40_000,
			cost: 4,
		})
		await provider.closeAgent(parent as unknown as Task, first.handle.taskId)
		expect(
			store.resolveTarget(first.handle.taskId, { rootTaskId: parent.taskId, includeClosed: true }),
		).toMatchObject({ closed: true })
		expect(history.get(first.handle.taskId)?.tokensIn).toBe(40_000)

		const second = await launch()
		history.set(second.handle.taskId, {
			id: second.handle.taskId,
			number: 3,
			ts: 3,
			task: "Second completed inspection",
			tokensIn: 10_000,
			tokensOut: 0,
			totalCost: 1,
			subagentContextManifest: manifest,
		})
		// All spend remains in task history; close must only release live capacity.
		expect
			.soft(Reflect.get(provider, "getSubagentRootUsage").call(provider, parent.taskId))
			.toEqual({ tokens: 50_000, cost: 5 })
		await expect(
			provider.prepareSubagentGroup(parent as unknown as Task, [
				{ objective: "Inspect another file", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
		})
	})

	it.each(["mailbox", "parent transcript", "rollback"])(
		"retries a follow-up after a %s persistence failure",
		async (failurePoint) => {
			const { provider, persistence, store, parent, runner, runs, launch } = makeHarness()
			const { handle, prepared } = await launch()
			const previousRecord = store.getAgent(handle.taskId, parent.taskId)
			const previousGroup = structuredClone(prepared.group)
			expect(runner).toHaveBeenCalledOnce()
			if (failurePoint === "mailbox") persistence.failFollowupWrite = true
			else
				parent.upsertSubagentGroup.mockRejectedValueOnce(
					new Error("Injected follow-up transcript storage failure"),
				)
			if (failurePoint === "rollback") persistence.failRollbackWrite = true
			await expect(
				provider.followupAgentTask(parent as unknown as Task, handle.taskId, "Inspect the next case"),
			).rejects.toThrow("Injected follow-up")
			const durableState = await persistence.read()
			expect(durableState?.agents.find((record) => record.taskId === parent.taskId)).toMatchObject({
				status: "running",
			})
			expect
				.soft(durableState?.agents.find((record) => record.taskId === handle.taskId))
				.toMatchObject({ status: "completed" })
			expect(runs.getSnapshot(handle.taskId)?.status).toBe("completed")
			expect(store.getAgent(handle.taskId)?.snapshot).toEqual(previousRecord?.snapshot)
			expect(store.getAgent(handle.taskId)?.terminalResult).toEqual(previousRecord?.terminalResult)
			expect(prepared.group).toEqual(previousGroup)
			expect(Reflect.get(provider, "reservedSubagentSlots").size).toBe(0)
			expect(Reflect.get(provider, "subagentGroupControllers").size).toBe(0)
			expect(runner).toHaveBeenCalledOnce()
			const retried = await provider.followupAgentTask(
				parent as unknown as Task,
				handle.taskId,
				"Inspect the next case",
			)
			await runs.waitForResult(handle.taskId)
			await ownedFinalization(Reflect.get(provider, "subagentRunFinalizations").get(handle.taskId))
			expect.soft(retried).toHaveProperty("runId")
			expect.soft(runner).toHaveBeenCalledTimes(2)
			expect(store.getAgent(handle.taskId, parent.taskId)?.status).toBe("completed")
			expect(store.getAgent(handle.taskId)?.pendingFollowupEventId).toBeUndefined()
			expect(store.getSnapshot().mailbox.filter((entry) => entry.name === "followup_started")).toHaveLength(1)
		},
	)

	it("retains closed usage after reload even when the task history is unavailable", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		harness.history.set(handle.taskId, {
			id: handle.taskId,
			number: 2,
			ts: 2,
			task: "Completed",
			tokensIn: 30_000,
			tokensOut: 10_000,
			totalCost: 4,
		})
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		harness.history.delete(handle.taskId)
		const reloaded = await reloadHarness(harness)
		expect(reloaded.store.listAgents({ includeRoot: false })).toEqual([])
		expect(rootUsage(reloaded)).toEqual({ tokens: 40_000, cost: 4 })
	})

	it.each([
		{ setting: { subagentRootTokenBudget: 50_000 }, stopReason: "root_token_budget" },
		{ setting: { subagentRootCostBudget: 5 }, stopReason: "root_cost_budget" },
	])("retires $stopReason after every child closes", async ({ setting, stopReason }) => {
		const harness = makeHarness(setting)
		const { handle } = await harness.launch()
		harness.history.set(handle.taskId, {
			id: handle.taskId,
			number: 2,
			ts: 2,
			task: "Completed",
			tokensIn: 50_000,
			tokensOut: 0,
			totalCost: 5,
			subagentContextManifest: harness.store.getAgent(handle.taskId)?.snapshot?.contextManifest,
		})
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		const reloaded = await reloadHarness(harness)
		expect(reloaded.store.listAgents({ includeRoot: false })).toEqual([])
		await expect(
			reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
				{ objective: "Try with default settings after reload", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
		})
	})

	it("reads legacy tombstones using retained history without including another root", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		harness.history.set(handle.taskId, {
			id: handle.taskId,
			number: 2,
			ts: 2,
			task: "Legacy completed",
			tokensIn: 3_000,
			tokensOut: 1_000,
			totalCost: 0.4,
		})
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		const state = await harness.persistence.read()
		if (!state) throw new Error("Missing persisted control state")
		delete state.tombstones[0].budgetUsage
		state.tombstones.push({
			...state.tombstones[0],
			taskId: "foreign",
			rootTaskId: "other-root",
			budgetUsage: { tokens: 1_000_000, cost: 100 },
		})
		await harness.persistence.write(state)
		expect(rootUsage(await reloadHarness(harness))).toEqual({ tokens: 4_000, cost: 0.4 })
	})

	it.each(["root_token_budget", "root_cost_budget"] as const)(
		"preserves historical %s without blocking new launches after reload",
		async (stopReason) => {
			const harness = makeHarness()
			const { handle } = await harness.launch()
			await harness.store.updateAgentStatus(handle.taskId, "completed", {
				terminalResult: { status: "completed", completedAt: 2_000, stopReason },
			})
			await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
			const reloaded = await reloadHarness(harness)
			await expect(
				reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
					{ objective: "Try after reload", agent_kind: "review" },
				]),
			).resolves.toMatchObject({
				envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
			})
		},
	)

	it("uses maximum live, history and retained evidence once while close cleanup is pending", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		await harness.store.updateAgentStatus(handle.taskId, "completed", {
			snapshot: { usage: { inputTokens: 3_500, outputTokens: 500, cost: 4 } },
			terminalResult: {
				status: "completed",
				completedAt: 2_000,
				usage: { inputTokens: 2_000, outputTokens: 1_000, cost: 3, durationMs: 1 },
			},
		})
		harness.history.set(handle.taskId, {
			id: handle.taskId,
			number: 2,
			ts: 2,
			task: "Completed",
			tokensIn: 5_000,
			tokensOut: 1_000,
			totalCost: 5,
		})
		harness.sessions.register({
			taskId: handle.taskId,
			taskKind: "subagent",
			rootTaskId: harness.parent.taskId,
			alphaMessages: [],
			getTokenUsage: () => ({ totalTokensIn: 5_000, totalTokensOut: 3_000, totalCost: 2, contextTokens: 0 }),
		} as unknown as Task)
		let entered!: () => void
		let release!: () => void
		const cleaning = new Promise<void>((resolve) => {
			entered = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		Reflect.set(
			harness.provider,
			"removeTaskFromStack",
			vi.fn(async () => {
				entered()
				await barrier
				harness.sessions.unregister(handle.taskId)
			}),
		)
		expect(rootUsage(harness)).toEqual({ tokens: 8_000, cost: 5 })
		const closing = harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		try {
			await cleaning
			expect(rootUsage(harness)).toEqual({ tokens: 8_000, cost: 5 })
			harness.history.delete(handle.taskId)
		} finally {
			release()
		}
		await closing
		expect(rootUsage(harness)).toEqual({ tokens: 8_000, cost: 5 })
		expect(rootUsage(await reloadHarness(harness))).toEqual({ tokens: 8_000, cost: 5 })
	})

	it("counts cumulative follow-up usage once after close and reload", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		for (const tokens of [1_000, 2_000, 3_000]) {
			harness.history.set(handle.taskId, {
				id: handle.taskId,
				number: 2,
				ts: 2,
				task: "Completed",
				tokensIn: tokens,
				tokensOut: 0,
				totalCost: tokens / 1_000,
			})
			expect(rootUsage(harness)).toEqual({ tokens, cost: tokens / 1_000 })
			await harness.provider.followupAgentTask(harness.parent as unknown as Task, handle.taskId, "Inspect again")
			await settleRun(harness, handle.taskId)
			expect(rootUsage(harness)).toEqual({ tokens, cost: tokens / 1_000 })
		}
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		expect(rootUsage(await reloadHarness(harness))).toEqual({ tokens: 3_000, cost: 3 })
	})

	it("reuses the authoritative follow-up after parent publication failure and reload", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		harness.parent.upsertSubagentGroup.mockRejectedValueOnce(new Error("Parent publication failed"))
		await expect(
			harness.provider.followupAgentTask(
				harness.parent as unknown as Task,
				handle.taskId,
				"Retained instruction",
			),
		).rejects.toThrow("Parent publication failed")
		const receiptId = harness.store.getAgent(handle.taskId)?.pendingFollowupEventId
		expect(receiptId).toBeTruthy()
		const reloaded = await reloadHarness(harness)
		await reloaded.provider.followupAgentTask(
			reloaded.parent as unknown as Task,
			handle.taskId,
			"Retained instruction",
		)
		await settleRun(reloaded, handle.taskId)
		expect(reloaded.runner).toHaveBeenCalledOnce()
		expect(reloaded.store.getAgent(handle.taskId)?.status).toBe("completed")
		expect(reloaded.store.getSnapshot().mailbox.filter((entry) => entry.name === "followup_started")).toMatchObject(
			[{ eventId: receiptId, payload: { message: "Retained instruction" } }],
		)
	})

	it("rejects changed retry text without replacing a committed instruction", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		harness.parent.upsertSubagentGroup.mockRejectedValueOnce(new Error("Parent publication failed"))
		await expect(
			harness.provider.followupAgentTask(
				harness.parent as unknown as Task,
				handle.taskId,
				"Original instruction",
			),
		).rejects.toThrow("Parent publication failed")
		await expect(
			harness.provider.followupAgentTask(
				harness.parent as unknown as Task,
				handle.taskId,
				"Replacement instruction",
			),
		).rejects.toThrow("different content")
		expect(harness.store.getAgent(handle.taskId)?.status).toBe("completed")
		expect(harness.store.getSnapshot().mailbox.filter((entry) => entry.name === "followup_started")).toMatchObject([
			{ payload: { message: "Original instruction" } },
		])
		await harness.provider.followupAgentTask(
			harness.parent as unknown as Task,
			handle.taskId,
			"Original instruction",
		)
		await settleRun(harness, handle.taskId)
		expect(harness.runner).toHaveBeenCalledTimes(2)
	})

	it("restores terminal state when cancellation wins during follow-up publication", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		const previous = harness.store.getAgent(handle.taskId)
		harness.parent.upsertSubagentGroup.mockImplementationOnce(async () => {
			harness.parentAbort.abort()
		})
		await expect(
			harness.provider.followupAgentTask(
				harness.parent as unknown as Task,
				handle.taskId,
				"Cancel before launch",
			),
		).rejects.toThrow("cancelled before launch")
		expect(harness.store.getAgent(handle.taskId)).toEqual({
			...previous,
			pendingFollowupEventId: expect.any(String),
		})
		expect(harness.runner).toHaveBeenCalledOnce()
		const reloaded = await reloadHarness(harness)
		await reloaded.provider.followupAgentTask(
			reloaded.parent as unknown as Task,
			handle.taskId,
			"Cancel before launch",
		)
		await settleRun(reloaded, handle.taskId)
		expect(reloaded.runner).toHaveBeenCalledOnce()
		expect(reloaded.store.getSnapshot().mailbox.filter((entry) => entry.name === "followup_started")).toHaveLength(
			1,
		)
	})

	it("restores a prelaunch history failure but never rolls back an already launched generation", async () => {
		const harness = makeHarness()
		const { handle } = await harness.launch()
		const previous = harness.store.getAgent(handle.taskId)
		// Fail the required transcript write before the native launch binding exists.
		harness.parent.upsertSubagentGroup.mockImplementationOnce(async (group) => {
			expect(group.status).toBe("pending")
			expect(harness.runner).toHaveBeenCalledOnce()
			throw new Error("Prelaunch history failed")
		})
		await expect(
			harness.provider.followupAgentTask(harness.parent as unknown as Task, handle.taskId, "Try the next run"),
		).rejects.toThrow("Prelaunch history failed")
		expect(harness.store.getAgent(handle.taskId)).toEqual({
			...previous,
			pendingFollowupEventId: expect.any(String),
		})
		expect(harness.runner).toHaveBeenCalledOnce()
		expect(harness.runs.getRunId(handle.taskId)).toBe(handle.runId)
		const original = Reflect.get(harness.provider, "startPreparedSubagentRun")
		Reflect.set(harness.provider, "startPreparedSubagentRun", async (...args: unknown[]) => {
			await original.apply(harness.provider, args)
			throw new Error("Failure after launch")
		})
		await expect(
			harness.provider.followupAgentTask(harness.parent as unknown as Task, handle.taskId, "Try the next run"),
		).rejects.toThrow("Failure after launch")
		await settleRun(harness, handle.taskId)
		expect(harness.runner).toHaveBeenCalledTimes(2)
		expect(harness.store.getAgent(handle.taskId)?.pendingFollowupEventId).toBeUndefined()
		expect(harness.runs.resolveRunTaskId(handle.runId)).toBeUndefined()
		expect(harness.store.getSnapshot().mailbox.filter((entry) => entry.name === "followup_started")).toHaveLength(1)
	})
})
