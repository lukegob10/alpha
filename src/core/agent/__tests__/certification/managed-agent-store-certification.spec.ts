import { AgentControlStore, InMemoryAgentControlPersistence } from "../../AgentControlStore"

describe("managed-agent store certification", () => {
	function createStore(persistence = new InMemoryAgentControlPersistence()) {
		let now = 1_000
		return {
			persistence,
			store: new AgentControlStore(persistence, () => now++),
		}
	}

	async function createNestedTree(store: AgentControlStore) {
		await store.initialize()
		await store.ensureRoot({ taskId: "root-1", nickname: "root", status: "running" })
		const coordinator = await store.createAgent({
			taskId: "coordinator-1",
			parentTaskId: "root-1",
			nickname: "Coordinator",
			role: "review",
			objective: "Coordinate one bounded child",
			status: "running",
		})
		const worker = await store.createAgent({
			taskId: "worker-1",
			parentTaskId: coordinator.taskId,
			nickname: "Worker",
			role: "worker",
			objective: "Implement an isolated change",
			status: "running",
		})
		return { coordinator, worker }
	}

	it("allocates stable nested identity and routes a grandchild result only to its immediate parent mailbox", async () => {
		const { store } = createStore()
		const { coordinator, worker } = await createNestedTree(store)

		expect(coordinator).toMatchObject({
			path: "/root/coordinator",
			parentTaskId: "root-1",
			parentPath: "/root",
			rootTaskId: "root-1",
		})
		expect(worker).toMatchObject({
			path: "/root/coordinator/worker",
			parentTaskId: "coordinator-1",
			parentPath: "/root/coordinator",
			rootTaskId: "root-1",
		})
		expect(store.listChildren("root-1").map(({ taskId }) => taskId)).toEqual(["coordinator-1"])
		expect(store.listChildren("coordinator-1").map(({ taskId }) => taskId)).toEqual(["worker-1"])

		await store.appendEvent({
			eventId: "worker-result-1",
			sender: "worker-1",
			recipient: "coordinator-1",
			kind: "result",
			name: "completed",
			payload: { summary: "done" },
		})

		expect(store.readMailbox("coordinator-1", { kinds: ["result"] }).entries).toMatchObject([
			{
				senderTaskId: "worker-1",
				recipientTaskId: "coordinator-1",
				recipientPath: "/root/coordinator",
				payload: { summary: "done" },
			},
		])
		expect(store.readMailbox("root-1", { kinds: ["result"] }).entries).toEqual([])
	})

	it("recovers nested active records to their immediate parents exactly once", async () => {
		const first = createStore()
		await createNestedTree(first.store)

		const reloaded = new AgentControlStore(first.persistence, () => 2_000)
		await reloaded.initialize()

		expect(reloaded.getAgent("coordinator-1")?.status).toBe("interrupted")
		expect(reloaded.getAgent("worker-1")?.status).toBe("interrupted")
		expect(reloaded.readMailbox("root-1").entries).toMatchObject([
			{ name: "recovered_interrupted", senderTaskId: "coordinator-1", recipientTaskId: "root-1" },
		])
		expect(reloaded.readMailbox("coordinator-1").entries).toMatchObject([
			{
				name: "recovered_interrupted",
				senderTaskId: "worker-1",
				recipientTaskId: "coordinator-1",
			},
		])

		const reloadedAgain = new AgentControlStore(first.persistence, () => 3_000)
		await reloadedAgain.initialize()
		expect(reloadedAgain.getSnapshot().mailbox.filter(({ name }) => name === "recovered_interrupted")).toHaveLength(
			2,
		)
	})

	it("requires bottom-up close and never reuses a retained nested path", async () => {
		const { store } = createStore()
		await createNestedTree(store)
		await store.updateAgentStatus("worker-1", "completed")
		await store.updateAgentStatus("coordinator-1", "completed")

		await expect(store.closeAgent("coordinator-1")).rejects.toThrow(/retained children/)
		await store.closeAgent("worker-1")
		await store.closeAgent("coordinator-1")

		const replacement = await store.createAgent({
			taskId: "coordinator-2",
			parentTaskId: "root-1",
			nickname: "Coordinator",
			role: "review",
			objective: "Replacement coordinator",
		})
		expect(replacement.path).toBe("/root/coordinator-2")
	})

	it("serializes a concurrent duplicate mailbox event into one sequence", async () => {
		const { store } = createStore()
		const { coordinator, worker } = await createNestedTree(store)
		const event = {
			eventId: "duplicate-result",
			sender: worker.taskId,
			recipient: coordinator.taskId,
			kind: "result" as const,
			name: "completed",
			payload: { runId: "run-1" },
		}

		const results = await Promise.all([store.appendEvent(event), store.appendEvent(event)])

		expect(results.filter(({ appended }) => appended)).toHaveLength(1)
		expect(results[0].entry.sequence).toBe(results[1].entry.sequence)
		expect(store.readMailbox(coordinator.taskId).entries).toHaveLength(1)
	})
})
