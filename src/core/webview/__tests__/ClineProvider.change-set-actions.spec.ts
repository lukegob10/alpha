import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { managedSubagentWorktreeService, type ManagedWorkerArtifact } from "@alpha-code/core"
import type { SubagentGroupState } from "@alpha-code/types"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { Task } from "../../task/Task"
import { WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"
import { ClineProvider } from "../ClineProvider"

const execFileAsync = promisify(execFile)
const TEST_TIMEOUT_MS = 30_000

describe("ClineProvider Worker change-set actions", () => {
	let root: string
	let repo: string
	let storage: string

	const git = async (args: string[]) =>
		String((await execFileAsync("git", args, { cwd: repo, encoding: "utf8" })).stdout).trim()

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-provider-apply-"))
		repo = path.join(root, "repo")
		storage = path.join(root, "storage")
		await fs.mkdir(repo, { recursive: true })
		await git(["init"])
		await git(["config", "user.name", "Test User"])
		await git(["config", "user.email", "test@example.com"])
		await fs.writeFile(path.join(repo, "README.md"), "baseline\n")
		await git(["add", "-A"])
		await git(["commit", "-m", "initial"])
	}, TEST_TIMEOUT_MS)

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	}, TEST_TIMEOUT_MS)

	const createArtifact = async (content = "worker change\n") => {
		const scope = await managedSubagentWorktreeService.validateScope(repo, ["docs/worker.txt"])
		const prepared = await managedSubagentWorktreeService.create(storage, "worker-1", scope)
		await fs.mkdir(path.join(prepared.workspacePath, "docs"), { recursive: true })
		await fs.writeFile(path.join(prepared.workspacePath, "docs/worker.txt"), content)
		return managedSubagentWorktreeService.capture(storage, prepared.artifact.id)
	}

	const createHarness = async (artifact: ManagedWorkerArtifact) => {
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "parent-1", objective: "Coordinate work", status: "running" })
		await store.createAgent({
			taskId: "worker-1",
			parentTaskId: "parent-1",
			nickname: "Worker",
			role: "worker",
			objective: "Create docs/worker.txt",
			status: "completed",
		})

		const group: SubagentGroupState = {
			groupId: "group-1",
			parentTaskId: "parent-1",
			status: "completed",
			createdAt: artifact.createdAt,
			completedAt: artifact.updatedAt,
			agents: [
				{
					taskId: "worker-1",
					nickname: "Worker",
					role: "worker",
					objective: "Create docs/worker.txt",
					writeScope: ["docs/worker.txt"],
					status: "completed",
					changedFiles: ["docs/worker.txt"],
					changeSet: {
						id: artifact.id,
						status: "pending_review",
						changedFiles: ["docs/worker.txt"],
						createdAt: artifact.createdAt,
						updatedAt: artifact.updatedAt,
					},
					usage: { durationMs: 1 },
				},
			],
		}

		const parent = Object.assign(Object.create(Task.prototype), {
			taskId: "parent-1",
			taskKind: "primary",
			metadata: { task: "Coordinate work" },
			clineMessages: [{ ts: 1, type: "say", say: "subagent_group", subagentGroup: group }],
			abort: false,
			didComplete: false,
			isTaskLoopActive: true,
			activeAsk: { type: "followup", ts: 2 },
			askResponse: undefined,
			isWaitingForFirstChunk: false,
			isStreaming: false,
			presentAssistantMessageHasPendingUpdates: false,
			pendingSteerMessage: undefined,
			messageQueueService: { isEmpty: () => true },
			commandExecutionEvidence: new Map(),
			upsertSubagentGroup: vi.fn(async () => undefined),
		}) as Task

		const historyItems = new Map<string, any>([
			["parent-1", { id: "parent-1", task: "Coordinate work" }],
			["worker-1", { id: "worker-1", task: "Create docs/worker.txt", parentTaskId: "parent-1" }],
		])
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			context: { globalStorageUri: { fsPath: storage } },
			taskSessions: { getTask: (taskId: string) => (taskId === parent.taskId ? parent : undefined) },
			workspaceMutationGate: new WorkspaceMutationGate(),
			agentControlStore: store,
			agentControlStoreReady: Promise.resolve(),
			agentControlRootStatusWrites: new Map(),
			subagentDescriptors: new Map(),
			getTaskWithId: vi.fn(async (taskId: string) => ({ historyItem: historyItems.get(taskId) })),
			updateTaskHistory: vi.fn(async (item: any) => {
				historyItems.set(item.id, item)
				return [...historyItems.values()]
			}),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
			log: vi.fn(),
		}) as ClineProvider
		;(parent as any).providerRef = new WeakRef(provider)

		return { provider, parent, group, store, persistence, historyItems }
	}

	it(
		"lands the real patch, advances required to pending, survives reload, and verifies once",
		async () => {
			const artifact = await createArtifact("verified worker change\n")
			const { provider, parent, group, store, persistence, historyItems } = await createHarness(artifact)

			const first = await provider.applySubagentChangeSet("parent-1", "group-1", artifact.id)
			expect(first).toMatchObject({ success: true, changeSetStatus: "applied" })
			expect((await fs.readFile(path.join(repo, "docs/worker.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
				"verified worker change\n",
			)
			expect((await managedSubagentWorktreeService.load(storage, artifact.id)).status).toBe("applied")
			expect(group.agents[0]).toMatchObject({
				changeSet: { status: "applied" },
				parentVerification: { status: "pending", blocking: true },
			})
			expect(historyItems.get("worker-1").subagentChangeSet.status).toBe("applied")
			expect(store.getVerificationObligations({ parentTaskId: "parent-1" })).toMatchObject([
				{ status: "pending", review: { decision: "approved", source: "apply" } },
			])
			expect(
				store.getSnapshot().mailbox.filter((entry) => entry.name === "parent_verification_pending"),
			).toHaveLength(1)

			const repeated = await provider.applySubagentChangeSet("parent-1", "group-1", artifact.id)
			expect(repeated).toMatchObject({ success: true, changeSetStatus: "applied" })
			expect(
				store.getSnapshot().mailbox.filter((entry) => entry.name === "parent_verification_pending"),
			).toHaveLength(1)

			const reloaded = new AgentControlStore(persistence)
			await reloaded.initialize()
			expect(reloaded.getVerificationObligations({ parentTaskId: "parent-1" })).toMatchObject([
				{ status: "pending" },
			])

			const obligation = store.getVerificationObligations({ parentTaskId: "parent-1" })[0]!
			;(parent as any).commandExecutionEvidence.set("verify-1", {
				toolCallId: "verify-1",
				executionId: "execution-1",
				status: "succeeded",
				command: "powershell -Command Get-Content docs/worker.txt",
				startedAt: obligation.appliedAt! + 1,
				completedAt: obligation.appliedAt! + 2,
				exitCode: 0,
			})
			await provider.recordParentVerificationEvidence(parent)

			expect(store.getVerificationObligations({ parentTaskId: "parent-1" })).toMatchObject([
				{
					status: "satisfied",
					verification: { status: "passed", matchedFiles: ["docs/worker.txt"] },
				},
			])
			expect(await provider.getParentCompletionDecision(parent)).toMatchObject({ allowed: true })
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"keeps a conflicting Apply quarantined and does not create a false pending obligation",
		async () => {
			const artifact = await createArtifact()
			await fs.mkdir(path.join(repo, "docs"), { recursive: true })
			await fs.writeFile(path.join(repo, "docs/worker.txt"), "parent change\n")
			const { provider, group, store } = await createHarness(artifact)

			const result = await provider.applySubagentChangeSet("parent-1", "group-1", artifact.id)

			expect(result).toMatchObject({ success: false, changeSetStatus: "conflicted" })
			expect(await fs.readFile(path.join(repo, "docs/worker.txt"), "utf8")).toBe("parent change\n")
			expect(group.agents[0]).toMatchObject({
				changeSet: { status: "conflicted" },
				parentVerification: { status: "required", blocking: false },
			})
			expect(store.getVerificationObligations({ parentTaskId: "parent-1" })).toMatchObject([
				{ status: "required" },
			])
			expect(store.getSnapshot().mailbox.some((entry) => entry.name === "parent_verification_pending")).toBe(
				false,
			)
		},
		TEST_TIMEOUT_MS,
	)

	it(
		"discards idempotently as not_applicable without landing the patch",
		async () => {
			const artifact = await createArtifact()
			const { provider, store } = await createHarness(artifact)

			expect(await provider.discardSubagentChangeSet("parent-1", "group-1", artifact.id)).toMatchObject({
				success: true,
				changeSetStatus: "discarded",
			})
			expect(await provider.discardSubagentChangeSet("parent-1", "group-1", artifact.id)).toMatchObject({
				success: true,
				changeSetStatus: "discarded",
			})
			await expect(fs.readFile(path.join(repo, "docs/worker.txt"), "utf8")).rejects.toThrow()
			expect(store.getVerificationObligations({ parentTaskId: "parent-1" })).toMatchObject([
				{ status: "not_applicable", review: { decision: "rejected", source: "discard" } },
			])
			expect(store.getParentCompletionDecision("parent-1").allowed).toBe(true)
		},
		TEST_TIMEOUT_MS,
	)
})
