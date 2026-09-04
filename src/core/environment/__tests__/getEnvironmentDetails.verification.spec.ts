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

	it("delivers the primary change ID on the next snapshot before any check and suppresses an unchanged delta", async () => {
		const initial = await capture()
		expect(initial.details).not.toContain("# Workspace Verification")
		initial.commit()

		const pending = await recordMutation()
		expect(pending).toMatchObject({ changeSetId, status: "pending" })
		expect(pending?.verification).toBeUndefined()
		const next = await capture()
		expect(next.details).toContain("# Environment Changes")
		expect(next.details).toContain("# Workspace Verification")
		expect(next.details).toContain(`${changeSetId} (version ${pending?.contentVersion}, pending)`)
		expect(next.details).toContain("verification.change_set_ids")
		expect(next.details).toContain("src/changed.ts")
		next.commit()

		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.commit()
	})

	it("clears pending context once after durable satisfaction and omits it from the next full snapshot", async () => {
		const pending = (await recordMutation())!
		const initial = await capture()
		expect(initial.details).toContain(changeSetId)
		initial.commit()

		await store.recordParentVerificationEvidence(
			taskId,
			[
				{
					toolCallId: "check-call",
					executionId: "physical-check",
					status: "succeeded",
					exitCode: 0,
					startedAt: 2_100,
					completedAt: 2_200,
					command: "pnpm test",
					cwd: workspacePath,
					verificationChangeSetIds: [changeSetId],
					verificationVersions: {
						[changeSetId]: {
							contentVersion: pending.contentVersion!,
							contentFingerprint: pending.contentFingerprint!,
							scopePath: workspacePath,
							commandDigest: "command-digest",
							repositoryDigest: "repository-digest",
						},
					},
				},
			],
			taskId,
		)
		store = new AgentControlStore(persistence)
		await store.initialize()
		Object.assign(provider, { agentControlStore: store })
		expect(store.getVerificationObligations({ parentTaskId: taskId })).toEqual([
			expect.objectContaining({ changeSetId, status: "satisfied" }),
		])

		const cleared = await capture()
		expect(cleared.details).toBe(
			"<environment_details>\n# Environment Changes\n# Workspace Verification\n(none; previous value no longer applies)\n</environment_details>",
		)
		cleared.commit()
		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.commit()

		context.reset()
		const full = await capture()
		expect(full.details).toContain("# Environment Snapshot")
		expect(full.details).not.toContain("# Workspace Verification")
		full.release()
	})

	it("restores pending IDs in a full snapshot after a context reset", async () => {
		const pending = await recordMutation()
		const initial = await capture()
		initial.commit()
		context.reset()

		const restored = await capture()
		expect(restored.details).toContain("# Environment Snapshot")
		expect(restored.details).toContain("# Workspace Verification")
		expect(restored.details).toContain(`${changeSetId} (version ${pending?.contentVersion}, pending)`)
		restored.commit()
		const unchanged = await capture()
		expect(unchanged.details).toBe("")
		unchanged.release()
	})
})
