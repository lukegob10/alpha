import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"
import {
	createSubagentEffectiveLimits,
	resolveSubagentOrchestrationSettings,
	type SubagentManifestOrchestration,
} from "@alpha-code/types"

async function setup() {
	const persistence = new InMemoryAgentControlPersistence()
	const store = new AgentControlStore(persistence)
	await store.initialize()
	await store.ensureRoot({ taskId: "root", status: "running" })
	await store.createAgent({
		taskId: "child",
		parentTaskId: "root",
		groupId: "original-batch",
		nickname: "Child",
		role: "review",
		objective: "Inspect",
		status: "running",
	})
	const previous = await store.updateAgentStatus("child", "completed", {
		at: 2_000,
		snapshot: {
			phase: "completed",
			summary: "Original result",
			usage: { inputTokens: 10, outputTokens: 2, cost: 0.5 },
			metadata: { preserved: true },
		},
		terminalResult: {
			status: "completed",
			summary: "Original result",
			completedAt: 2_000,
			usage: { inputTokens: 9, outputTokens: 1, cost: 0.25, durationMs: 1 },
		},
	})
	const event = {
		eventId: "followup-receipt",
		rootTaskId: "root",
		sender: "root",
		recipient: "child",
		kind: "followup" as const,
		name: "followup_started",
		payload: { message: "Inspect again" },
	}
	const admit = () =>
		store.updateAgentStatusAndAppendEvent(
			"child",
			"pending",
			{ at: 3_000, snapshot: { phase: "queued" }, pendingFollowupEventId: event.eventId },
			event,
			"root",
		)
	return { store, persistence, previous, event, admit }
}

