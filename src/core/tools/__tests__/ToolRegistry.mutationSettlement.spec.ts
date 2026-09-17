import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { AgentControlStore, FileAgentControlPersistence } from "../../agent/AgentControlStore"
import { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { writeToFileTool } from "../WriteToFileTool"
import type { ToolCallbacks } from "../BaseTool"
import { fingerprintContent } from "../contentVersion"
import i18next from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"

// The production loader deliberately skips resources in unit tests. Exercise the real localized guidance here.
beforeAll(() => i18next.addResourceBundle("en", "common", common))

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const dispose of disposals.splice(0).reverse()) await dispose()
})

async function fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-receipt-regression-"))
	disposals.push(() => rm(directory, { recursive: true, force: true }))
	const persistence = new FileAgentControlPersistence(directory)
	const store = new AgentControlStore(persistence)
	await store.initialize()
	disposals.push(() => store.shutdown())
	const taskId = "receipt-regression"
	await store.ensureRoot({ taskId, objective: "Build interactive HTML", status: "running" })
	const owner = {
		getParentCompletionDecision: () => store.getParentCompletionDecision(taskId, taskId),
		recordParentVerificationEvidence: async () => undefined,
		runWorkspaceMutation: async (_task: Task, _label: string, run: () => Promise<void>) => run(),
		reservePrimaryMutation: (_task: Task, token: string) =>
			store.reservePrimaryMutation(taskId, taskId, directory, token),
		releasePrimaryMutation: (_task: Task, token: string) => store.releasePrimaryMutation(taskId, taskId, token),
		recordPrimaryMutation: async (
			_task: Task,
			fileVersions: Record<string, string>,
			scopeUnresolved: boolean,
			reservationToken: string,
		) =>
			Boolean(
				await store.recordPrimaryMutation({
					parentTaskId: taskId,
					rootTaskId: taskId,
					workspacePath: directory,
					fileVersions,
					scopeUnresolved,
					reservationToken,
				}),
			),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId,
		taskKind: "primary",
		workspacePath: directory,
		abort: false,
		providerRef: new WeakRef(owner),
		currentStreamingDidCheckpoint: true,
		canMutateWorkspace: () => true,
		commandExecutionEvidence: new Map(),
		completionRuntimeRevision: 0,
		pendingCommandVerificationCount: 0,
		pendingCommandVerification: Promise.resolve(),
		beginAgentWait: () => ({ signal: new AbortController().signal, dispose: () => undefined }),
		waitForRequestControl: (operation: Promise<unknown>) => operation,
	}) as Task
	vi.spyOn(task, "suspendAfterCurrentTurn")
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		toolCallId: "html-edit",
	}
	vi.spyOn(writeToFileTool, "handle").mockImplementation(async () => {
		await writeFile(path.join(directory, "index.html"), "<button>Interactive HTML</button>")
		callbacks.pushToolResult("File saved")
	})
	const execute = () =>
		new ToolRegistry().resolve("write_to_file")!.execute({
			task,
			call: {
				type: "tool_use",
				id: "html-edit",
				name: "write_to_file",
				params: { path: "index.html" },
				nativeArgs: { path: "index.html", content: "<button>Interactive HTML</button>" },
				partial: false,
			},
			callbacks,
		})
	return { directory, persistence, store, owner, task, callbacks, execute }
}

