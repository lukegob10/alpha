import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import type { Task } from "../../task/Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { EnvironmentContext } from "../EnvironmentContext"
import { captureEnvironmentDetails } from "../getEnvironmentDetails"

vi.mock("vscode", async (importOriginal) => {
	const vscode = await importOriginal<typeof import("vscode")>()
	return {
		...vscode,
		window: { ...vscode.window, activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [] } },
	}
})

describe("environment workspace verification context", () => {
	const taskId = "verification-task"
	const changeSetId = `primary-change:${taskId}`
	const workspacePath = path.resolve("/verification-workspace")
	let persistence: InMemoryAgentControlPersistence
	let store: AgentControlStore
	let provider: ClineProvider
	let task: Task
	let context: EnvironmentContext

	beforeEach(async () => {
		persistence = new InMemoryAgentControlPersistence()
		store = new AgentControlStore(persistence, () => 1_000)
		await store.initialize()
		await store.ensureRoot({ taskId, objective: "Verify primary edits", status: "running" })
		provider = Object.assign(Object.create(ClineProvider.prototype), {
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			getState: async () => ({
				maxWorkspaceFiles: 0,
				maxGitStatusFiles: 0,
				includeCurrentTime: false,
				includeCurrentCost: false,
				apiConfiguration: { todoListEnabled: false },
			}),
		}) as ClineProvider
		task = {
			taskId,
			instanceId: "verification-session",
			taskKind: "primary",
			cwd: workspacePath,
			providerRef: new WeakRef(provider),
			getTaskMode: async () => "code",
			api: { getModel: () => ({ id: "offline-fixture" }) },
		} as unknown as Task
		context = new EnvironmentContext()
	})

	const recordMutation = () =>
		store.recordPrimaryMutation({
			rootTaskId: taskId,
			parentTaskId: taskId,
			workspacePath,
			fileVersions: { "src/changed.ts": "content-v1" },
			at: 2_000,
		})

	const capture = () => captureEnvironmentDetails(task, false, undefined, { context, includeTransient: false })

	it("delivers an active primary mutation reservation and clears it after its receipt is durable", async () => {
		const initial = await capture()
		expect(initial.details).not.toContain("# Workspace Verification")
		initial.commit()

		await store.reservePrimaryMutation(taskId, taskId, workspacePath, "mutation")
		const next = await capture()
		expect(next.details).toContain("# Environment Changes")
		expect(next.details).toContain("# Workspace Verification")
		expect(next.details).toContain("an admitted mutation still needs its final content receipt")
		next.commit()

		const pending = await store.recordPrimaryMutation({
			rootTaskId: taskId,
			parentTaskId: taskId,
			workspacePath,
			fileVersions: { "src/changed.ts": "content-v1" },
			reservationToken: "mutation",
			at: 2_000,
		})
		expect(pending).toMatchObject({ changeSetId, status: "pending", mutationReservations: [] })
		const cleared = await capture()
		expect(cleared.details).toContain("# Environment Changes")
		expect(cleared.details).toContain("# Workspace Verification\n(none; previous value no longer applies)")
		cleared.commit()

		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.commit()
	})

	it("retains ordinary primary receipts across reload without making them completion blockers", async () => {
		const pending = (await recordMutation())!
		const initial = await capture()
		expect(initial.details).not.toContain("# Workspace Verification")
		initial.commit()

		store = new AgentControlStore(persistence)
		await store.initialize()
		Object.assign(provider, { agentControlStore: store })
		const reloadedObligation = store.getVerificationObligations({ parentTaskId: taskId })[0]
		expect(reloadedObligation).toMatchObject({
			changeSetId,
			contentVersion: pending.contentVersion,
			status: "pending",
		})
		expect(reloadedObligation?.mutationReservations ?? []).toEqual([])
		expect(store.getParentCompletionDecision(taskId).allowed).toBe(true)

		context.reset()
		const full = await capture()
		expect(full.details).toContain("# Environment Snapshot")
		expect(full.details).not.toContain("# Workspace Verification")
		full.release()
	})

	it("restores an unresolved primary mutation in a full snapshot after a context reset", async () => {
		await store.recordPrimaryMutation({
			rootTaskId: taskId,
			parentTaskId: taskId,
			workspacePath,
			fileVersions: { "src/changed.ts": "content-v1" },
			scopeUnresolved: true,
			at: 2_000,
		})

		const restored = await capture()
		expect(restored.details).toContain("# Environment Snapshot")
		expect(restored.details).toContain("# Workspace Verification")
		expect(restored.details).toContain("mutation scope could not be observed")
		restored.commit()
		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.release()
	})
})
