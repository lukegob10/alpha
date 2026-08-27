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

	it("layers Worker verification ownership at each immediate parent", async () => {
		const { store, root } = await createNestedTree()
		const outerWorker = await store.createAgent({
			taskId: "outer-worker",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Outer Worker",
			role: "worker",
			objective: "Own the outer private checkout",
			status: "running",
		})
		const nestedWorker = await store.createAgent({
			taskId: "nested-worker",
			parentTaskId: outerWorker.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Nested Worker",
			role: "worker",
			objective: "Implement inside the owning Worker checkout",
			status: "completed",
		})
		await store.recordWorkerChangeSet({
			rootTaskId: root.rootTaskId,
			parentTaskId: outerWorker.taskId,
			workerTaskId: nestedWorker.taskId,
			workerPath: nestedWorker.path,
			workerNickname: nestedWorker.nickname,
			groupId: "nested-worker-group",
			changeSet: {
				id: "nested-change",
				status: "applied",
				changedFiles: ["src/nested.ts"],
				createdAt: 2_000,
				updatedAt: 2_100,
			},
			reviewSource: "apply",
			at: 2_100,
		})

		expect(store.getVerificationObligations({ parentTaskId: outerWorker.taskId })).toMatchObject([
			{ parentTaskId: outerWorker.taskId, workerTaskId: nestedWorker.taskId, status: "pending" },
		])
		expect(store.getParentCompletionDecision(outerWorker.taskId, root.rootTaskId).allowed).toBe(false)
		expect(store.getParentCompletionDecision(root.taskId, root.rootTaskId).allowed).toBe(true)

		await store.recordParentVerificationEvidence(
			outerWorker.taskId,
			[
				{
					toolCallId: "verify-nested",
					executionId: "verify-nested-execution",
					status: "succeeded",
					command: "pnpm test src/nested.ts",
					verificationChangeSetIds: ["nested-change"],
					startedAt: 2_101,
					completedAt: 2_102,
					exitCode: 0,
				},
			],
			root.rootTaskId,
		)
		expect(store.getParentCompletionDecision(outerWorker.taskId, root.rootTaskId).allowed).toBe(true)

		await store.recordWorkerChangeSet({
			rootTaskId: root.rootTaskId,
			parentTaskId: root.taskId,
			workerTaskId: outerWorker.taskId,
			workerPath: outerWorker.path,
			workerNickname: outerWorker.nickname,
			groupId: "outer-worker-group",
			changeSet: {
				id: "outer-change",
				status: "applied",
				changedFiles: ["src/nested.ts"],
				createdAt: 2_200,
				updatedAt: 2_300,
			},
			reviewSource: "apply",
			at: 2_300,
		})
		expect(store.getParentCompletionDecision(root.taskId, root.rootTaskId).allowed).toBe(false)
		expect(store.getVerificationObligations({ parentTaskId: root.taskId })).toMatchObject([
			{ parentTaskId: root.taskId, workerTaskId: outerWorker.taskId, status: "pending" },
		])
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
		expect(reloaded.readMailbox(root.taskId, { rootTaskId: root.taskId }).entries).toMatchObject([
			{
				senderTaskId: child.taskId,
				recipientTaskId: root.taskId,
				kind: "lifecycle",
				name: "recovered_interrupted",
				payload: { previousStatus: "running", stopReason: "interrupted" },
			},
			{
				senderTaskId: child.taskId,
				recipientTaskId: root.taskId,
				kind: "result",
				name: "agent_interrupted",
				payload: {
					taskId: child.taskId,
					status: "interrupted",
					stopReason: "interrupted",
				},
			},
		])
		expect(reloaded.readMailbox(child.taskId, { rootTaskId: root.taskId }).entries).toMatchObject([
			{
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				kind: "lifecycle",
				name: "recovered_interrupted",
				payload: { previousStatus: "running", stopReason: "interrupted" },
			},
			{
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				kind: "result",
				name: "agent_interrupted",
				payload: {
					taskId: grandchild.taskId,
					status: "interrupted",
					stopReason: "interrupted",
				},
			},
		])

		const reloadedAgain = new AgentControlStore(persistence, clock(30_000))
		await reloadedAgain.initialize()
		expect(
			reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted"),
		).toHaveLength(2)
		expect(reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "agent_interrupted")).toHaveLength(
			2,
		)
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
		expect(reloaded.readMailbox(root.taskId, { rootTaskId: root.taskId }).entries).toMatchObject([
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				recipientTaskId: root.taskId,
				kind: "lifecycle",
				name: "recovered_interrupted",
				payload: {
					previousStatus: "running",
					stopReason: "orphaned",
					orphaned: true,
					missingParentTaskId: child.taskId,
				},
			}),
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				recipientTaskId: root.taskId,
				kind: "result",
				name: "agent_interrupted",
				payload: expect.objectContaining({
					taskId: grandchild.taskId,
					status: "interrupted",
					stopReason: "orphaned",
				}),
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
