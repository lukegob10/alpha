import { describe, expect, it, vi } from "vitest"

import {
	agentLifecycleSnapshotSchema,
	type AgentLifecycleStatus,
	type AgentRecord,
	type SubagentGroupState,
	TaskLifecycleState,
} from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import { buildInternalTaskEnvelope, type InternalTaskEnvelope } from "../../agent/InternalTaskEnvelope"
import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"

const inactiveStatuses = [
	"cancelling",
	"completed",
	"blocked",
	"failed",
	"cancelled",
	"timed_out",
	"interrupted",
] as const

const asTask = (taskId: string, rootTaskId = "root", taskKind: Task["taskKind"] = "primary"): Task =>
	({ taskId, rootTaskId, taskKind, alphaMessages: [], apiConversationHistory: [] }) as unknown as Task

const createHarness = async () => {
	let tick = 1_000
	const store = new AgentControlStore(new InMemoryAgentControlPersistence(), () => ++tick)
	await store.initialize()
	await store.ensureRoot({ taskId: "root", status: "running", objective: "sensitive-root-objective" })
	const asyncInterrupt = vi.fn(() => false)
	const boundedInterrupt = vi.fn(() => false)
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStore: store,
		agentControlStoreReady: Promise.resolve(),
		agentControlRootStatusWrites: new Map(),
		taskSessions: new TaskSessionRegistry(),
		recordParentVerificationEvidence: vi.fn(async () => undefined),
		getRootOrchestrationSummary: () => ({}),
		asyncSubagentRunManager: {
			resolveRunTaskId: () => undefined,
			interrupt: asyncInterrupt,
			cancel: vi.fn(() => false),
			getSnapshot: () => undefined,
			getEvents: () => [],
		},
		boundedDelegationManager: { interrupt: boundedInterrupt, cancel: vi.fn(() => false) },
		subagentRunFinalizations: new Map(),
		subagentDescriptors: new Map(),
		pendingManagedTaskCompletions: new Map(),
		getLiveTask: () => undefined,
	}) as AlphaProvider
	const createChild = async (taskId: string, status: AgentLifecycleStatus = "running", parentTaskId = "root") =>
		store.createAgent({
			taskId,
			parentTaskId,
			nickname: taskId,
			role: "review",
			objective: `sensitive-objective-${taskId}`,
			status,
			snapshot: {
				summary: `sensitive-report-${taskId}`,
				modelRouteId: `sensitive-profile-${taskId}`,
				metadata: { privateToken: `sensitive-token-${taskId}` },
			},
		})
	return { provider, store, createChild, root: asTask("root"), asyncInterrupt, boundedInterrupt }
}

const listPaths = (result: unknown): string[] => {
	const listing = result as { agents: Array<{ path: string }> }
	return listing.agents.map(({ path }) => path).sort()
}

const residencyEnvelope = (id: string) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "root",
		rootTaskId: "root",
		depth: 1,
		budget: { maxDepth: 1 },
		objective: `Inspect ${id}`,
		agentKind: "review",
		parentPolicy: {
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: true,
		},
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
	})