describe("AgentControlStore follow-up admission durability", () => {
	it("admits a per-child continuation group atomically and restores its original group on rollback", async () => {
		const { store, persistence, previous, event } = await setup()
		await store.updateAgentStatusAndAppendEvent(
			"child",
			"pending",
			{ groupId: "child-continuation", pendingFollowupEventId: event.eventId },
			event,
			"root",
		)
		expect(store.getAgent("child")).toMatchObject({ status: "pending", groupId: "child-continuation" })
		expect(await store.rollbackAgentFollowup(previous, event.eventId)).toBe(true)
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getAgent("child")).toEqual({ ...previous, pendingFollowupEventId: event.eventId })
		expect(reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === event.eventId)).toHaveLength(1)
	})

	it("rejects group changes outside child pending admission without changing the retained record", async () => {
		const { store, previous } = await setup()
		await expect(
			store.updateAgentStatus("child", "completed", { groupId: "invalid-terminal-group" }),
		).rejects.toThrow("during pending admission")
		await store.updateAgentStatus("root", "completed")
		await expect(store.updateAgentStatus("root", "pending", { groupId: "invalid-root-group" })).rejects.toThrow(
			"during pending admission",
		)
		await expect(store.updateAgentStatus("child", "pending", { groupId: " " })).rejects.toThrow(
			"during pending admission",
		)
		expect(store.getAgent("child")).toEqual(previous)
	})

	it.each(["completion", "message"] as const)(
		"serializes active follow-up admission with %s winning the terminal boundary",
		async (winner) => {
			const { store } = await setup()
			await store.updateAgentStatus("child", "pending")
			await store.updateAgentStatus("child", "running")
			const terminal = () => store.updateAgentStatus("child", "completed")
			const message = () =>
				store.appendEventWhileRecipientActive({
					eventId: "active-followup",
					rootTaskId: "root",
					sender: "root",
					recipient: "child",
					kind: "message",
					name: "parent_message",
					payload: { message: "Continue if active" },
				})
			const admitted =
				winner === "completion"
					? await Promise.all([terminal(), message()]).then(([, result]) => result)
					: await Promise.all([message(), terminal()]).then(([result]) => result)
			expect(store.getAgent("child")?.status).toBe("completed")
			if (winner === "completion") {
				expect(admitted).toBeUndefined()
				expect(store.getUnacknowledgedMailboxEntries("child", { kinds: ["message"] })).toEqual([])
			} else {
				expect(admitted).toMatchObject({ appended: true, entry: { eventId: "active-followup" } })
				expect(store.getUnacknowledgedMailboxEntries("child", { kinds: ["message"] })).toHaveLength(1)
			}
		},
	)

	it("atomically rolls back terminal metadata while retaining one authoritative event across reload", async () => {
		const { store, persistence, previous, event, admit } = await setup()
		await admit()
		expect(await store.rollbackAgentFollowup(previous, event.eventId)).toBe(true)
		expect(store.getAgent("child")).toEqual({ ...previous, pendingFollowupEventId: event.eventId })
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getAgent("child")).toEqual({ ...previous, pendingFollowupEventId: event.eventId })
		const retry = await reloaded.updateAgentStatusAndAppendEvent(
			"child",
			"pending",
			{ pendingFollowupEventId: event.eventId },
			event,
			"root",
		)
		expect(retry.appended).toBe(false)
		expect(reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === event.eventId)).toHaveLength(1)
	})

	it("preserves committed input and refuses a changed retry transaction", async () => {
		const { store, previous, event, admit } = await setup()
		await admit()
		await store.rollbackAgentFollowup(previous, event.eventId)
		await expect(
			store.updateAgentStatusAndAppendEvent(
				"child",
				"pending",
				{ pendingFollowupEventId: event.eventId },
				{ ...event, payload: { message: "Replacement" } },
				"root",
			),
		).rejects.toThrow("different content")
		expect(store.getAgent("child")).toEqual({ ...previous, pendingFollowupEventId: event.eventId })
	})

	it.each(["running", "cancelled", "completed"] as const)(
		"does not restore an admission superseded by %s",
		async (status) => {
			const { store, previous, event, admit } = await setup()
			await admit()
			await store.updateAgentStatus("child", status, { pendingFollowupEventId: null })
			expect(await store.rollbackAgentFollowup(previous, event.eventId)).toBe(false)
			expect(store.getAgent("child")?.status).toBe(status)
		},
	)

	it("does not roll back a newer pending admission or resurrect a closed agent", async () => {
		const { store, previous, event, admit } = await setup()
		await admit()
		await store.updateAgentStatus("child", "pending", { pendingFollowupEventId: "newer-receipt" })
		expect(await store.rollbackAgentFollowup(previous, event.eventId)).toBe(false)
		await store.updateAgentStatus("child", "completed", {})
		await store.closeAgent("child", "root")
		expect(await store.rollbackAgentFollowup(previous, "newer-receipt")).toBe(false)
		expect(store.getAgent("child")).toBeUndefined()
	})

	it("keeps an unlaunched receipt through pending-row crash recovery", async () => {
		const { persistence, event, admit } = await setup()
		await admit()
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getAgent("child")).toMatchObject({
			status: "interrupted",
			pendingFollowupEventId: event.eventId,
		})
		expect(reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === event.eventId)).toHaveLength(1)
	})

	it("retains the maximum control snapshot, terminal result and captured usage on close", async () => {
		const { store, persistence } = await setup()
		expect(await store.closeAgent("child", "root", { tokens: 11, cost: 1 })).toMatchObject({
			budgetUsage: { tokens: 12, cost: 1 },
		})
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.listClosedAgents("root")).toMatchObject([
			{ taskId: "child", budgetUsage: { tokens: 12, cost: 1 } },
		])
	})

	it("atomically retains an isolated frozen orchestration through close and reload", async () => {
		const { store, persistence } = await setup()
		const orchestration: SubagentManifestOrchestration = {
			ancestry: { rootTaskId: "root", parentTaskId: "root", depth: 1, maxDepth: 2 },
			delegationPolicy: {
				policy: "explicit-only",
				source: "default",
				authorization: "session-policy",
				explicitUserRequest: false,
			},
			limits: createSubagentEffectiveLimits(
				resolveSubagentOrchestrationSettings({ subagentRootTokenBudget: 50_000, subagentRootCostBudget: null }),
				"review",
				3,
			),
		}
		const original = structuredClone(orchestration)
		await expect(
			store.closeAgent("child", "root", undefined, {
				...orchestration,
				ancestry: { ...orchestration.ancestry, rootTaskId: "foreign-root" },
			}),
		).rejects.toThrow("different root")
		expect(store.getAgent("child")?.status).toBe("completed")
		expect(store.listClosedAgents("root")).toEqual([])
		await store.closeAgent("child", "root", undefined, orchestration)
		orchestration.limits.rootTokenBudget = null
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.listClosedAgents("root")[0].orchestration).toEqual(original)
	})
})
