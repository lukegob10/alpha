import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"

const clock = (initial = 1_000) => {
	let current = initial
	return () => ++current
}

async function createNestedTree(persistence = new InMemoryAgentControlPersistence()) {
	const store = new AgentControlStore(persistence, clock())
	await store.initialize()
	const root = await store.ensureRoot({
		taskId: "root-1",
		objective: "Coordinate the tree",
		status: "running",
	})
	const child = await store.createAgent({
		taskId: "child-1",
		parentTaskId: root.taskId,
		rootTaskId: root.rootTaskId,
		nickname: "Backend",
		role: "review",
		objective: "Review the backend",
		status: "running",
	})
	const grandchild = await store.createAgent({
		taskId: "grandchild-1",
		parentTaskId: child.taskId,
		rootTaskId: root.rootTaskId,
		nickname: "Recovery",
		role: "explore",
		objective: "Inspect recovery",
		status: "running",
	})
	return { store, persistence, root, child, grandchild }
}

describe("AgentControlStore nested trees", () => {
	it("persists immediate ancestry while deriving a stable root-scoped canonical path", async () => {
		const { store, root, child, grandchild } = await createNestedTree()

		expect(child).toMatchObject({
			path: "/root/backend",
			parentTaskId: root.taskId,
			parentPath: root.path,
			rootTaskId: root.taskId,
		})
		expect(grandchild).toMatchObject({
			path: "/root/backend/recovery",
			parentTaskId: child.taskId,
			parentPath: child.path,
			rootTaskId: root.taskId,
		})
		expect(store.listChildren(child.taskId, root.taskId).map((record) => record.taskId)).toEqual([
			grandchild.taskId,
		])
		expect(store.listChildren(root.taskId, root.taskId).map((record) => record.taskId)).toEqual([child.taskId])
		expect(store.listDescendants(root.taskId, root.taskId).map((record) => record.taskId)).toEqual([
			child.taskId,
			grandchild.taskId,
		])
		expect(store.isDescendant(child.taskId, grandchild.taskId, root.taskId)).toBe(true)
		expect(store.isDescendant(grandchild.taskId, child.taskId, root.taskId)).toBe(false)

		await expect(
			store.createAgent({
				taskId: "wrong-root-grandchild",
				parentTaskId: child.taskId,
				rootTaskId: "different-root",
				nickname: "Wrong Root",
				role: "explore",
				objective: "Escape the root",
			}),
		).rejects.toThrow("does not match parent root")
	})

	it("routes descendant results to the immediate parent without consuming root mail", async () => {
		const { store, root, child, grandchild } = await createNestedTree()

		const result = await store.appendEvent({
			eventId: "grandchild-result",
			rootTaskId: root.taskId,
			sender: grandchild.taskId,
			recipient: child.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { taskId: grandchild.taskId, summary: "Recovery inspected" },
		})

		expect(store.readMailbox(child.taskId, { rootTaskId: root.taskId }).entries).toEqual([result.entry])
		expect(store.readMailbox(root.taskId, { rootTaskId: root.taskId }).entries).toEqual([])
		expect(store.readMailbox(grandchild.taskId, { rootTaskId: root.taskId }).entries).toEqual([])
	})

	it("rejects mailbox senders from a different root tree", async () => {
		const { store, root, grandchild } = await createNestedTree()
		await store.ensureRoot({ taskId: "root-2", objective: "Another tree", status: "running" })
		const foreign = await store.createAgent({
			taskId: "foreign-child",
			parentTaskId: "root-2",
			rootTaskId: "root-2",
			nickname: "Foreign",
			role: "review",
			objective: "Review another tree",
			status: "running",
		})

		await expect(
			store.appendEvent({
				rootTaskId: root.taskId,
				sender: foreign.taskId,
				recipient: grandchild.taskId,
				kind: "message",
				name: "cross_root_message",
			}),
		).rejects.toThrow("Unknown or closed agent target")
	})

	it("recovers every active descendant once and notifies each immediate parent", async () => {
		const { persistence, root, child, grandchild } = await createNestedTree()

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()

		expect(reloaded.getAgent(root.taskId)).toMatchObject({
			status: "interrupted",
			snapshot: { stopReason: "interrupted" },
		})
		expect(reloaded.getAgent(child.taskId)).toMatchObject({
			status: "interrupted",
			snapshot: { stopReason: "interrupted" },
		})
		expect(reloaded.getAgent(grandchild.taskId)).toMatchObject({
			status: "interrupted",
			snapshot: { stopReason: "interrupted" },
		})
		expect(
			reloaded.readMailbox(root.taskId, { rootTaskId: root.taskId }).entries.map((entry) => ({
				senderTaskId: entry.senderTaskId,
				recipientTaskId: entry.recipientTaskId,
				name: entry.name,
				payload: entry.payload,
			})),
		).toEqual([
			{
				senderTaskId: child.taskId,
				recipientTaskId: root.taskId,
				name: "recovered_interrupted",
				payload: { previousStatus: "running", stopReason: "interrupted" },
			},
		])
		expect(
			reloaded.readMailbox(child.taskId, { rootTaskId: root.taskId }).entries.map((entry) => ({
				senderTaskId: entry.senderTaskId,
				recipientTaskId: entry.recipientTaskId,
				name: entry.name,
				payload: entry.payload,
			})),
		).toEqual([
			{
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				name: "recovered_interrupted",
				payload: { previousStatus: "running", stopReason: "interrupted" },
			},
		])

		const reloadedAgain = new AgentControlStore(persistence, clock(30_000))
		await reloadedAgain.initialize()
		expect(
			reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted"),
		).toHaveLength(2)
	})

	it("routes an orphaned descendant recovery notice to the surviving root", async () => {
		const { store, root, child, grandchild } = await createNestedTree()
		const persisted = store.getSnapshot()
		const orphanedPersistence = new InMemoryAgentControlPersistence({
			...persisted,
			agents: persisted.agents.filter((record) => record.taskId !== child.taskId),
		})

		const reloaded = new AgentControlStore(orphanedPersistence, clock(40_000))
		await reloaded.initialize()

		expect(reloaded.getAgent(grandchild.taskId)).toMatchObject({
			status: "interrupted",
			snapshot: { stopReason: "orphaned" },
		})
		expect(reloaded.readMailbox(root.taskId, { rootTaskId: root.taskId }).entries).toEqual([
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				recipientTaskId: root.taskId,
				name: "recovered_interrupted",
				payload: {
					previousStatus: "running",
					stopReason: "orphaned",
					orphaned: true,
					missingParentTaskId: child.taskId,
				},
			}),
		])
	})

	it("copies the stable terminal cause into the retained close tombstone", async () => {
		const { store, root, grandchild } = await createNestedTree()
		await store.updateAgentStatus(
			grandchild.taskId,
			"timed_out",
			{
				snapshot: { stopReason: "output_token_limit" },
				terminalResult: {
					status: "timed_out",
					error: "Root token budget exhausted",
					completedAt: 2_000,
					stopReason: "root_token_budget",
				},
			},
			root.rootTaskId,
		)

		await expect(store.closeAgent(grandchild.taskId, root.rootTaskId)).resolves.toMatchObject({
			taskId: grandchild.taskId,
			status: "timed_out",
			stopReason: "root_token_budget",
		})
		expect(
			store.resolveTarget(grandchild.taskId, { rootTaskId: root.rootTaskId, includeClosed: true }),
		).toMatchObject({
			closed: true,
			tombstone: { stopReason: "root_token_budget" },
		})
	})
})