describe("file mutation receipt settlement", () => {
	it("settles the exact admitted receipt durably after a file write", async () => {
		const f = await fixture()
		await f.execute()
		const decision = await f.store.getParentCompletionDecision(f.task.taskId, f.task.taskId)
		expect(decision.allowed).toBe(true)
		expect(f.store.getSnapshot().verificationObligations[0]?.mutationReservations).toEqual([])
		expect(f.task.suspendAfterCurrentTurn).not.toHaveBeenCalled()
	})

	it("stops at a failed receipt write instead of leaving the model to discover an orphan at completion", async () => {
		const f = await fixture()
		const original = f.owner.recordPrimaryMutation
		vi.spyOn(f.owner, "recordPrimaryMutation").mockImplementationOnce(async (...args) => {
			// The real file edit and reservation already happened; fail only the durable final receipt.
			vi.spyOn(f.persistence, "write").mockRejectedValueOnce(
				Object.assign(new Error("receipt write unavailable"), { code: "EBUSY" }),
			)
			return original(...args)
		})
		await expect(f.execute()).rejects.toThrow("receipt write unavailable")
		expect(await readFile(path.join(f.directory, "index.html"), "utf8")).toContain("Interactive HTML")
		const decision = await f.store.getParentCompletionDecision(f.task.taskId, f.task.taskId)
		expect(decision.allowed).toBe(false)
		expect(decision.blockingObligations?.[0].mutationReservations).toEqual(["html-edit"])
		expect(decision.message).toContain("admitted mutation still needs its final content receipt")
		expect(f.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
		expect(f.task.shouldStopRepeatedToolCall("execute_command", { command: "node --version" })).toBe(true)
		expect(f.callbacks.setResultMetadata).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
	})

	it("also stops when releasing a no-op receipt fails", async () => {
		const f = await fixture()
		await writeFile(path.join(f.directory, "index.html"), "<button>Interactive HTML</button>")
		vi.spyOn(f.owner, "releasePrimaryMutation").mockRejectedValueOnce(new Error("release unavailable"))
		await expect(f.execute()).rejects.toThrow("release unavailable")
		expect(f.task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
		expect(f.store.getSnapshot().verificationObligations[0]?.mutationReservations).toEqual(["html-edit"])
	})

	it("identifies an orphaned receipt even after a successful later Node command", async () => {
		const f = await fixture()
		vi.spyOn(f.owner, "recordPrimaryMutation").mockRejectedValueOnce(new Error("receipt write unavailable"))
		await expect(f.execute()).rejects.toThrow("receipt write unavailable")
		// A loaded task has no original publisher. A later successful command cannot settle a different token.
		f.task.beginCommandExecution("later-node", "later-process", "node --version")
		await promisify(execFile)(process.execPath, ["--version"], { cwd: f.directory, windowsHide: true })
		f.task.completeCommandExecution("later-node", { exitCode: 0 }, "later-process")
		await Promise.resolve()
		vi.useFakeTimers()
		try {
			const waiting = f.task.waitForCompletionGateDecision()
			await vi.advanceTimersByTimeAsync(31_000)
			const decision = await waiting
			expect(decision.reasonCode).toBe("runtime_timeout")
			expect(decision.message).toContain("receipt is still missing after 30 seconds")
			expect(decision.message).toContain("No active operation is tracked for the missing receipt")
			expect(decision.message).not.toContain("Resume after the existing operation settles")
			expect(decision.message).not.toContain("Let the runtime settle")
			expect(f.store.getSnapshot().verificationObligations[0]?.mutationReservations).toEqual(["html-edit"])
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps the original missing receipt after later successful edits grow the change set and the store reloads", async () => {
		const f = await fixture()
		const recordFiles = async (files: string[], token: string) => {
			await f.store.reservePrimaryMutation(f.task.taskId, f.task.taskId, f.directory, token)
			const fileVersions: Record<string, string> = {}
			for (const file of files) {
				await writeFile(path.join(f.directory, file), file)
				fileVersions[file] = fingerprintContent(file)
			}
			await f.owner.recordPrimaryMutation(f.task, fileVersions, false, token)
		}
		await recordFiles(["index.html", "app.js", "style.css", "config.json", "README.md", "build.json"], "initial")
		vi.spyOn(f.owner, "recordPrimaryMutation").mockRejectedValueOnce(new Error("receipt write unavailable"))
		await expect(f.execute()).rejects.toThrow("receipt write unavailable")
		const before = f.store.getSnapshot().verificationObligations[0]!
		expect(before.changedFiles).toHaveLength(6)
		expect(before.mutationReservations).toEqual(["html-edit"])
		// A later user turn can record its own changes, but cannot settle a different operation's token.
		await recordFiles(["tour.js", "details.html"], "later-edit")
		await f.store.shutdown()
		const reloaded = new AgentControlStore(new FileAgentControlPersistence(f.directory))
		disposals.push(() => reloaded.shutdown())
		await reloaded.initialize()
		const after = reloaded.getSnapshot().verificationObligations[0]!
		expect(after.changeSetId).toBe(before.changeSetId)
		expect(after.contentVersion).toBeGreaterThan(before.contentVersion!)
		expect(after.changedFiles).toHaveLength(8)
		expect(after.mutationReservations).toEqual(["html-edit"])
		f.owner.getParentCompletionDecision = () => reloaded.getParentCompletionDecision(f.task.taskId, f.task.taskId)
		expect(await f.task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "receipt_pending",
			modelCanResolveRejection: false,
		})
		vi.useFakeTimers()
		try {
			const waiting = f.task.waitForCompletionGateDecision()
			await vi.advanceTimersByTimeAsync(31_000)
			const decision = await waiting
			expect(decision.reasonCode).toBe("runtime_timeout")
			expect(decision.message).toContain("No active operation is tracked for the missing receipt")
			expect(decision.message).toContain("Get detailed error info")
			expect(decision.message).not.toContain("Resume after the existing operation settles")
			expect(reloaded.getSnapshot().verificationObligations[0]?.mutationReservations).toEqual(["html-edit"])
		} finally {
			vi.useRealTimers()
		}
	})
})
