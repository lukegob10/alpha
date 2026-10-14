import { BoundedDelegationManager } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope } from "../InternalTaskEnvelope"

const envelope = (id: string) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "root",
		objective: `Inspect ${id}`,
		parentPolicy: {
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: false,
		},
		requestedPolicy: {},
		workspaceRoots: ["F:/workspace"],
	})

const result = (taskId: string) => ({
	taskId,
	status: "completed" as const,
	summary: "Inspected",
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1 },
})

describe("BoundedDelegationManager result contract", () => {
	it("fails a mismatched runner result without repeating the child in a batch", async () => {
		const runner = vi.fn(async (): Promise<ReturnType<typeof result>> => {
			if (runner.mock.calls.length > 1) throw new Error("Unexpected repeated execution")
			return result("foreign-task")
		})
		const manager = new BoundedDelegationManager(runner, 1)

		await expect(manager.runBatch([envelope("child")])).resolves.toEqual([
			expect.objectContaining({
				taskId: "child",
				status: "failed",
				stopReason: "failed",
				summary: "Sub-agent runner returned task foreign-task for handle child",
			}),
		])
		expect(runner).toHaveBeenCalledOnce()
		await expect(manager.run(envelope("next"))).resolves.toMatchObject({ taskId: "next", status: "failed" })
	})

	it("retains authority denial as the default terminal cause", async () => {
		const manager = new BoundedDelegationManager(async (item) => ({ ...result(item.id), status: "denied" }))

		await expect(manager.run(envelope("child"))).resolves.toMatchObject({
			taskId: "child",
			status: "denied",
			stopReason: "authority_denied",
		})
	})

	it("retains cancelled capacity until physical settlement and preserves completed writes", async () => {
		let announceStarted!: () => void
		const started = new Promise<void>((resolve) => (announceStarted = resolve))
		let finish!: () => void
		const invoked: string[] = []
		const manager = new BoundedDelegationManager(async (item) => {
			invoked.push(item.id)
			if (item.id === "writing") {
				announceStarted()
				await new Promise<void>((resolve) => (finish = resolve))
				return { ...result(item.id), changedFiles: ["src/task.ts"] }
			}
			return result(item.id)
		}, 1)
		const parent = new AbortController()
		const writing = manager.run(envelope("writing"), parent.signal)
		await started
		const queued = manager.run(envelope("queued"))
		parent.abort()
		await Promise.resolve()
		expect(invoked).toEqual(["writing"])
		finish()

		await expect(writing).resolves.toMatchObject({
			status: "cancelled",
			stopReason: "parent_cancelled",
			changedFiles: ["src/task.ts"],
			requiresParentVerification: true,
		})
		await expect(queued).resolves.toMatchObject({ taskId: "queued", status: "completed" })
		expect(invoked).toEqual(["writing", "queued"])
	})
})