const createResidencyHarness = async () => {
	const harness = await createHarness()
	const { provider, store, root } = harness
	const sessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
	const manager = new AsyncSubagentRunManager(async (item) => ({
		taskId: item.id,
		status: "completed",
		summary: `${item.id} done`,
		evidence: [],
		changedFiles: [],
		verification: [],
		remainingRisks: [],
		usage: { inputTokens: 2, outputTokens: 3, cost: 0.01, durationMs: 1 },
	}))
	const prepared = new Map<string, { group: SubagentGroupState; envelopes: InternalTaskEnvelope[] }>()
	const descriptors = new Map<string, { groupId: string; parent: Task; runtimeCleanupFailed?: boolean }>()
	const publicationKeys = new Set<string>()
	Object.assign(provider, {
		preparedSubagentGroups: prepared,
		subagentDescriptors: descriptors,
		publishedSubagentResults: publicationKeys,
		asyncSubagentRunManager: manager,
		agentFollowupAdmissions: new Map(),
		subagentResidencyEvictions: new Map(),
		subagentNicknameRegistry: { release: vi.fn() },
		subagentGroupControllers: new Map(),
		reservedSubagentSlots: new Map(),
		agentLifecycleJournals: new Map(),
		agentLifecycleProjector: { clear: vi.fn() },
		agentLifecycleDegradedSignals: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		taskEventListeners: new Map(),
		taskStack: [root],
		getHostProviders: () => [provider],
		getLiveTask: (taskId: string) => sessions.getTask(taskId),
		releaseScopedSkillsManager: vi.fn(async () => undefined),
		postTaskSessionStateToWebview: vi.fn(async () => undefined),
		assertPlanAgentAdvanceAllowed: vi.fn(async () => undefined),
		log: vi.fn(),
	})
	const prune = () => (Reflect.get(provider, "pruneRetainedSubagentRuntimes") as () => Promise<void>).call(provider)
	const unload = (candidate: { taskId: string; task?: Task; runId?: string }) =>
		(Reflect.get(provider, "unloadRetainedSubagentRuntime") as (input: typeof candidate) => Promise<boolean>).call(
			provider,
			candidate,
		)
	let sequence = 0
	const addStopped = async (taskId: string, beforeStop?: (record: AgentRecord, child: Task) => Promise<void>) => {
		const groupId = `group-${taskId}`
		const record = await store.createAgent({
			taskId,
			parentTaskId: "root",
			nickname: taskId,
			role: "review",
			objective: taskId,
			groupId,
			status: "running",
		})
		const item = residencyEnvelope(taskId)
		const finalizationBinding = Reflect.get(provider, "trackSubagentFinalization").call(
			provider,
			[taskId],
			root,
			new AbortController().signal,
		)
		const handle = manager.launch(item, { groupId, path: record.path, nickname: taskId, role: "review" })
		finalizationBinding.bindAsyncRun()
		const result = await manager.waitForResult(taskId)
		expect(result).toBeDefined()
		const child = Object.assign(asTask(taskId, "root", "subagent"), {
			canUnloadSubagentRuntime: () => true,
			unloadSubagentRuntime: vi.fn(async () => undefined),
		})
		sessions.register(child, { focus: false })
		sessions.markLifecycle(taskId, TaskLifecycleState.Completed)
		sessions.markLifecycleSnapshot(
			taskId,
			agentLifecycleSnapshotSchema.parse({
				version: 1,
				taskId,
				runId: handle.runId,
				turnId: `${taskId}-turn`,
				status: "completed",
				phase: "finalizing",
				lastSequence: 0,
				terminalEventId: `${taskId}-terminal`,
				items: [{ itemId: `${taskId}-text`, type: "assistant_text", text: "Durable fixture transcript" }],
				steps: [],
				acceptedToolCallIds: [],
				terminalToolCallIds: [],
				processedEvents: [],
			}),
		)
		const group: SubagentGroupState = {
			groupId,
			parentTaskId: "root",
			executionMode: "async",
			status: "completed",
			createdAt: ++sequence,
			completedAt: sequence,
			agents: [manager.getSnapshot(taskId)!],
		}
		prepared.set(groupId, { group, envelopes: [item] })
		descriptors.set(taskId, { groupId, parent: root })
		publicationKeys.add(`${groupId}:${taskId}`)
		await beforeStop?.(record, child)
		const finalization = (async () => {
			await store.updateAgentStatusAndAppendEvent(
				taskId,
				"completed",
				{
					snapshot: { usage: { ...result!.usage }, metadata: { frozenAuthorityMarker: "preserve" } },
					terminalResult: {
						status: "completed",
						summary: result!.summary,
						completedAt: sequence,
						usage: result!.usage,
					},
				},
				{
					rootTaskId: "root",
					sender: taskId,
					recipient: "root",
					kind: "result",
					name: "agent_completed",
					payload: { taskId, summary: result!.summary },
				},
				"root",
			)
			root.alphaMessages.push({
				ts: sequence,
				type: "say",
				say: "subagent_group",
				subagentGroup: structuredClone(group),
			})
			Reflect.get(provider, "retainCompletedSubagentGroup").call(provider, groupId)
		})()
		finalizationBinding.settle(finalization)
		await finalizationBinding.promise
		await Reflect.get(provider, "subagentResidencyPrune")
		return { child, record, group, runId: handle.runId }
	}
	return { ...harness, sessions, manager, prepared, descriptors, publicationKeys, addStopped, prune, unload }
}

