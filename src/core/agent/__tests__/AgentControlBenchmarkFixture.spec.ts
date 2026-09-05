import { agentControlStateSchema } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence, type AgentControlPersistence } from "../AgentControlStore"
import {
	AGENT_CONTROL_BENCHMARK_TIMESTAMP,
	buildAgentControlBenchmarkFixture,
} from "./fixtures/agentControlBenchmarkFixture"

describe("AgentControlBenchmarkFixture", () => {
	it("builds deterministic current-version state with independent mutable values", () => {
		const options = { retainedAgentCount: 7, projectCount: 3 }
		const first = buildAgentControlBenchmarkFixture(options)
		const second = buildAgentControlBenchmarkFixture(options)
		expect(first.state.version).toBe(2)
		expect(agentControlStateSchema.parse(first.state)).toEqual(first.state)
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
		first.state.agents[0].objective = "Changed"
		first.state.mailbox[0].payload!.body = "Changed"
		first.state.verificationObligations[0].changedFiles.push("another.ts")
		expect(second).toEqual(buildAgentControlBenchmarkFixture(options))
	})

	it("honors requested sizes and keeps project, mailbox, and verification relationships coherent", () => {
		const { state, projects } = buildAgentControlBenchmarkFixture({
			retainedAgentCount: 7,
			projectCount: 3,
			mailboxEntriesPerAgent: 2,
			mailboxPayloadBytes: 31,
			verificationObligationsPerAgent: 3,
			ownerId: "fixture-test-owner",
		})
		const workers = state.agents.filter((agent) => agent.role === "worker")
		expect(state.agents).toHaveLength(10)
		expect(workers).toHaveLength(7)
		expect(state.mailbox).toHaveLength(14)
		expect(state.verificationObligations).toHaveLength(21)
		expect(new Set(state.agents.map((agent) => agent.taskId)).size).toBe(state.agents.length)
		expect(new Set(state.agents.map((agent) => `${agent.rootTaskId}:${agent.path}`)).size).toBe(10)
		expect(new Set(state.mailbox.map((entry) => entry.eventId)).size).toBe(state.mailbox.length)
		expect(new Set(state.verificationObligations.map((entry) => entry.id)).size).toBe(21)
		expect(state.mailbox.map((entry) => entry.sequence)).toEqual(
			Array.from({ length: 14 }, (_, index) => index + 1),
		)
		expect(state.nextSequence).toBe(15)
		expect(
			projects.map(({ rootTaskId }) => workers.filter((worker) => worker.rootTaskId === rootTaskId).length),
		).toEqual([3, 2, 2])
		for (const project of projects) {
			const root = state.agents.find((agent) => agent.taskId === project.rootTaskId)!
			expect(root).toMatchObject({ role: "root", status: "running", runtimeOwnerId: "fixture-test-owner" })
			const messages = state.mailbox.filter((entry) => entry.rootTaskId === root.taskId)
			const lastSequence = messages.at(-1)!.sequence
			expect(state.mailboxCursors[`${root.taskId}:${root.taskId}`]).toMatchObject({
				recipientTaskId: root.taskId,
				lastDeliveredSequence: lastSequence,
				lastAcknowledgedSequence: lastSequence,
			})
			for (const entry of messages) {
				const sender = workers.find((worker) => worker.taskId === entry.senderTaskId)!
				expect(sender).toMatchObject({
					rootTaskId: root.taskId,
					parentTaskId: root.taskId,
					path: entry.senderPath,
				})
				expect(entry.recipientTaskId).toBe(root.taskId)
				expect(Buffer.byteLength(String(entry.payload!.body), "utf8")).toBe(31)
				expect(entry.acknowledgedAt).toBe(AGENT_CONTROL_BENCHMARK_TIMESTAMP)
			}
			for (const obligation of state.verificationObligations.filter((item) => item.rootTaskId === root.taskId)) {
				const worker = workers.find((agent) => agent.taskId === obligation.workerTaskId)!
				expect(obligation).toMatchObject({
					parentTaskId: root.taskId,
					workspacePath: project.workspacePath,
					workerPath: worker.path,
					groupId: worker.groupId,
				})
			}
		}
		expect(agentControlStateSchema.safeParse(state).success).toBe(true)
	})

	it("supports empty retained history and zero-size payloads", () => {
		const { state } = buildAgentControlBenchmarkFixture({ retainedAgentCount: 0, projectCount: 1 })
		expect(state.agents).toHaveLength(1)
		expect(state.mailbox).toEqual([])
		expect(state.verificationObligations).toEqual([])
		expect(state.nextSequence).toBe(1)
		expect(agentControlStateSchema.safeParse(state).success).toBe(true)
		const emptyPayload = buildAgentControlBenchmarkFixture({ retainedAgentCount: 1, mailboxPayloadBytes: 0 })
		expect(emptyPayload.state.mailbox[0].payload).toEqual({ body: "" })
		const noHistory = buildAgentControlBenchmarkFixture({
			retainedAgentCount: 1,
			mailboxEntriesPerAgent: 0,
			verificationObligationsPerAgent: 0,
		})
		expect(noHistory.state.mailbox).toEqual([])
		expect(noHistory.state.verificationObligations).toEqual([])
	})

	it.each([
		{ retainedAgentCount: -1 },
		{ retainedAgentCount: 1.5 },
		{ retainedAgentCount: Number.MAX_SAFE_INTEGER + 1 },
		{ retainedAgentCount: 1, projectCount: 0 },
		{ retainedAgentCount: 1, mailboxEntriesPerAgent: -1 },
		{ retainedAgentCount: 1, mailboxPayloadBytes: Number.NaN },
		{ retainedAgentCount: 1, verificationObligationsPerAgent: -1 },
		{ retainedAgentCount: 1, ownerId: "invalid/owner" },
	])("rejects invalid sizing or ownership: %j", (options) => {
		expect(() => buildAgentControlBenchmarkFixture(options)).toThrow()
	})

	it("loads without recovery and supports no-op root registration and reservation settlement", async () => {
		const fixture = buildAgentControlBenchmarkFixture({ retainedAgentCount: 3, projectCount: 2 })
		const backing = new InMemoryAgentControlPersistence(fixture.state)
		const persistence: AgentControlPersistence = {
			read: () => backing.read(),
			write: vi.fn((state) => backing.write(state)),
			withTransaction: (operation) => operation(),
			acquireOwnerLease: vi.fn(async () => {}),
			isOwnerLeaseLive: async (ownerId) => ownerId === fixture.options.ownerId,
			tryRevokeOwnerLease: vi.fn(async () => false),
			releaseOwnerLease: vi.fn(async () => {}),
		}
		const store = new AgentControlStore(persistence, () => AGENT_CONTROL_BENCHMARK_TIMESTAMP + 1, {
			ownerId: fixture.options.ownerId,
		})
		try {
			await store.initialize()
			expect(store.getSnapshot()).toEqual(fixture.state)
			expect(await store.recoverAbandonedOwners()).toBe(0)
			expect(persistence.write).not.toHaveBeenCalled()
			for (const { rootTaskId, workspacePath } of fixture.projects) {
				await store.ensureRoot({ taskId: rootTaskId })
				expect(persistence.write).not.toHaveBeenCalled()
				await store.reservePrimaryMutation(rootTaskId, rootTaskId, workspacePath, "benchmark-reservation")
				expect(store.getVerificationObligations({ parentTaskId: rootTaskId })).toContainEqual(
					expect.objectContaining({
						id: `primary-change:${rootTaskId}`,
						mutationReservations: ["benchmark-reservation"],
					}),
				)
				await store.releasePrimaryMutation(rootTaskId, rootTaskId, "benchmark-reservation")
				expect(store.getSnapshot()).toEqual({
					...fixture.state,
					updatedAt: AGENT_CONTROL_BENCHMARK_TIMESTAMP + 1,
				})
				vi.mocked(persistence.write).mockClear()
			}
		} finally {
			await store.shutdown()
		}
	})
})
