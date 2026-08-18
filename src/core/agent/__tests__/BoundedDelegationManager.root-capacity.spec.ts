import { BoundedDelegationManager, type InternalTaskResult } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../InternalTaskEnvelope"

const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: true,
	network: false,
	externalSideEffects: false,
	requireApproval: false,
}

function envelope(id: string, rootTaskId: string, parentTaskId: string, depth: number) {
	return buildInternalTaskEnvelope({
		id,
		rootTaskId,
		parentTaskId,
		depth,
		objective: `Inspect ${id}`,
		agentKind: "explore",
		parentPolicy: policy,
		requestedPolicy: { read: true, delegate: depth < 3 },
		workspaceRoots: ["F:/workspace"],
		budget: { maxDepth: 3, maxConcurrency: 2 },
	})
}

function result(taskId: string): Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification"> {
	return {
		taskId,
		status: "completed",
		summary: `${taskId} complete`,
		evidence: [],
		changedFiles: [],
		verification: [],
		remainingRisks: [],
		usage: { durationMs: 1 },
	}
}

describe("BoundedDelegationManager root-wide capacity", () => {
	it("counts descendants against one root cap without serializing another root", async () => {
		const releases = new Map<string, () => void>()
		const started: string[] = []
		const activeByRoot = new Map<string, number>()
		const peakByRoot = new Map<string, number>()
		const manager = new BoundedDelegationManager(
			async (item) => {
				const rootTaskId = item.rootTaskId ?? item.parentTaskId
				started.push(item.id)
				const active = (activeByRoot.get(rootTaskId) ?? 0) + 1
				activeByRoot.set(rootTaskId, active)
				peakByRoot.set(rootTaskId, Math.max(peakByRoot.get(rootTaskId) ?? 0, active))
				await new Promise<void>((resolve) => releases.set(item.id, resolve))
				activeByRoot.set(rootTaskId, (activeByRoot.get(rootTaskId) ?? 1) - 1)
				return result(item.id)
			},
			(item) => item.budget.maxConcurrency,
		)

		const direct = manager.run(envelope("direct", "root-1", "root-1", 1))
		const grandchild = manager.run(envelope("grandchild", "root-1", "direct", 2))
		const queuedDescendant = manager.run(envelope("queued-descendant", "root-1", "grandchild", 3))
		const otherRoot = manager.run(envelope("other-root-child", "root-2", "root-2", 1))

		await vi.waitFor(() => expect(releases.size).toBe(3))
		expect(started).toEqual(["direct", "grandchild", "other-root-child"])
		expect(peakByRoot).toEqual(
			new Map([
				["root-1", 2],
				["root-2", 1],
			]),
		)

		releases.get("direct")!()
		await expect(direct).resolves.toMatchObject({ status: "completed" })
		await vi.waitFor(() => expect(releases.has("queued-descendant")).toBe(true))
		expect(started).toEqual(["direct", "grandchild", "other-root-child", "queued-descendant"])

		for (const id of ["grandchild", "queued-descendant", "other-root-child"]) releases.get(id)!()
		await expect(Promise.all([grandchild, queuedDescendant, otherRoot])).resolves.toEqual([
			expect.objectContaining({ taskId: "grandchild", status: "completed" }),
			expect.objectContaining({ taskId: "queued-descendant", status: "completed" }),
			expect.objectContaining({ taskId: "other-root-child", status: "completed" }),
		])
		expect(peakByRoot.get("root-1")).toBe(2)
	})
})
