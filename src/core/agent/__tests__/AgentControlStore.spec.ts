import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import { AgentControlStore, FileAgentControlPersistence, InMemoryAgentControlPersistence } from "../AgentControlStore"

const clock = (initial = 1_000) => {
	let current = initial
	return () => ++current
}

const setup = async (persistence = new InMemoryAgentControlPersistence()) => {
	const store = new AgentControlStore(persistence, clock())
	await store.initialize()
	await store.ensureRoot({ taskId: "root-1", objective: "Coordinate work", status: "interrupted" })
	return { store, persistence }
}

describe("AgentControlStore", () => {
	it("allocates canonical stable paths and never reuses a closed path", async () => {
		const { store } = await setup()
		const first = await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review the API",
		})
		const second = await store.createAgent({
			taskId: "review-2",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review tests",
		})

		expect(first.path).toBe("/root/api-review")
		expect(second.path).toBe("/root/api-review-2")

		await store.updateAgentStatus(first.taskId, "cancelled")
		await store.closeAgent(first.path, "root-1")
		const third = await store.createAgent({
			taskId: "review-3",
			parentTaskId: "root-1",
			nickname: "API Review",
			role: "review",
			objective: "Review recovery",
		})
		expect(third.path).toBe("/root/api-review-3")
	})

	it("queries the tree and resolves targets by task ID or root-scoped path", async () => {
		const { store } = await setup()
		const review = await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
		})
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
		})

		expect(store.getAgent("review-1")).toEqual(review)
		expect(store.getAgent("/root/review", "root-1")?.taskId).toBe("review-1")
		expect(store.listChildren("root-1").map((agent) => agent.taskId)).toEqual(["review-1", "worker-1"])
		expect(store.listAgents({ rootTaskId: "root-1", includeRoot: false })).toHaveLength(2)

		await store.ensureRoot({ taskId: "root-2", status: "interrupted" })
		await store.createAgent({
			taskId: "review-other-root",
			parentTaskId: "root-2",
			nickname: "Review",
			role: "review",
			objective: "Review another tree",
		})
		expect(() => store.resolveTarget("/root/review")).toThrow(/ambiguous/)
		expect(store.resolveTarget("/root/review", { rootTaskId: "root-2" })).toMatchObject({
			closed: false,
			record: { taskId: "review-other-root" },
		})
	})

	it("appends events idempotently and assigns monotonic sequences", async () => {
		const { store } = await setup()
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
		})
		const observed: string[] = []
		store.subscribe((entry) => observed.push(entry.eventId))

		const first = await store.appendEvent({
			eventId: "message-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "message",
			name: "user_message",
			payload: { text: "Inspect the tests" },
		})
		const retry = await store.appendEvent({
			eventId: "message-1",
			sender: "/root",
			recipient: "/root/review",
			rootTaskId: "root-1",
			kind: "message",
			name: "user_message",
			payload: { text: "Inspect the tests" },
		})
		const second = await store.appendEvent({
			eventId: "control-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "control",
			name: "interrupt",
		})

		expect(first.appended).toBe(true)
		expect(retry).toEqual({ entry: first.entry, appended: false })
		expect(second.entry.sequence).toBe(first.entry.sequence + 1)
		expect(observed).toEqual(["message-1", "control-1"])
		await expect(
			store.appendEvent({
				eventId: "message-1",
				recipient: "review-1",
				kind: "message",
				name: "different_message",
			}),
		).rejects.toThrow(/different content/)
	})

	it("retains terminal results until explicit close", async () => {
		const { store } = await setup()
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "root-1",
			nickname: "Worker",
			role: "worker",
			objective: "Implement",
			status: "running",
		})
		await expect(store.closeAgent("worker-1")).rejects.toThrow(/cannot be closed/)

		const completed = await store.updateAgentStatus("worker-1", "completed", {
			terminalResult: {
				status: "completed",
				summary: "Implemented",
				changedFiles: ["src/example.ts"],
				requiresParentVerification: true,
				completedAt: 2_000,
			},
		})
		expect(store.getAgent("worker-1")).toEqual(completed)
		expect(store.listAgents({ statuses: ["completed"] })).toHaveLength(1)

		const tombstone = await store.closeAgent("worker-1")
		expect(store.getAgent("worker-1")).toBeUndefined()
		expect(store.resolveTarget("worker-1", { includeClosed: true })).toEqual({ closed: true, tombstone })
		await expect(
			store.appendEvent({
				recipient: "worker-1",
				kind: "followup",
				name: "followup",
			}),
		).rejects.toThrow(/closed agent target/)
	})

	it("recovers active records once while preserving completed records", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const first = new AgentControlStore(persistence, clock(10_000))
		await first.initialize()
		await first.ensureRoot({ taskId: "root-1", status: "running" })
		await first.createAgent({
			taskId: "running-child",
			parentTaskId: "root-1",
			nickname: "Running",
			role: "explore",
			objective: "Run",
			status: "running",
		})
		await first.createAgent({
			taskId: "completed-child",
			parentTaskId: "root-1",
			nickname: "Completed",
			role: "review",
			objective: "Complete",
			status: "completed",
		})

		const reloaded = new AgentControlStore(persistence, clock(20_000))
		await reloaded.initialize()
		expect(reloaded.getAgent("root-1")?.status).toBe("interrupted")
		expect(reloaded.getAgent("running-child")?.status).toBe("interrupted")
		expect(reloaded.getAgent("completed-child")?.status).toBe("completed")
		const recoveryEvents = reloaded.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted")
		expect(recoveryEvents).toHaveLength(1)
		expect(recoveryEvents[0]).toMatchObject({
			senderTaskId: "running-child",
			recipientTaskId: "root-1",
			payload: { previousStatus: "running" },
		})

		const reloadedAgain = new AgentControlStore(persistence, clock(30_000))
		await reloadedAgain.initialize()
		expect(
			reloadedAgain.getSnapshot().mailbox.filter((entry) => entry.name === "recovered_interrupted"),
		).toHaveLength(1)
	})

	it("tracks per-recipient delivery and acknowledgement cursors durably", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const { store } = await setup(persistence)
		await store.createAgent({
			taskId: "review-1",
			parentTaskId: "root-1",
			nickname: "Review",
			role: "review",
			objective: "Review",
			status: "interrupted",
		})
		const first = await store.appendEvent({
			eventId: "mail-1",
			sender: "root-1",
			recipient: "review-1",
			kind: "message",
			name: "message",
		})
		const second = await store.appendEvent({
			eventId: "mail-2",
			sender: "root-1",
			recipient: "review-1",
			kind: "followup",
			name: "followup",
		})

		expect(store.readMailbox("review-1").entries.map((entry) => entry.eventId)).toEqual(["mail-1", "mail-2"])
		await store.markDelivered("review-1", first.entry.sequence, undefined, 5_000)
		expect(store.readMailbox("review-1").entries.map((entry) => entry.eventId)).toEqual(["mail-2"])
		await store.acknowledge("review-1", second.entry.sequence, undefined, 6_000)

		const reloaded = new AgentControlStore(persistence, clock(40_000))
		await reloaded.initialize()
		expect(reloaded.getMailboxCursor("review-1")).toMatchObject({
			lastDeliveredSequence: second.entry.sequence,
			lastAcknowledgedSequence: second.entry.sequence,
		})
		expect(reloaded.readMailbox("review-1").entries).toEqual([])
		const all = reloaded.readMailbox("review-1", { afterSequence: 0 }).entries
		expect(all[0]).toMatchObject({ eventId: "mail-1", deliveredAt: 5_000 })
		expect(all[1]).toMatchObject({ eventId: "mail-2", deliveredAt: 6_000, acknowledgedAt: 6_000 })
	})

	it("persists one atomic versioned snapshot under global storage", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-control-"))
		try {
			const persistence = new FileAgentControlPersistence(directory)
			const first = new AgentControlStore(persistence, clock(50_000))
			await first.initialize()
			await first.ensureRoot({ taskId: "root-file", status: "interrupted" })

			const raw = JSON.parse(await fs.readFile(persistence.filePath, "utf8"))
			expect(raw).toMatchObject({ version: 1, agents: [{ taskId: "root-file", path: "/root" }] })

			const reloaded = new AgentControlStore(new FileAgentControlPersistence(directory), clock(60_000))
			await reloaded.initialize()
			expect(reloaded.getAgent("root-file")?.path).toBe("/root")
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("shares one in-process store for the same global storage path", () => {
		const storagePath = path.join(os.tmpdir(), `alpha-agent-control-shared-${randomUUID()}`)

		expect(AgentControlStore.forGlobalStorage(storagePath)).toBe(
			AgentControlStore.forGlobalStorage(path.resolve(storagePath)),
		)
	})
})