describe("managed-agent stop races", () => {
	it.each(inactiveStatuses)("treats interrupt of a retained %s child as a successful no-op", async (status) => {
		const { provider, createChild, root, asyncInterrupt, boundedInterrupt, store } = await createHarness()
		const child = await createChild("child", status)

		await expect(provider.interruptAgent(root, child.path)).resolves.toEqual({ previous_status: status })
		await expect(provider.interruptAgent(root, child.taskId)).resolves.toEqual({ previous_status: status })

		expect(asyncInterrupt).not.toHaveBeenCalled()
		expect(boundedInterrupt).not.toHaveBeenCalled()
		expect(store.getUnacknowledgedMailboxEntries(child.taskId, { kinds: ["control"] })).toEqual([])
		expect(store.getAgent(child.taskId, "root")?.status).toBe(status)
	})

	it("accepts completion that wins after target resolution and preserves the observed previous status", async () => {
		const { provider, createChild, root, store, asyncInterrupt, boundedInterrupt } = await createHarness()
		const child = await createChild("racing-child")
		const resolveTarget = Reflect.get(provider, "requireControlledAgent") as (
			parent: Task,
			target: string,
		) => Promise<AgentRecord>
		Reflect.set(provider, "requireControlledAgent", async (parent: Task, target: string) => {
			const observed = await resolveTarget.call(provider, parent, target)
			await store.updateAgentStatus(child.taskId, "completed", {}, "root")
			return observed
		})

		await expect(provider.interruptAgent(root, child.path)).resolves.toEqual({ previous_status: "running" })

		expect(asyncInterrupt).toHaveBeenCalledOnce()
		expect(boundedInterrupt).toHaveBeenCalledOnce()
		expect(store.getAgent(child.taskId, "root")?.status).toBe("completed")
		expect(store.getUnacknowledgedMailboxEntries(child.taskId, { kinds: ["control"] })).toEqual([])
	})

	it("does not hide a missing live owner while authoritative state is still running", async () => {
		const { provider, createChild, root } = await createHarness()
		const child = await createChild("missing-owner")

		await expect(provider.interruptAgent(root, child.path)).rejects.toThrow("no longer has an active turn")
	})

	it("publishes only one control request across an active interruption and its repeat", async () => {
		const { provider, createChild, root, store, asyncInterrupt, boundedInterrupt } = await createHarness()
		const child = await createChild("interrupted-once")
		asyncInterrupt.mockReturnValue(true)

		await expect(provider.interruptAgent(root, child.path)).resolves.toEqual({ previous_status: "running" })
		await store.updateAgentStatus(child.taskId, "cancelling", {}, "root")
		await expect(provider.interruptAgent(root, child.path)).resolves.toEqual({ previous_status: "cancelling" })

		expect(asyncInterrupt).toHaveBeenCalledOnce()
		expect(boundedInterrupt).not.toHaveBeenCalled()
		expect(store.getUnacknowledgedMailboxEntries(child.taskId, { kinds: ["control"] })).toHaveLength(1)
	})

	it.each(inactiveStatuses)("treats cancel of a retained %s child as a successful no-op", async (status) => {
		const { provider, createChild, root, store } = await createHarness()
		const child = await createChild("cancelled-child", status)
		const cancelSubtree = vi.fn()
		Reflect.set(provider, "cancelManagedAgentSubtree", cancelSubtree)

		await expect(provider.cancelAgent(root, child.path)).resolves.toMatchObject({
			taskId: child.taskId,
			path: child.path,
			status,
		})
		await expect(provider.cancelAgent(root, child.taskId)).resolves.toMatchObject({ status })

		expect(cancelSubtree).not.toHaveBeenCalled()
		expect(store.getAgent(child.taskId, "root")?.status).toBe(status)
		expect(store.getUnacknowledgedMailboxEntries(child.taskId, { kinds: ["control"] })).toEqual([])
	})

	it("accepts completion that wins before subtree cancellation without fabricating cancellation", async () => {
		const { provider, createChild, root, store } = await createHarness()
		const child = await createChild("cancel-race")
		Reflect.set(provider, "cancelManagedAgentSubtree", async () => {
			await store.updateAgentStatus(child.taskId, "completed", {}, "root")
			return { targetCancelled: false, descendantTaskIds: [] }
		})

		await expect(provider.cancelAgent(root, child.path)).resolves.toMatchObject({
			taskId: child.taskId,
			status: "completed",
		})
		expect(store.getAgent(child.taskId, "root")?.status).toBe("completed")
	})

	it("still denies unknown, foreign-root, root, self, and peer lifecycle targets", async () => {
		const { provider, createChild, root, store, asyncInterrupt } = await createHarness()
		const child = await createChild("caller", "completed")
		const peer = await createChild("peer", "completed")
		await store.ensureRoot({ taskId: "foreign-root", status: "running" })
		const foreign = await store.createAgent({
			taskId: "foreign-child",
			parentTaskId: "foreign-root",
			nickname: "foreign",
			role: "review",
			objective: "Foreign root data",
			status: "completed",
		})
		const childTask = asTask(child.taskId, "root", "subagent")

		for (const control of [provider.interruptAgent.bind(provider), provider.cancelAgent.bind(provider)]) {
			await expect(control(root, "unknown-id")).rejects.toThrow("Unknown child agent target")
			await expect(control(root, foreign.taskId)).rejects.toThrow("Unknown child agent target")
			await expect(control(root, "/root")).rejects.toThrow("Unknown child agent target")
			await expect(control(childTask, child.path)).rejects.toThrow("itself")
			await expect(control(childTask, peer.path)).rejects.toThrow("outside the caller's managed subtree")
		}
		expect(asyncInterrupt).not.toHaveBeenCalled()
	})
})

