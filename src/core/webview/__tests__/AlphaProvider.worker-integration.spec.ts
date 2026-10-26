import fs from "node:fs/promises"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { managedSubagentWorktreeService } from "@alpha-code/core"
import type { ApprovalMode } from "@alpha-code/types"

import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
const fixtures: Harness[] = []

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function startWorker(approvalMode: ApprovalMode = "auto") {
	const fixture = await createManagedPublicLifecycleHarness()
	fixtures.push(fixture)
	fixture.settings.approvalMode = approvalMode
	fixture.root.setTaskApprovalMode(approvalMode)
	await fs.mkdir(path.join(fixture.root.cwd, "docs"))
	const prepared = await fixture.provider.prepareSubagentGroup(fixture.root, [
		{
			task_name: "implementation",
			objective: "Create docs/worker.txt with the implementation notes.",
			agent_kind: "worker",
			write_scope: ["docs/worker.txt"],
			fork_turns: "none",
		},
	])
	const taskId = prepared.envelopes[0].id
	const turn = fixture.queueTurn(taskId, "Created docs/worker.txt.")
	// This public launcher is called after the spawn approval, as in SpawnAgentTool.
	await fixture.provider.launchPreparedSubagentGroup(
		fixture.root,
		prepared,
		fixture.root.getTaskLifetimeCancellationSignal(),
	)
	const completion = fixture.runs.waitForResult(taskId)
	if (!completion) throw new Error("Worker fixture launch did not expose its terminal result channel")
	await Promise.race([
		turn.entered,
		completion.then((result) => {
			const detail = result.summary.replace(/\s+/g, " ").slice(0, 512)
			throw new Error(`Worker fixture ended before provider entry (${result.status}): ${detail}`)
		}),
	])
	const child = fixture.provider.getLiveTask(taskId)
	if (!child) throw new Error("Worker Task was not registered")
	// Simulate an already-approved child effect at the transport boundary. Real
	// capture, scope validation, integration, journals and history remain active.
	await fs.mkdir(path.join(child.cwd, "docs"), { recursive: true })
	await fs.writeFile(path.join(child.cwd, "docs/worker.txt"), "worker implementation\n")
	const finish = async () => {
		turn.release()
		const result = await fixture.runs.waitForResult(taskId)
		await fixture.settleFinalizations()
		await child.waitForTermination()
		return result
	}
	return { ...fixture, prepared, child, finish }
}

describe("completed Worker integration", () => {
	it("reports a Worker startup failure instead of waiting for unreachable provider entry", async () => {
		vi.spyOn(managedSubagentWorktreeService, "create").mockRejectedValueOnce(
			new Error("Fixture worktree startup failed"),
		)
		await expect(startWorker()).rejects.toThrow("Fixture worktree startup failed")
	})

	it.each(["ask", "auto", "bypass"] as const)(
		"integrates approved %s Worker effects before publishing a result without a second review",
		async (mode) => {
			const fixture = await startWorker(mode)
			const publishedStatuses: Array<string | undefined> = []
			const upsert = fixture.root.upsertSubagentGroup.bind(fixture.root)
			vi.spyOn(fixture.root, "upsertSubagentGroup").mockImplementation(async (group) => {
				publishedStatuses.push(group.agents[0]?.changeSet?.status)
				return upsert(group)
			})

			const result = await fixture.finish()

			expect(result).toMatchObject({ status: "completed", changeSet: { status: "applied" } })
			expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
				"worker implementation\n",
			)
			expect(publishedStatuses).not.toContain("pending_review")
			expect(fixture.prepared.group.agents[0]?.parentVerification?.blocking).toBe(false)
		},
		30_000,
	)

	it("integrates a Worker while the parent is waiting on its model response", async () => {
		const fixture = await startWorker()
		const parentTurn = fixture.queueTurn(fixture.root.taskId, "Collect the completed implementation.")
		fixture.root.start()
		await parentTurn.entered
		try {
			const result = await fixture.finish()

			expect(result?.changeSet?.status).toBe("applied")
			expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
				"worker implementation\n",
			)
		} finally {
			parentTurn.release()
		}
	}, 30_000)

	it("preserves concurrent workspace edits and retains a recoverable conflict", async () => {
		const fixture = await startWorker()
		await fs.writeFile(path.join(fixture.root.cwd, "docs/worker.txt"), "external edit\n")

		const result = await fixture.finish()

		expect(result?.changeSet?.status).toBe("conflicted")
		expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe("external edit\n")
	}, 30_000)

	it("does not integrate a Worker after the live approval mode is narrowed", async () => {
		const fixture = await startWorker()
		fixture.settings.approvalMode = "ask"

		const result = await fixture.finish()

		expect(result?.changeSet?.status).toBe("pending_review")
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it("does not integrate a Worker after the parent switches to Plan", async () => {
		const fixture = await startWorker()
		fixture.root.setTaskMode("architect")

		const result = await fixture.finish()

		expect(result?.changeSet?.status).toBe("pending_review")
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it("rechecks the parent approval mode after waiting for the mutation gate", async () => {
		const fixture = await startWorker()
		const runMutation = fixture.provider.runWorkspaceMutation.bind(fixture.provider)
		vi.spyOn(fixture.provider, "runWorkspaceMutation").mockImplementation((task, label, run, options) =>
			runMutation(
				task,
				label,
				async () => {
					if (label === "integrate completed Worker changes") fixture.root.setTaskApprovalMode("ask")
					return run()
				},
				options,
			),
		)

		const result = await fixture.finish()

		expect(result?.changeSet?.status).toBe("pending_review")
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it("retains a cancelled Worker's partial edits without automatically applying them", async () => {
		const fixture = await startWorker()
		expect(fixture.runs.cancel(fixture.child.taskId)).toBe(true)

		const result = await fixture.finish()

		expect(result).toMatchObject({ status: "cancelled", changeSet: { status: "pending_review", partial: true } })
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)
})
