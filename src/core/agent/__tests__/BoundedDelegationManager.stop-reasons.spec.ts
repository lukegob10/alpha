import type { SubagentStopReason } from "@alpha-code/types"

import { AsyncSubagentRunManager } from "../AsyncSubagentRunManager"
import { BoundedDelegationManager, type InternalTaskResult } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope } from "../InternalTaskEnvelope"

const envelope = (id: string, timeoutMs = 10_000) =>
	buildInternalTaskEnvelope({
		id,
		parentTaskId: "root-1",
		rootTaskId: "root-1",
		depth: 1,
		objective: `Inspect ${id}`,
		agentKind: "explore",
		parentPolicy: {
			read: true,
			execute: false,
			mutate: false,
			delegate: true,
			network: false,
			externalSideEffects: false,
			requireApproval: false,
		},
		requestedPolicy: { read: true, delegate: false },
		workspaceRoots: ["F:/workspace"],
		budget: { maxDepth: 2, timeoutMs },
	})

const completed = (taskId: string) => ({
	taskId,
	status: "completed" as const,
	summary: `${taskId} complete`,
	evidence: [],
	changedFiles: [],
	verification: [],
	remainingRisks: [],
	usage: { durationMs: 1 },
})

function blockingManager() {
	let announceStarted!: () => void
	const started = new Promise<void>((resolve) => (announceStarted = resolve))
	const manager = new BoundedDelegationManager(async (_item, signal) => {
		announceStarted()
		return await new Promise<ReturnType<typeof completed>>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true })
		})
	}, 1)
	return { manager, started }
}

describe("BoundedDelegationManager stable stop reasons", () => {
	it("normalizes ordinary completion and runner failure", async () => {
		const successful = new BoundedDelegationManager(async (item) => completed(item.id))
		await expect(successful.run(envelope("complete"))).resolves.toMatchObject({
			status: "completed",
			stopReason: "completed",
		})

		const failed = new BoundedDelegationManager(async () => {
			throw new Error("provider failed")
		})
		await expect(failed.run(envelope("failed"))).resolves.toMatchObject({
			status: "failed",
			stopReason: "failed",
			summary: "provider failed",
		})
	})

	it("reports configured timeout exhaustion deterministically", async () => {
		const { manager } = blockingManager()
		await expect(manager.run(envelope("timeout", 1))).resolves.toMatchObject({
			status: "timed_out",
			stopReason: "timeout",
		})
	})

	it("distinguishes parent cancellation and interruption", async () => {
		const parent = new AbortController()
		const parentRun = blockingManager()
		const cancelled = parentRun.manager.run(envelope("parent-cancelled"), parent.signal)
		await parentRun.started
		parent.abort(new Error("parent stopped"))
		await expect(cancelled).resolves.toMatchObject({ status: "cancelled", stopReason: "parent_cancelled" })

		const interruptedRun = blockingManager()
		const interrupted = interruptedRun.manager.run(envelope("interrupted"))
		await interruptedRun.started
		expect(interruptedRun.manager.interrupt("interrupted")).toBe(true)
		await expect(interrupted).resolves.toMatchObject({ status: "interrupted", stopReason: "interrupted" })
	})

	it.each([
		"ancestor_cancelled",
		"input_token_limit",
		"output_token_limit",
		"root_token_budget",
		"root_cost_budget",
	] as const)("preserves explicit cancellation cause %s", async (stopReason) => {
		const { manager, started } = blockingManager()
		const run = manager.run(envelope(stopReason))
		await started
		expect(manager.cancel(stopReason, `${stopReason} reached`, stopReason)).toBe(true)
		await expect(run).resolves.toMatchObject({ status: "cancelled", stopReason })
	})

	it("propagates the terminal cause through async result, snapshot, and lifecycle event", async () => {
		const bounded = blockingManager()
		const manager = new AsyncSubagentRunManager(bounded.manager)
		manager.launch(envelope("async-budget"), {
			groupId: "group-1",
			path: "/root/async-budget",
			nickname: "Async Budget",
			role: "explore",
		})
		await bounded.started
		expect(manager.cancel("async-budget", "root cost exhausted", "root_cost_budget")).toBe(true)

		const result = (await manager.waitForResult("async-budget")) as InternalTaskResult
		expect(result).toMatchObject({ status: "cancelled", stopReason: "root_cost_budget" })
		await vi.waitFor(() => expect(manager.getSnapshot("async-budget")?.status).toBe("cancelled"))
		expect(manager.getSnapshot("async-budget")?.stopReason).toBe("root_cost_budget")
		expect(manager.getEvents("async-budget").at(-1)).toMatchObject({
			type: "completed",
			snapshot: { status: "cancelled", stopReason: "root_cost_budget" satisfies SubagentStopReason },
		})
	})
})
