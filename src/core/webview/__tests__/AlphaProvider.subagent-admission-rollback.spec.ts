import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

import { afterEach, describe, expect, it, vi } from "vitest"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Finalization = { readonly promise: Promise<void> }

const fixtures: Array<{ harness: Harness; provisionalIds: string[] }> = []
const finalizations = (harness: Harness) =>
	Reflect.get(harness.provider, "subagentRunFinalizations") as Map<string, Finalization>

afterEach(async () => {
	vi.restoreAllMocks()
	for (const { harness, provisionalIds } of fixtures.splice(0)) {
		// A deliberately rejected rollback retains its ownership evidence. Repair
		// only this fixture's unlaunched rows before exercising normal disposal.
		for (const taskId of provisionalIds) {
			const record = harness.store.getAgent(taskId, harness.root.taskId)
			if (record && ["pending", "running", "cancelling"].includes(record.status)) {
				await harness.store.updateAgentStatus(taskId, "cancelled", {}, harness.root.taskId)
			}
			finalizations(harness).delete(taskId)
		}
		await harness.cleanup()
	}
})

async function prepareBatch() {
	const harness = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	const fixture = { harness, provisionalIds: [] as string[] }
	fixtures.push(fixture)
	const capacityBefore = harness.taskSessions.getAvailableTaskCapacity()
	const drafts = ["first_review", "second_review"].map((task_name) => ({
		task_name,
		objective: `Inspect ${task_name} without changing files`,
		agent_kind: "review" as const,
		fork_turns: "none" as const,
	}))
	const prepared = await harness.provider.prepareSubagentGroup(harness.root, drafts)
	fixture.provisionalIds.push(...prepared.envelopes.map(({ id }) => id))
	const [first, second] = prepared.envelopes
	return { ...harness, harness, prepared, drafts, capacityBefore, first, second }
}

describe("AlphaProvider provisional batch admission rollback", () => {
	it.each(["failure", "cancellation"] as const)(
		"settles created control rows after the second child admission ends in %s",
		async (outcome) => {
			const fixture = await prepareBatch()
			const { provider, root, store, prepared, first, second, taskSessions } = fixture
			const invoking = new AbortController()
			const failure = new Error("Second child control write failed")
			const createAgent = store.createAgent.bind(store)
			const admission = vi.spyOn(store, "createAgent").mockImplementation(async (input) => {
				if (input.taskId === second.id) {
					if (outcome === "cancellation") invoking.abort(failure)
					throw failure
				}
				return createAgent(input)
			})
			const runBatch = vi.spyOn(Reflect.get(provider, "boundedDelegationManager"), "runBatch")
			const operation = provider.runSubagentGroup(root, prepared, invoking.signal)
			const ownedFinalization = finalizations(fixture.harness).get(first.id)?.promise
			expect(ownedFinalization).toBeDefined()
			await expect(operation).rejects.toBe(failure)

			const status = outcome === "failure" ? "failed" : "cancelled"
			expect(store.getAgent(first.id, root.taskId)).toMatchObject({
				status,
				terminalResult: {
					status,
					stopReason: outcome === "failure" ? "never_launched" : "parent_cancelled",
				},
			})
			expect(store.getAgent(second.id, root.taskId)).toBeUndefined()
			expect(runBatch).not.toHaveBeenCalled()
			expect(fixture.childrenCaptured).toEqual([])
			await expect(ownedFinalization).resolves.toBeUndefined()
			expect(finalizations(fixture.harness).size).toBe(0)
			expect(taskSessions.getReservedTaskSlots(root.taskId, () => false)).toEqual({ total: 0, root: 0 })
			expect(taskSessions.getAvailableTaskCapacity()).toBe(fixture.capacityBefore)
			expect(root.alphaMessages.at(-1)?.subagentGroup).toMatchObject({
				status,
				agents: [{ status }, { status }],
			})
			await expect(provider.getParentCompletionDecision(root)).resolves.toMatchObject({ allowed: true })
			await expect(provider.cancelAgent(root, first.id)).resolves.toMatchObject({ status })
			await provider.closeAgent(root, first.id)

			// Reuse the requested names and all released capacity for real child turns.
			admission.mockRestore()
			const retry = await provider.prepareSubagentGroup(root, fixture.drafts)
			for (const { id } of retry.envelopes) fixture.queueTurn(id, `Verified ${id}`).release()
			await expect(provider.runSubagentGroup(root, retry, new AbortController().signal)).resolves.toMatchObject({
				status: "completed",
				agents: [{ status: "completed" }, { status: "completed" }],
			})
			await expect(provider.getParentCompletionDecision(root)).resolves.toMatchObject({ allowed: true })
		},
	)

	it("retains a failed durable rollback while releasing unlaunched reservations", async () => {
		const fixture = await prepareBatch()
		const { provider, root, store, prepared, first, second, taskSessions } = fixture
		const admissionFailure = new Error("Second child control write failed")
		const cleanupFailure = new Error("Provisional child rollback could not be saved")
		const createAgent = store.createAgent.bind(store)
		vi.spyOn(store, "createAgent").mockImplementation(async (input) => {
			if (input.taskId === second.id) throw admissionFailure
			return createAgent(input)
		})
		vi.spyOn(store, "updateAgentStatus").mockRejectedValue(cleanupFailure)
		const operation = provider.runSubagentGroup(root, prepared, new AbortController().signal)
		const ownedFinalization = finalizations(fixture.harness).get(first.id)?.promise
		await expect(operation).rejects.toBe(cleanupFailure)
		await expect(ownedFinalization).rejects.toBe(cleanupFailure)
		expect(finalizations(fixture.harness).get(first.id)?.promise).toBe(ownedFinalization)
		expect(store.getAgent(first.id, root.taskId)).toMatchObject({ status: "pending" })
		expect(store.getAgent(second.id, root.taskId)).toBeUndefined()
		expect(fixture.childrenCaptured).toEqual([])
		expect(taskSessions.getReservedTaskSlots(root.taskId, () => false)).toEqual({ total: 0, root: 0 })
		expect(taskSessions.getAvailableTaskCapacity()).toBe(fixture.capacityBefore)
		await expect(provider.getParentCompletionDecision(root)).resolves.toMatchObject({ allowed: false })
	})
})