describe("managed-agent peer discovery", () => {
	it("discovers same-tree peers without peer reports, objectives, mailbox bodies, or provider data", async () => {
		const { provider, createChild, store } = await createHarness()
		const caller = await createChild("caller")
		const peer = await createChild("peer", "completed")
		await createChild("nested", "running", caller.taskId)
		await store.ensureRoot({ taskId: "foreign-root", status: "running", objective: "sensitive-foreign-objective" })
		await store.createAgent({
			taskId: "foreign-peer",
			parentTaskId: "foreign-root",
			nickname: "foreign-peer",
			role: "review",
			objective: "sensitive-foreign-objective",
			status: "running",
		})
		await store.appendEvent({
			rootTaskId: "root",
			sender: peer.taskId,
			recipient: caller.taskId,
			kind: "message",
			name: "agent_message",
			payload: { message: "sensitive-mailbox-body" },
		})

		const result = await provider.listAgents(asTask(caller.taskId, "root", "subagent"))

		expect(listPaths(result)).toEqual(["/root", "/root/caller", "/root/caller/nested", "/root/peer"])
		const listing = result as { agents: Array<Record<string, unknown> & { path: string }> }
		const newlyVisible = listing.agents.filter((agent) => !agent.path.startsWith(`${caller.path}/`))
		const serialized = JSON.stringify(newlyVisible)
		expect(serialized).not.toContain("sensitive-")
		for (const key of ["objective", "summary", "error", "contextManifest", "terminalResult", "modelRouteId"]) {
			expect(serialized).not.toContain(`"${key}":`)
		}
		expect(listing.agents.find((agent) => agent.path === `${caller.path}/nested`)).toMatchObject({
			objective: "sensitive-objective-nested",
			modelRouteId: "sensitive-profile-nested",
		})
		expect(JSON.stringify(result)).not.toContain("sensitive-mailbox-body")
		expect(JSON.stringify(result)).not.toContain("sensitive-foreign-objective")
		expect(store.getUnacknowledgedMailboxEntries(caller.taskId, { kinds: ["message"] })).toHaveLength(1)
	})

	it("applies path-component filtering after same-tree visibility and leaves root inspection compatible", async () => {
		const { provider, createChild, root } = await createHarness()
		const caller = await createChild("review")
		await createChild("nested", "running", caller.taskId)
		await createChild("reviewer")
		const childTask = asTask(caller.taskId, "root", "subagent")

		expect(listPaths(await provider.listAgents(childTask, "/root/review"))).toEqual([
			"/root/review",
			"/root/review/nested",
		])
		expect(listPaths(await provider.listAgents(childTask, "/root/unknown"))).toEqual([])
		await expect(provider.listAgents(childTask, "/foreign")).rejects.toThrow("must begin with /root")
		expect(listPaths(await provider.listAgents(root))).toEqual([
			"/root/review",
			"/root/review/nested",
			"/root/reviewer",
		])
	})

	it("bounds newly discoverable identities at 100 while preserving descendants and prefix lookup", async () => {
		const { provider, createChild } = await createHarness()
		const caller = await createChild("caller")
		await createChild("nested", "running", caller.taskId)
		const oldest = await createChild("oldest-peer", "completed")
		for (let index = 0; index < 101; index++) {
			await createChild(`peer-${index.toString().padStart(3, "0")}`, "completed")
		}
		const childTask = asTask(caller.taskId, "root", "subagent")
		const result = (await provider.listAgents(childTask)) as {
			agents: Array<{ taskId: string; path: string; objective?: string }>
			discovery: { totalCount: number; returnedCount: number; truncated: boolean; limit: number }
		}

		expect(result.agents).toHaveLength(101)
		expect(result.discovery).toEqual({ totalCount: 104, returnedCount: 100, truncated: true, limit: 100 })
		expect(result.agents.find(({ path }) => path === "/root/caller/nested")?.objective).toBe(
			"sensitive-objective-nested",
		)
		expect(result.agents.some(({ taskId }) => taskId === "root")).toBe(true)
		expect(result.agents.some(({ taskId }) => taskId === caller.taskId)).toBe(true)
		expect(result.agents.some(({ taskId }) => taskId === oldest.taskId)).toBe(false)
		const filtered = (await provider.listAgents(childTask, oldest.path)) as {
			agents: Array<{ taskId: string }>
			discovery: { totalCount: number; returnedCount: number; truncated: boolean; limit: number }
		}
		expect(filtered.agents).toEqual([{ taskId: oldest.taskId, path: oldest.path, status: "completed" }])
		expect(filtered.discovery).toEqual({ totalCount: 1, returnedCount: 1, truncated: false, limit: 100 })
	})
})

