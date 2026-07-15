import { BoundedDelegationManager } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../InternalTaskEnvelope"
const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: false,
}
const envelope = (id: string, dependencies: string[] = []) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "p",
		objective: id,
		parentPolicy: policy,
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
		dependencies,
	})
const result = (taskId: string) => ({
	taskId,
	status: "completed" as const,
	summary: taskId,
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1 },
})
describe("bounded delegation", () => {
	it("limits concurrency and preserves requested result order", async () => {
		let active = 0,
			peak = 0
		const manager = new BoundedDelegationManager(async (item) => {
			active++
			peak = Math.max(peak, active)
			await new Promise((r) => setTimeout(r, 5))
			active--
			return result(item.id)
		})
		const output = await manager.runBatch([envelope("a"), envelope("b"), envelope("c", ["a"])])
		expect(peak).toBe(2)
		expect(output.map((item) => item.taskId)).toEqual(["a", "b", "c"])
	})
	it("marks child mutation for parent verification", async () => {
		const manager = new BoundedDelegationManager(async (item) => ({
			...result(item.id),
			changedFiles: ["src/a.ts"],
		}))
		expect((await manager.run(envelope("a"))).requiresParentVerification).toBe(true)
	})
	it("rejects children that can delegate", async () => {
		const manager = new BoundedDelegationManager(async (item) => result(item.id))
		await expect(manager.run({ ...envelope("a"), policy: { ...policy, delegate: true } })).rejects.toThrow("depth")
	})
})
