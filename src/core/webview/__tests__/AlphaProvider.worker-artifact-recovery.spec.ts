import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { managedSubagentWorktreeService, type ManagedWorkerArtifact } from "@alpha-code/core"
import type {
	AgentRecord,
	AgentRuntimeSnapshot,
	AlphaMessage,
	HistoryItem,
	SubagentGroupState,
} from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"

vi.mock("../../task-persistence/taskMessages", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../task-persistence/taskMessages")>()
	return { ...actual, saveTaskMessages: vi.fn(actual.saveTaskMessages) }
})

type RecoverArtifacts = (this: AlphaProvider, hasTaskOwner?: (taskId: string) => boolean) => Promise<void>
const recoverArtifacts = Reflect.get(AlphaProvider.prototype, "recoverManagedWorkerArtifacts") as RecoverArtifacts
const toSnapshot = Reflect.get(AlphaProvider.prototype, "toAgentRuntimeSnapshot") as (
	this: AlphaProvider,
	agent: SubagentGroupState["agents"][number],
) => AgentRuntimeSnapshot
const activeRunId = "worker:current-run"

describe("AlphaProvider Worker artifact projection recovery", () => {
	let storage: string

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-artifact-recovery-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		const target = path.resolve(storage)
		expect(path.dirname(target)).toBe(path.resolve(os.tmpdir()))
		expect(path.basename(target)).toMatch(/^alpha-provider-artifact-recovery-/)
		await fs.rm(target, { recursive: true, force: true })
	})

	function proposal(
		id = "current-artifact",
		groupId = "current-group",
		runId = activeRunId,
	): ManagedWorkerArtifact & { groupId: string; runId: string } {
		return {
			id,
			taskId: "worker",
			groupId,
			runId,
			status: "pending_review",
			createdAt: 10,
			updatedAt: 20,
			gitRoot: storage,
			logicalWorkspace: storage,
			logicalWorkspaceFromRoot: "",
			baselineCommit: "baseline",
			writeScope: ["src"],
			gitRelativeScope: ["src"],
			fileWriteScope: [],
			gitRelativeFileScope: [],
			changes: [{ status: "M", path: "src/value.ts", binary: false }],
			partial: true,
		}
	}

	function group(groupId = "current-group"): SubagentGroupState {
		return {
			groupId,
			parentTaskId: "parent",
			executionMode: "async",
			status: "running",
			createdAt: 5,
			startedAt: 6,
			agents: [
				{
					taskId: "worker",
					nickname: "Worker",
					role: "worker",
					objective: "Implement the current correction",
					status: "running",
					summary: "Latest report",
					usage: { durationMs: 12, inputTokens: 34 },
				},
			],
		}
	}

	async function fixture(groups = [group()], artifacts: ManagedWorkerArtifact[] = [proposal()]) {
		const history: HistoryItem = {
			id: "worker",
			number: 2,
			ts: 1,
			task: "Current worker task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			taskKind: "subagent",
			rootTaskId: "parent",
			parentTaskId: "parent",
			subagentGroupId: "current-group",
			status: "active",
			approvalMode: "bypass",
			subagentDelegationPolicy: "explicit-only",
		}
		const record: AgentRecord = {
			taskId: "worker",
			path: "/root/worker",
			parentPath: "/root",
			parentTaskId: "parent",
			rootTaskId: "parent",
			groupId: "current-group",
			nickname: "Worker",
			role: "worker",
			objective: "Implement the current correction",
			status: "interrupted",
			createdAt: 1,
			updatedAt: 20,
			snapshot: {
				summary: "Retained runtime report",
				metadata: { workerArtifactId: "current-artifact", workerRunId: activeRunId, preserved: "evidence" },
			},
		}
		const histories = new Map([[history.id, history]])
		const upsert = vi.fn(async (item: HistoryItem) => {
			histories.set(item.id, structuredClone(item))
		})
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			context: { globalStorageUri: { fsPath: storage } },
			taskHistoryStore: {
				get: (taskId: string) => (taskId === "parent" ? { id: "parent" } : histories.get(taskId)),
				upsert,
			},
			agentControlStore: { getAgent: () => record },
			getLiveTask: vi.fn(() => undefined),
			log: vi.fn(),
		}) as AlphaProvider
		await saveTaskMessages({
			taskId: "parent",
			globalStoragePath: storage,
			messages: groups.map(
				(subagentGroup, index): AlphaMessage => ({
					ts: index + 1,
					type: "say",
					say: "subagent_group",
					subagentGroup,
				}),
			),
		})
		vi.mocked(saveTaskMessages).mockClear()
		vi.spyOn(managedSubagentWorktreeService, "recoverOrphans").mockImplementation(async () =>
			structuredClone(artifacts),
		)
		const apply = vi.spyOn(managedSubagentWorktreeService, "apply")
		const readGroups = async () =>
			(await readTaskMessages({ taskId: "parent", globalStoragePath: storage })).map(
				(message) => message.subagentGroup!,
			)
		return { provider, history, histories, record, upsert, apply, readGroups }
	}

	it.each([true, false])("retains artifact ownership only in its matching run snapshot (match=%s)", (matches) => {
		const artifact = proposal()
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			subagentDescriptors: new Map([["worker", { groupId: "current-group", managedWorktree: { artifact } }]]),
			asyncSubagentRunManager: { getRunId: () => (matches ? activeRunId : "worker:next-run") },
		}) as AlphaProvider
		const snapshot = toSnapshot.call(provider, group().agents[0])
		expect(snapshot.metadata?.workerArtifactId).toBe(matches ? artifact.id : undefined)
		expect(snapshot.metadata?.workerRunId).toBe(matches ? activeRunId : undefined)
		expect(snapshot.summary).toBe("Latest report")
		expect(snapshot.usage).toEqual({ durationMs: 12, inputTokens: 34 })
	})

	it("projects a captured current attempt once and preserves its permissions, report, and partial truth", async () => {
		const captured = proposal()
		captured.partial = false
		const fixtureState = await fixture([group()], [captured])
		const snapshot = structuredClone(fixtureState.record.snapshot)
		await recoverArtifacts.call(fixtureState.provider)
		const first = await fixtureState.readGroups()
		await recoverArtifacts.call(fixtureState.provider)
		expect(await fixtureState.readGroups()).toEqual(first)
		expect(first[0].agents[0]).toMatchObject({
			status: "interrupted",
			summary: "Latest report",
			usage: { durationMs: 12, inputTokens: 34 },
			changeSet: { id: captured.id, status: "pending_review", partial: false },
		})
		expect(fixtureState.histories.get("worker")).toMatchObject({
			approvalMode: "bypass",
			subagentDelegationPolicy: "explicit-only",
		})
		expect(fixtureState.record.snapshot).toEqual(snapshot)
		expect(fixtureState.upsert).toHaveBeenCalledOnce()
		expect(saveTaskMessages).toHaveBeenCalledOnce()
		expect(fixtureState.apply).not.toHaveBeenCalled()
	})

	it("retries the same proposal after the first parent save fails without rewriting child history again", async () => {
		const fixtureState = await fixture()
		vi.mocked(saveTaskMessages).mockRejectedValueOnce(new Error("Controlled parent projection failure"))
		await recoverArtifacts.call(fixtureState.provider)
		expect((await fixtureState.readGroups())[0].agents[0].changeSet).toBeUndefined()
		await recoverArtifacts.call(fixtureState.provider)
		const recovered = await fixtureState.readGroups()
		await recoverArtifacts.call(fixtureState.provider)
		expect((await fixtureState.readGroups())[0]).toEqual(recovered[0])
		expect(recovered[0].agents[0].changeSet?.id).toBe("current-artifact")
		expect(fixtureState.upsert).toHaveBeenCalledOnce()
		expect(saveTaskMessages).toHaveBeenCalledTimes(2)
		expect(fixtureState.apply).not.toHaveBeenCalled()
	})

	it("recovers the second generation without changing the original completed card or latest history ownership", async () => {
		const original = group("original-group")
		original.status = "completed"
		original.agents[0].status = "completed"
		original.agents[0].stopReason = "completed"
		original.agents[0].summary = "Original report"
		original.agents[0].changedFiles = ["src/value.ts"]
		original.agents[0].changeSet = {
			id: "original-artifact",
			status: "applied",
			changedFiles: ["src/value.ts"],
			createdAt: 10,
			updatedAt: 20,
			partial: true,
		}
		const oldArtifact = {
			...proposal("original-artifact", "original-group", "worker:original-run"),
			status: "applied" as const,
		}
		const fixtureState = await fixture([original, group()], [proposal(), oldArtifact])
		await recoverArtifacts.call(fixtureState.provider)
		const recovered = await fixtureState.readGroups()
		expect(recovered[0]).toEqual(original)
		expect(recovered[1].agents[0]).toMatchObject({
			status: "interrupted",
			summary: "Latest report",
			changeSet: { id: "current-artifact" },
		})
		expect(fixtureState.histories.get("worker")).toMatchObject({
			subagentGroupId: "current-group",
			subagentChangeSet: { id: "current-artifact" },
		})
		expect(fixtureState.apply).not.toHaveBeenCalled()
	})

	it.each(["current-first", "previous-first"] as const)(
		"does not project an old artifact over a later run that reuses the same group (%s)",
		async (order) => {
			const oldArtifact = proposal("original-artifact", "current-group", "worker:original-run")
			const current = group()
			current.agents[0].changeSet = {
				id: oldArtifact.id,
				status: "applied",
				changedFiles: ["src/value.ts"],
				createdAt: oldArtifact.createdAt,
				updatedAt: oldArtifact.updatedAt,
			}
			const artifacts = order === "current-first" ? [proposal(), oldArtifact] : [oldArtifact, proposal()]
			const fixtureState = await fixture([current], artifacts)
			fixtureState.history.subagentChangeSet = current.agents[0].changeSet
			await recoverArtifacts.call(fixtureState.provider)
			expect((await fixtureState.readGroups())[0].agents[0].changeSet?.id).toBe("current-artifact")
			expect(fixtureState.histories.get("worker")?.subagentChangeSet?.id).toBe("current-artifact")
		},
	)

	it("preserves a durable terminal outcome when only its artifact projection needs repair", async () => {
		const terminal = group()
		terminal.status = "completed"
		terminal.agents[0].status = "completed"
		terminal.agents[0].stopReason = "completed"
		const fixtureState = await fixture([terminal])
		fixtureState.history.status = "completed"
		fixtureState.history.stopReason = "completed"
		await recoverArtifacts.call(fixtureState.provider)
		expect(fixtureState.histories.get("worker")).toMatchObject({ status: "completed", stopReason: "completed" })
		expect((await fixtureState.readGroups())[0].agents[0]).toMatchObject({
			status: "completed",
			stopReason: "completed",
			summary: "Latest report",
		})
	})

	it("retains an unprojected legacy artifact without guessing which reused task generation owns it", async () => {
		const legacy = proposal()
		Reflect.deleteProperty(legacy, "groupId")
		Reflect.deleteProperty(legacy, "runId")
		const fixtureState = await fixture([group()], [legacy])
		fixtureState.record.snapshot!.metadata = { preserved: "legacy evidence" }
		await recoverArtifacts.call(fixtureState.provider)
		expect((await fixtureState.readGroups())[0]).toEqual(group())
		expect(fixtureState.upsert).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(fixtureState.provider.log).toHaveBeenCalledWith(expect.stringContaining("remain preserved"))
	})

	it("repairs an existing legacy proposal reference without replacing its terminal report", async () => {
		const legacy = proposal()
		Reflect.deleteProperty(legacy, "groupId")
		Reflect.deleteProperty(legacy, "runId")
		const retained = group()
		retained.agents[0].status = "timed_out"
		retained.agents[0].stopReason = "timeout"
		retained.agents[0].changeSet = {
			id: legacy.id,
			status: "pending_review",
			changedFiles: ["src/value.ts"],
			createdAt: legacy.createdAt,
			updatedAt: legacy.updatedAt,
		}
		const fixtureState = await fixture([retained], [{ ...legacy, status: "discarded" }])
		fixtureState.history.status = "timed_out"
		fixtureState.history.stopReason = "timeout"
		fixtureState.history.subagentChangeSet = retained.agents[0].changeSet
		fixtureState.record.snapshot!.metadata = { preserved: "legacy evidence" }
		await recoverArtifacts.call(fixtureState.provider)
		expect((await fixtureState.readGroups())[0].agents[0]).toMatchObject({
			status: "timed_out",
			stopReason: "timeout",
			summary: "Latest report",
			changeSet: { id: legacy.id, status: "discarded" },
		})
		expect(fixtureState.histories.get("worker")).toMatchObject({ status: "timed_out", stopReason: "timeout" })
	})

	it("does not attach an unprojected artifact when the recorded async run does not match", async () => {
		const fixtureState = await fixture()
		fixtureState.record.snapshot!.metadata!.workerRunId = "worker:a-different-run"
		await recoverArtifacts.call(fixtureState.provider)
		expect((await fixtureState.readGroups())[0]).toEqual(group())
		expect(fixtureState.upsert).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
	})

	it("does not recover a task that acquired a live owner after the orphan scan", async () => {
		const fixtureState = await fixture()
		await recoverArtifacts.call(fixtureState.provider, () => true)
		expect(fixtureState.upsert).not.toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
	})
})