describe("managed runtime removal ownership", () => {
	it("does not abort a captured Task again when eviction wins before a queued UI removal", async () => {
		const { provider } = await createHarness()
		const sessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
		const child = Object.assign(asTask("captured", "root", "subagent"), {
			abortTask: vi.fn(async () => undefined),
			waitForTermination: vi.fn(async () => undefined),
			emit: vi.fn(),
		})
		sessions.register(child, { focus: false })
		sessions.markLifecycle(child.taskId, TaskLifecycleState.Completed)
		Object.assign(provider, {
			getLiveTask: (taskId: string) => sessions.getTask(taskId),
			taskStack: [child],
			taskEventListeners: new Map(),
			publishedTaskTranscriptRevisions: new Map(),
			releaseScopedSkillsManager: vi.fn(async () => undefined),
			currentView: { type: "newTaskDraft" },
			postTaskSessionStateToWebview: vi.fn(async () => undefined),
			log: vi.fn(),
		})
		let begin!: () => void
		let finish!: () => void
		const started = new Promise<void>((resolve) => {
			begin = resolve
		})
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		const eviction = sessions.unloadAfterCleanup(child, async () => {
			begin()
			await finished
		})
		await started
		const removal = provider.removeTaskFromStack({ taskId: child.taskId })
		finish()
		await eviction
		await removal

		expect(sessions.getTask(child.taskId)).toBeUndefined()
		expect(child.abortTask).not.toHaveBeenCalled()
	})
})

