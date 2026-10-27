import type {
	AgentControlState,
	HistoryItem,
	SubagentGroupState,
	SubagentOrchestrationSettings,
} from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import type { Task } from "../../task/Task"
import { WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskRunner } from "../../agent/BoundedDelegationManager"
import { SubagentNicknameRegistry } from "../../agent/SubagentNicknameRegistry"

// Same real provider/ledger/run-manager boundary as the delegation durability audit.
// The runner is deterministic; child history deletion uses the public provider path.
const makeHarness = (settings: SubagentOrchestrationSettings = {}, storedState?: AgentControlState) => {
	const persistence = new InMemoryAgentControlPersistence(storedState)
	const store = new AgentControlStore(persistence)
	const ready = store.initialize()
	const history = new Map<string, HistoryItem>([
		["parent-1", { id: "parent-1", number: 1, ts: 1, task: "parent", tokensIn: 0, tokensOut: 0, totalCost: 0 }],
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
		apiConfiguration: { apiProvider: "openai", openAiModelId: "alpha-model" },
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
	const runner: InternalTaskRunner = async (envelope) => ({
		taskId: envelope.id,
		status: "completed",
		summary: "Inspection complete",
		evidence: [],
		changedFiles: [],
		verification: [],
		remainingRisks: [],
		usage: { durationMs: 1 },
	})
	const bounded = new BoundedDelegationManager(runner)
	const runs = new AsyncSubagentRunManager(bounded)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStoreLoadedAt: Date.now(),
		contextProxy: { getValues: () => settings },
		providerSettingsManager: {
			getProfile: vi.fn(async () => {
				throw new Error("Profile not found")
			}),
		},
		taskSessions: new TaskSessionRegistry(3),
		getSkillsManager: vi.fn(async () => undefined),
		taskHistoryStore: {
			get: (taskId: string) => history.get(taskId),
			getAll: () => [...history.values()],
			upsert: vi.fn(async (item: HistoryItem) => {
				history.set(item.id, structuredClone(item))
			}),
			delete: vi.fn(async (taskId: string) => {
				history.delete(taskId)
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
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postTaskSessionStateToWebview: vi.fn(async () => undefined),
		log: vi.fn(),
	}) as AlphaProvider
	return { provider, persistence, store, history, parent, parentAbort, runs, ready }
}

const reloadHarness = async (
	previous: ReturnType<typeof makeHarness>,
	settings: SubagentOrchestrationSettings = {},
) => {
	const reloaded = makeHarness(settings, await previous.persistence.read())
	await reloaded.ready
	for (const [id, item] of previous.history) reloaded.history.set(id, structuredClone(item))
	reloaded.parent.alphaMessages = structuredClone(previous.parent.alphaMessages)
	return reloaded
}

const completeChild = async (harness: ReturnType<typeof makeHarness>, tokens = 0, cost = 0) => {
	const prepared = await harness.provider.prepareSubagentGroup(harness.parent as unknown as Task, [
		{ objective: "Inspect the existing source", agent_kind: "review", fork_turns: "none" },
	])
	const handle = await harness.provider.launchPreparedSubagentGroup(
		harness.parent as unknown as Task,
		prepared,
		harness.parentAbort.signal,
	)
	await harness.runs.waitForResult(handle.taskId)
	await ownedFinalization(Reflect.get(harness.provider, "subagentRunFinalizations").get(handle.taskId))
	const record = harness.store.getAgent(handle.taskId)
	expect(record?.status).toBe("completed")
	const manifest = record?.snapshot?.contextManifest
	if (!manifest?.orchestration) throw new Error("Missing completed child orchestration")
	harness.history.set(handle.taskId, {
		id: handle.taskId,
		number: 2,
		ts: 2,
		task: "Completed inspection",
		tokensIn: tokens,
		tokensOut: 0,
		totalCost: cost,
		subagentContextManifest: manifest,
	})
	return { handle, manifest }
}

function ownedFinalization(entry: Promise<void> | { readonly promise: Promise<void> } | undefined) {
	return entry && ("promise" in entry ? entry.promise : entry)
}

describe("closed child history deletion preserves frozen root limits", () => {
	it.each([
		{ setting: { subagentRootTokenBudget: 50_000 }, stopReason: "root_token_budget" },
		{ setting: { subagentRootCostBudget: 5 }, stopReason: "root_cost_budget" },
	])(
		"does not revive $stopReason after deleting the final child's history and reloading",
		async ({ setting, stopReason }) => {
			const harness = makeHarness(setting)
			const prepared = await harness.provider.prepareSubagentGroup(harness.parent as unknown as Task, [
				{ objective: "Inspect the existing source", agent_kind: "review", fork_turns: "none" },
			])
			const handle = await harness.provider.launchPreparedSubagentGroup(
				harness.parent as unknown as Task,
				prepared,
				harness.parentAbort.signal,
			)
			await harness.runs.waitForResult(handle.taskId)
			await ownedFinalization(Reflect.get(harness.provider, "subagentRunFinalizations").get(handle.taskId))
			const record = harness.store.getAgent(handle.taskId)
			expect(record?.status).toBe("completed")
			harness.history.set(handle.taskId, {
				id: handle.taskId,
				number: 2,
				ts: 2,
				task: "Completed exactly at the root allowance",
				tokensIn: 50_000,
				tokensOut: 0,
				totalCost: 5,
				subagentContextManifest: record?.snapshot?.contextManifest,
			})
			await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)

			// Retained history preserves usage without imposing the retired allowance.
			const withHistory = await reloadHarness(harness)
			await expect(
				withHistory.provider.prepareSubagentGroup(withHistory.parent as unknown as Task, [
					{ objective: "Try with current default settings", agent_kind: "review" },
				]),
			).resolves.toMatchObject({
				envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
			})

			await harness.provider.deleteTaskFromState(handle.taskId)
			expect(harness.history.has(handle.taskId)).toBe(false)
			expect(harness.history.has(harness.parent.taskId)).toBe(true)
			expect(harness.store.listClosedAgents(harness.parent.taskId)).toEqual([
				expect.objectContaining({ taskId: handle.taskId, budgetUsage: { tokens: 50_000, cost: 5 } }),
			])
			for (const settings of [
				{},
				{ subagentRootTokenBudget: 100_000, subagentRootCostBudget: 10 },
				{ subagentRootTokenBudget: null, subagentRootCostBudget: null },
			]) {
				const withoutHistory = await reloadHarness(harness, settings)
				expect(withoutHistory.store.listAgents({ includeRoot: false })).toEqual([])
				await expect(
					withoutHistory.provider.prepareSubagentGroup(withoutHistory.parent as unknown as Task, [
						{ objective: "Try with relaxed settings", agent_kind: "review" },
					]),
				).resolves.toMatchObject({
					envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
				})
			}
		},
	)

	it("preserves null budgets, depth, concurrency, token ceilings and role timeouts after history deletion", async () => {
		const harness = makeHarness({
			maxConcurrentSubagents: 1,
			subagentMaxDepth: 3,
			subagentMaxInputTokens: 30_000,
			subagentMaxOutputTokens: 2_000,
			subagentRoleTimeoutsMs: { explore: 15_000, review: 20_000, worker: 30_000 },
			subagentRootTokenBudget: null,
			subagentRootCostBudget: null,
		})
		const { handle, manifest } = await completeChild(harness, 1_000, 2)
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		await harness.provider.deleteTaskFromState(handle.taskId)
		const reloaded = await reloadHarness(harness, {
			maxConcurrentSubagents: 5,
			subagentMaxDepth: 5,
			subagentMaxInputTokens: 100_000,
			subagentMaxOutputTokens: 8_000,
			subagentRoleTimeoutsMs: { explore: 100_000, review: 100_000, worker: 100_000 },
			subagentRootTokenBudget: 1,
			subagentRootCostBudget: 1,
		})
		Reflect.get(reloaded.provider, "taskSessions").setMaxLiveTasks(8)
		expect(reloaded.store.listClosedAgents(harness.parent.taskId)[0].orchestration).toEqual(manifest.orchestration)
		const prepared = await reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
			{ objective: "Explore after reload", agent_kind: "explore" },
		])
		const restored = Reflect.get(reloaded.provider, "subagentDescriptors").get(prepared.envelopes[0].id)
			.contextManifest.orchestration
		expect(restored.ancestry).toEqual(manifest.orchestration!.ancestry)
		expect(restored.limits).toEqual({ ...manifest.orchestration!.limits, timeoutMs: null })
	})

	it("retains the first root ceilings across several closed children and skips legacy empty tombstones", async () => {
		const settings: SubagentOrchestrationSettings = { subagentRootTokenBudget: 50_000, subagentRootCostBudget: 5 }
		const harness = makeHarness(settings)
		const first = await completeChild(harness, 20_000, 2)
		await harness.provider.closeAgent(harness.parent as unknown as Task, first.handle.taskId)
		await harness.provider.deleteTaskFromState(first.handle.taskId)
		settings.subagentRootTokenBudget = 100_000
		settings.subagentRootCostBudget = 10
		const second = await completeChild(harness, 30_000, 3)
		expect(second.manifest.orchestration!.limits).toEqual(first.manifest.orchestration!.limits)
		await harness.provider.closeAgent(harness.parent as unknown as Task, second.handle.taskId)
		await harness.provider.deleteTaskFromState(second.handle.taskId)
		const stored = await harness.persistence.read()
		if (!stored) throw new Error("Missing persisted control state")
		delete stored.tombstones[0].orchestration
		await harness.persistence.write(stored)
		const reloaded = await reloadHarness(harness)
		expect(reloaded.store.listClosedAgents(harness.parent.taskId)).toHaveLength(2)
		expect(
			Reflect.get(reloaded.provider, "getSubagentRootUsage").call(reloaded.provider, harness.parent.taskId),
		).toEqual({ tokens: 50_000, cost: 5 })
		await expect(
			reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
				{ objective: "Try after all child history is deleted", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
		})
	})

	it("keeps the retained-history fallback for old tombstones without orchestration", async () => {
		const harness = makeHarness({ subagentRootCostBudget: 5 })
		const { handle } = await completeChild(harness, 0, 5)
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		const stored = await harness.persistence.read()
		if (!stored) throw new Error("Missing persisted control state")
		delete stored.tombstones[0].orchestration
		await harness.persistence.write(stored)
		const reloaded = await reloadHarness(harness)
		await expect(
			reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
				{ objective: "Try from a legacy tombstone", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
		})
	})

	it("captures orchestration from retained history when a legacy control snapshot lacks it", async () => {
		const harness = makeHarness({ subagentRootCostBudget: 5 })
		const { handle, manifest } = await completeChild(harness, 0, 5)
		await harness.store.updateAgentSnapshot(handle.taskId, {})
		Reflect.get(harness.provider, "subagentDescriptors").clear()
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		expect(harness.store.listClosedAgents(harness.parent.taskId)[0].orchestration).toEqual(manifest.orchestration)
		await harness.provider.deleteTaskFromState(handle.taskId)
		const reloaded = await reloadHarness(harness)
		await expect(
			reloaded.provider.prepareSubagentGroup(reloaded.parent as unknown as Task, [
				{ objective: "Try after deleting legacy child history", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [expect.objectContaining({ budget: expect.objectContaining({ timeoutMs: null }) })],
		})
	})

	it("purges retained orchestration when the owning root itself is deleted", async () => {
		const harness = makeHarness({ subagentRootTokenBudget: 50_000, subagentRootCostBudget: 5 })
		const { handle } = await completeChild(harness, 50_000, 5)
		await harness.provider.closeAgent(harness.parent as unknown as Task, handle.taskId)
		await harness.provider.deleteTaskFromState(handle.taskId)
		await harness.provider.deleteTaskFromState(harness.parent.taskId)
		const reloaded = await reloadHarness(harness)
		expect(reloaded.store.listClosedAgents(harness.parent.taskId)).toEqual([])
		expect(reloaded.store.getAgent(harness.parent.taskId)).toBeUndefined()
		expect(
			Reflect.get(reloaded.provider, "findFrozenRootOrchestration").call(
				reloaded.provider,
				harness.parent.taskId,
			),
		).toBeUndefined()
	})
})
