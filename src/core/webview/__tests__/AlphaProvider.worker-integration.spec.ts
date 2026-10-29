import fs from "node:fs/promises"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { managedSubagentWorktreeService } from "@alpha-code/core"
import type { ApprovalMode } from "@alpha-code/types"

import { createManagedPublicLifecycleHarness, deferred } from "./managedPublicLifecycleHarness"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
const fixtures: Harness[] = []

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function startWorker(
	approvalMode: ApprovalMode = "auto",
	options: { writeScope?: string[]; initialFiles?: Record<string, string> } = {},
) {
	const fixture = await createManagedPublicLifecycleHarness()
	fixtures.push(fixture)
	fixture.settings.approvalMode = approvalMode
	fixture.root.setTaskApprovalMode(approvalMode)
	await fs.mkdir(path.join(fixture.root.cwd, "docs"))
	for (const [relativePath, content] of Object.entries(options.initialFiles ?? {})) {
		const absolutePath = path.join(fixture.root.cwd, relativePath)
		await fs.mkdir(path.dirname(absolutePath), { recursive: true })
		await fs.writeFile(absolutePath, content)
	}
	const prepared = await fixture.provider.prepareSubagentGroup(fixture.root, [
		{
			task_name: "implementation",
			objective: "Create docs/worker.txt with the implementation notes.",
			agent_kind: "worker",
			write_scope: options.writeScope ?? ["docs/worker.txt"],
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
		fixture.root.setTaskApprovalMode("ask")

		const result = await fixture.finish()

		expect(result?.changeSet?.status).toBe("pending_review")
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it.each(["ask", "auto"] as const)(
		"integrates approved Full Access work when the unrelated default changes to %s",
		async (approvalMode) => {
			const fixture = await startWorker("bypass")
			fixture.settings.approvalMode = approvalMode

			const result = await fixture.finish()

			expect(result).toMatchObject({ status: "completed", changeSet: { status: "applied" } })
			expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
				"worker implementation\n",
			)
		},
		30_000,
	)

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

describe("interrupted Worker recovery integration", () => {
	it("applies interrupted Full Access effects once while preserving interruption and pending verification", async () => {
		const fixture = await startWorker("bypass")
		const apply = vi.spyOn(managedSubagentWorktreeService, "apply")
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

		const result = await fixture.finish()
		await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)
		await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

		expect(result).toMatchObject({ status: "interrupted", stopReason: "interrupted", changeSet: { partial: true } })
		expect(fixture.prepared.group.agents[0]).toMatchObject({
			status: "interrupted",
			stopReason: "interrupted",
			changeSet: { status: "applied", partial: true },
			parentVerification: { status: "pending" },
		})
		expect(fixture.store.getVerificationObligations({ parentTaskId: fixture.root.taskId })).toMatchObject([
			{ status: "pending", review: { decision: "approved", source: "apply" } },
		])
		expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
			"worker implementation\n",
		)
		expect(apply).toHaveBeenCalledOnce()
	}, 30_000)

	it.each(["ask", "auto"] as const)(
		"retains partial effects captured under %s without widening to later Full Access",
		async (approvalMode) => {
			const fixture = await startWorker(approvalMode)
			fixture.root.setTaskApprovalMode("bypass")
			expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

			const result = await fixture.finish()
			await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

			expect(result).toMatchObject({
				status: "interrupted",
				changeSet: { status: "pending_review", partial: true },
			})
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
		30_000,
	)

	it.each(["ask", "auto"] as const)(
		"retains interrupted Full Access work when the parent task narrows to %s",
		async (approvalMode) => {
			const fixture = await startWorker("bypass")
			fixture.root.setTaskApprovalMode(approvalMode)
			expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

			const result = await fixture.finish()
			await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

			expect(result?.changeSet).toMatchObject({ status: "pending_review", partial: true })
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
		30_000,
	)

	it.each(["user_cancelled", "parent_cancelled", "ancestor_cancelled"] as const)(
		"retains %s partial effects even in Full Access",
		async (stopReason) => {
			const fixture = await startWorker("bypass")
			expect(
				fixture.runs.cancel(
					fixture.child.taskId,
					"Explicit cancellation must retain recoverable work",
					stopReason === "user_cancelled" ? "cancelled" : stopReason,
				),
			).toBe(true)

			const result = await fixture.finish()
			await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

			expect(result).toMatchObject({
				status: "cancelled",
				changeSet: { status: "pending_review", partial: true },
			})
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
		30_000,
	)

	it("preserves external changes and leaves an interrupted proposal conflicted", async () => {
		const fixture = await startWorker("bypass")
		await fs.writeFile(path.join(fixture.root.cwd, "docs/worker.txt"), "external edit\n")
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

		await fixture.finish()
		await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

		expect(fixture.prepared.group.agents[0]?.changeSet).toMatchObject({ status: "conflicted", partial: true })
		expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe("external edit\n")
	}, 30_000)

	it("does not infer joined writes from an unloaded interrupted child's durable status", async () => {
		const fixture = await startWorker("bypass")
		fixture.root.setTaskApprovalMode("auto")
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)
		await fixture.finish()
		await fixture.provider.removeTaskFromStack({ taskId: fixture.child.taskId })
		fixture.root.setTaskApprovalMode("bypass")

		await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

		expect(fixture.provider.getLiveTask(fixture.child.taskId)).toBeUndefined()
		expect(fixture.prepared.group.agents[0]?.changeSet).toMatchObject({ status: "pending_review", partial: true })
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it.each(["beforeMode", "afterMode"] as const)(
		"does not infer a regular file from a legacy interrupted artifact missing %s",
		async (missingMode) => {
			const fixture = await startWorker("bypass", {
				initialFiles: { "docs/worker.txt": "original parent content\n" },
			})
			const capture = managedSubagentWorktreeService.capture.bind(managedSubagentWorktreeService)
			vi.spyOn(managedSubagentWorktreeService, "capture").mockImplementation(async (...args) => {
				const artifact = await capture(...args)
				if (artifact.taskId === fixture.child.taskId && artifact.partial) {
					for (const change of artifact.changes) delete change[missingMode]
					await fs.writeFile(
						path.join(fixture.storagePath, "subagent-change-sets", artifact.id, "metadata.json"),
						JSON.stringify(artifact),
					)
				}
				return artifact
			})
			expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

			const result = await fixture.finish()
			await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

			expect(result?.changeSet).toMatchObject({ status: "pending_review", partial: true })
			expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
				"original parent content\n",
			)
		},
		30_000,
	)

	it("does not recover interrupted work after the parent switches to Plan", async () => {
		const fixture = await startWorker("bypass")
		fixture.root.setTaskMode("architect")
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

		const result = await fixture.finish()
		await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

		expect(result?.changeSet).toMatchObject({ status: "pending_review", partial: true })
		await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
	}, 30_000)

	it.each(["docs/source.txt", "docs/renamed.txt"])(
		"rechecks ignore rules for interrupted rename path %s",
		async (ignoredPath) => {
			const fixture = await startWorker("bypass", {
				writeScope: ["docs"],
				initialFiles: { "docs/source.txt": "rename me\n" },
			})
			await fs.rename(
				path.join(fixture.child.cwd, "docs/source.txt"),
				path.join(fixture.child.cwd, "docs/renamed.txt"),
			)
			vi.spyOn(fixture.root.alphaIgnoreController!, "validateAccess").mockImplementation(
				(candidate) => candidate !== ignoredPath,
			)
			expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

			const result = await fixture.finish()
			await fixture.provider.autoApplyPendingSubagentChangeSets(fixture.root.taskId)

			expect(result?.changeSet).toMatchObject({ status: "pending_review", partial: true })
			expect(await fs.readFile(path.join(fixture.root.cwd, "docs/source.txt"), "utf8")).toBe("rename me\n")
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/renamed.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
		30_000,
	)

	it("rechecks parent Stop after interrupted recovery acquires the mutation gate", async () => {
		const fixture = await startWorker("bypass")
		const entered = deferred()
		const release = deferred()
		const runMutation = fixture.provider.runWorkspaceMutation.bind(fixture.provider)
		vi.spyOn(fixture.provider, "runWorkspaceMutation").mockImplementation((task, label, run, options) =>
			runMutation(
				task,
				label,
				async () => {
					if (label === "apply worker change set") {
						entered.resolve()
						await release.promise
					}
					return run()
				},
				options,
			),
		)
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)
		const finished = fixture.finish()
		try {
			await entered.promise
			const cancellation = fixture.root.beginTaskCancellation()
			release.resolve()
			await finished
			await cancellation.termination

			expect(fixture.prepared.group.agents[0]?.changeSet).toMatchObject({
				status: "pending_review",
				partial: true,
			})
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		} finally {
			release.resolve()
			await finished
		}
	}, 30_000)

	it("rechecks Code authority after interrupted artifact metadata is read", async () => {
		const fixture = await startWorker("bypass")
		const entered = deferred()
		const release = deferred()
		const runMutation = fixture.provider.runWorkspaceMutation.bind(fixture.provider)
		let inRecoveryGate = false
		vi.spyOn(fixture.provider, "runWorkspaceMutation").mockImplementation((task, label, run, options) =>
			runMutation(
				task,
				label,
				async () => {
					inRecoveryGate = label === "apply worker change set"
					try {
						return await run()
					} finally {
						inRecoveryGate = false
					}
				},
				options,
			),
		)
		const load = managedSubagentWorktreeService.load.bind(managedSubagentWorktreeService)
		let heldRead = false
		vi.spyOn(managedSubagentWorktreeService, "load").mockImplementation(async (...args) => {
			const artifact = await load(...args)
			if (inRecoveryGate && !heldRead && artifact.partial) {
				heldRead = true
				entered.resolve()
				await release.promise
			}
			return artifact
		})
		expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)
		const finished = fixture.finish()
		try {
			await entered.promise
			fixture.root.setTaskMode("architect")
			release.resolve()
			await finished

			expect(fixture.prepared.group.agents[0]?.changeSet).toMatchObject({
				status: "pending_review",
				partial: true,
			})
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		} finally {
			release.resolve()
			await finished
		}
	}, 30_000)
})

describe("Worker apply authority at the native Git effect", () => {
	it("preserves an explicitly approved manual Apply admitted in Ask", async () => {
		const fixture = await startWorker("bypass")
		fixture.root.setTaskApprovalMode("ask")
		await fixture.finish()
		const changeSetId = fixture.prepared.group.agents[0]?.changeSet?.id
		if (!changeSetId) throw new Error("The held Worker proposal was not captured")

		await expect(
			fixture.provider.applySubagentChangeSet(fixture.root.taskId, fixture.prepared.group.groupId, changeSetId),
		).resolves.toMatchObject({ success: true, changeSetStatus: "applied" })

		expect(await fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).toBe(
			"worker implementation\n",
		)
	}, 30_000)

	const cases = (["completed", "interrupted", "manual"] as const).flatMap((route) =>
		(["stop", "ask", "plan"] as const).map((revocation) => ({ route, revocation })),
	)

	it.each(cases)(
		"rejects $revocation during cached proof for $route application",
		async ({ route, revocation }) => {
			const fixture = await startWorker("bypass")
			if (route === "manual") {
				fixture.root.setTaskApprovalMode("ask")
				await fixture.finish()
				fixture.root.setTaskApprovalMode("bypass")
			}
			// Keep native Git and its captured-patch proof real; revoke only after the
			// owned scratch-index apply has finished and before the parent effect starts.
			type WorkerGitBoundary = { artifactGit(...args: unknown[]): Promise<string> }
			const boundary = managedSubagentWorktreeService as unknown as WorkerGitBoundary
			const artifactGit = boundary.artifactGit.bind(managedSubagentWorktreeService)
			let revoked = false
			let cancellation: ReturnType<typeof fixture.root.beginTaskCancellation> | undefined
			vi.spyOn(boundary, "artifactGit").mockImplementation(async (...args) => {
				const result = await artifactGit(...args)
				if (!revoked && Array.isArray(args[1]) && args[1].includes("--cached")) {
					revoked = true
					if (revocation === "stop") cancellation = fixture.root.beginTaskCancellation()
					else if (revocation === "ask") fixture.root.setTaskApprovalMode("ask")
					else fixture.root.setTaskMode("architect")
				}
				return result
			})
			if (route === "interrupted") expect(fixture.runs.interrupt(fixture.child.taskId)).toBe(true)

			if (route === "manual") {
				const changeSetId = fixture.prepared.group.agents[0]?.changeSet?.id
				if (!changeSetId) throw new Error("The held Worker proposal was not captured")
				await expect(
					fixture.provider.applySubagentChangeSet(
						fixture.root.taskId,
						fixture.prepared.group.groupId,
						changeSetId,
					),
				).resolves.toMatchObject({ success: false })
			} else {
				await fixture.finish()
			}
			await cancellation?.termination

			expect(revoked).toBe(true)
			expect(fixture.prepared.group.agents[0]?.changeSet?.status).toBe("pending_review")
			await expect(fs.readFile(path.join(fixture.root.cwd, "docs/worker.txt"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
		30_000,
	)
})