describe("production provider runtime pruning", () => {
	it("bounds a fixed 64-child finalization workload and preserves durable status, mail, history, and usage", async () => {
		const { provider, store, root, sessions, manager, prepared, descriptors, publicationKeys, addStopped, prune } =
			await createResidencyHarness()
		const samples: Array<{
			tasks: number
			runs: number
			events: number
			caches: number
			groups: number
			descriptors: number
			keys: number
		}> = []
		for (let index = 0; index < 64; index++) {
			await addStopped(`child-${index}`)
			if ([4, 8, 16, 32, 64].includes(index + 1)) {
				samples.push({
					tasks: sessions.getOwnedTasks().length,
					runs: manager.listSnapshots().length,
					events: manager.getEvents().length,
					caches: Object.keys(sessions.getLifecycleSnapshots()).length,
					groups: prepared.size,
					descriptors: descriptors.size,
					keys: publicationKeys.size,
				})
			}
		}
		for (const sample of samples) {
			expect(sample.tasks).toBeLessThanOrEqual(3)
			expect(sample.runs).toBeLessThanOrEqual(3)
			expect(sample.events).toBe(0)
			expect(sample.caches).toBeLessThanOrEqual(3)
			expect(sample.groups).toBeLessThanOrEqual(3)
			expect(sample.descriptors).toBeLessThanOrEqual(3)
			expect(sample.keys).toBeLessThanOrEqual(3)
		}
		const durableBefore = store.getSnapshot()
		await prune()
		expect(store.getSnapshot()).toEqual(durableBefore)
		const records = store.listAgents({ rootTaskId: "root", includeRoot: false })
		expect(records).toHaveLength(64)
		expect(
			records.every(
				(record) =>
					record.status === "completed" && record.snapshot?.metadata?.frozenAuthorityMarker === "preserve",
			),
		).toBe(true)
		expect(
			records.reduce(
				(sum, record) =>
					sum + (record.snapshot?.usage?.inputTokens ?? 0) + (record.snapshot?.usage?.outputTokens ?? 0),
				0,
			),
		).toBe(320)
		expect(store.getUnacknowledgedMailboxEntries("root", { kinds: ["result"] })).toHaveLength(64)
		expect(root.alphaMessages).toHaveLength(64)
		expect(sessions.getTask("child-0")).toBeUndefined()
		await expect(
			provider.sendMessageToAgent(root, "/root/child-0", "Retain this follow-up evidence"),
		).resolves.toMatchObject({ delivery: "buffered" })
		expect(manager.getSnapshot("child-0")).toBeUndefined()
		expect(store.getUnacknowledgedMailboxEntries("child-0", { kinds: ["message"] })).toHaveLength(1)
	})

	it("keeps all exact runtime owners and durable evidence when Task cleanup fails", async () => {
		const { store, sessions, manager, descriptors, addStopped, unload } = await createResidencyHarness()
		const { child, runId } = await addStopped("cleanup-failure")
		Reflect.set(
			child,
			"unloadSubagentRuntime",
			vi.fn(async () => {
				throw new Error("cleanup failed")
			}),
		)
		const durable = store.getSnapshot()
		const cached = sessions.getLifecycleSnapshots()[child.taskId]

		await expect(unload({ taskId: child.taskId, task: child, runId })).rejects.toThrow("cleanup failed")
		expect(sessions.getTask(child.taskId)).toBe(child)
		expect(manager.getRunId(child.taskId)).toBe(runId)
		expect(descriptors.has(child.taskId)).toBe(true)
		expect(sessions.getLifecycleSnapshots()[child.taskId]).toEqual(cached)
		expect(store.getSnapshot()).toEqual(durable)
	})

	it("does not unload a newer exact run generation", async () => {
		const { sessions, manager, addStopped, unload } = await createResidencyHarness()
		const { child, runId } = await addStopped("generation")
		const current = manager.relaunch(residencyEnvelope(child.taskId), {
			groupId: "followup-group",
			path: "/root/generation",
			nickname: "generation",
			role: "review",
		})
		await manager.waitForResult(child.taskId)

		await expect(unload({ taskId: child.taskId, task: child, runId })).resolves.toBe(false)
		expect(sessions.getTask(child.taskId)).toBe(child)
		expect(manager.getRunId(child.taskId)).toBe(current.runId)
		expect(child.unloadSubagentRuntime).not.toHaveBeenCalled()
	})

	it("finishes old cache release before a queued successor can publish its runtime and caches", async () => {
		const { provider, root, sessions, manager, descriptors, addStopped, unload } = await createResidencyHarness()
		const { child, runId } = await addStopped("successor-race")
		let begin!: () => void
		let finish!: () => void
		const started = new Promise<void>((resolve) => {
			begin = resolve
		})
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		Reflect.set(
			child,
			"unloadSubagentRuntime",
			vi.fn(async () => {
				begin()
				await finished
			}),
		)
		const journals = Reflect.get(provider, "agentLifecycleJournals") as Map<
			string,
			Promise<{ close: () => Promise<void> }>
		>
		journals.set(child.taskId, Promise.resolve({ close: async () => undefined }))
		const projections = new Map([[child.taskId, "old"]])
		Reflect.set(provider, "agentLifecycleProjector", { clear: (taskId: string) => projections.delete(taskId) })
		const eviction = unload({ taskId: child.taskId, task: child, runId })
		await started
		const successor = asTask(child.taskId, "root", "subagent")
		const successorJournal = Promise.resolve({ close: async () => undefined })
		let successorRunId: string | undefined
		const restoration = sessions.runOwnershipOperation(child.taskId, async () => {
			expect(sessions.getTask(child.taskId)).toBeUndefined()
			const options = {
				groupId: "successor-group",
				path: "/root/successor-race",
				nickname: child.taskId,
				role: "review",
			} as const
			const handle = manager.getRunId(child.taskId)
				? manager.relaunch(residencyEnvelope(child.taskId), options)
				: manager.launch(residencyEnvelope(child.taskId), options)
			successorRunId = handle.runId
			sessions.register(successor, { focus: false })
			sessions.markLifecycle(successor.taskId, TaskLifecycleState.Running)
			journals.set(child.taskId, successorJournal)
			projections.set(child.taskId, "successor")
			descriptors.set(child.taskId, { groupId: "successor-group", parent: root })
		})
		finish()
		await eviction
		await restoration

		expect(sessions.getTask(child.taskId)).toBe(successor)
		expect(journals.get(child.taskId)).toBe(successorJournal)
		expect(projections.get(child.taskId)).toBe("successor")
		expect(descriptors.get(child.taskId)?.groupId).toBe("successor-group")
		expect(manager.getRunId(child.taskId)).toBe(successorRunId)
		await manager.waitForResult(child.taskId)
	})

	it("retains a stopped parent while an active nested descriptor still references it", async () => {
		const { store, descriptors, addStopped, unload } = await createResidencyHarness()
		const { child, runId } = await addStopped("nested-owner", async (record, task) => {
			const nested = await store.createAgent({
				taskId: "nested",
				parentTaskId: record.taskId,
				nickname: "nested",
				role: "review",
				objective: "Continue nested work",
				status: "running",
			})
			descriptors.set(nested.taskId, { groupId: "nested-group", parent: task })
		})
		await expect(unload({ taskId: child.taskId, task: child, runId })).resolves.toBe(false)
		await store.updateAgentStatus("nested", "completed", {}, "root")
		await expect(unload({ taskId: child.taskId, task: child, runId })).resolves.toBe(false)
		expect(child.unloadSubagentRuntime).not.toHaveBeenCalled()
	})

	it("makes retained follow-up wait for eviction before selecting a restored runtime", async () => {
		const { provider, root, sessions, addStopped, unload } = await createResidencyHarness()
		const { child, runId } = await addStopped("followup-race")
		let begin!: () => void
		let finish!: () => void
		const started = new Promise<void>((resolve) => {
			begin = resolve
		})
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		Reflect.set(
			child,
			"unloadSubagentRuntime",
			vi.fn(async () => {
				begin()
				await finished
			}),
		)
		const resume = vi.fn(async () => {
			expect(sessions.getTask(child.taskId)).toBeUndefined()
			return { taskId: child.taskId, followup: true }
		})
		Reflect.set(provider, "followupAgentTaskAfterAdmission", resume)
		const eviction = unload({ taskId: child.taskId, task: child, runId })
		await started
		const followup = provider.followupAgentTask(root, child.taskId, "Continue after the eviction barrier")
		expect(resume).not.toHaveBeenCalled()
		finish()
		await eviction
		await expect(followup).resolves.toMatchObject({ taskId: child.taskId, followup: true })
		expect(resume).toHaveBeenCalledOnce()
	})

	it("releases descriptor-only never-launched blocking outcomes without deleting durable evidence", async () => {
		const { store, root, prepared, descriptors, prune } = await createResidencyHarness()
		for (let index = 0; index < 16; index++) {
			const taskId = `unlaunched-${index}`
			const groupId = `blocked-${index}`
			await store.createAgent({
				taskId,
				parentTaskId: "root",
				nickname: taskId,
				role: "review",
				objective: taskId,
				groupId,
				status: "failed",
				snapshot: { stopReason: "never_launched" },
			})
			const group: SubagentGroupState = {
				groupId,
				parentTaskId: "root",
				executionMode: "blocking",
				status: "failed",
				createdAt: index + 1,
				completedAt: index + 1,
				agents: [
					{
						taskId,
						nickname: taskId,
						role: "review",
						objective: taskId,
						status: "failed",
						stopReason: "never_launched",
						usage: { durationMs: 0 },
					},
				],
			}
			prepared.set(groupId, { group, envelopes: [residencyEnvelope(taskId)] })
			descriptors.set(taskId, { groupId, parent: root })
			root.alphaMessages.push({
				ts: index + 1,
				type: "say",
				say: "subagent_group",
				subagentGroup: structuredClone(group),
			})
		}
		const durable = store.getSnapshot()
		await prune()

		expect(prepared.size).toBeLessThanOrEqual(3)
		expect(descriptors.size).toBeLessThanOrEqual(3)
		expect(store.getSnapshot()).toEqual(durable)
		expect(root.alphaMessages).toHaveLength(16)
	})

	it("sweeps orphaned original batch cache after a child's continuation changes its group", async () => {
		const { store, root, prepared, descriptors, addStopped, unload, prune } = await createResidencyHarness()
		const first = await addStopped("first")
		const second = await addStopped("second")
		const original: SubagentGroupState = {
			groupId: "original-batch",
			parentTaskId: "root",
			executionMode: "blocking",
			status: "completed",
			createdAt: 1,
			completedAt: 1,
			agents: [structuredClone(first.group.agents[0]), structuredClone(second.group.agents[0])],
		}
		prepared.set(original.groupId, {
			group: original,
			envelopes: [residencyEnvelope("first"), residencyEnvelope("second")],
		})
		descriptors.set(second.child.taskId, { groupId: original.groupId, parent: root })
		root.alphaMessages.push({ ts: 1, type: "say", say: "subagent_group", subagentGroup: structuredClone(original) })
		await unload({ taskId: second.child.taskId, task: second.child, runId: second.runId })
		await unload({ taskId: first.child.taskId, task: first.child, runId: first.runId })
		const durable = store.getSnapshot()
		await prune()

		expect(prepared.has(original.groupId)).toBe(false)
		expect(store.getSnapshot()).toEqual(durable)
		expect(root.alphaMessages.some((message) => message.subagentGroup?.groupId === original.groupId)).toBe(true)
	})
})
