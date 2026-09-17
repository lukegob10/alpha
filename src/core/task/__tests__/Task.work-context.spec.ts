import fs from "fs/promises"
import os from "os"
import path from "path"
import type { TaskWorkPlan } from "@alpha-code/types"
import { Task } from "../Task"
import { EventEmitter } from "events"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import * as workContext from "../../agent/TaskWorkContext"

describe("Task working record integration", () => {
	let root: string
	let task: Task
	let save: ReturnType<typeof vi.fn>
	let provider: {
		getParentCompletionDecision: ReturnType<typeof vi.fn>
		recordParentVerificationEvidence: ReturnType<typeof vi.fn>
	}
	const plan: TaskWorkPlan = {
		objective: "Fix behavior",
		constraints: ["Preserve API"],
		notes: [],
		checks: [
			{
				id: "behavior",
				description: "Behavioral check",
				command: "node app.js",
				cwd: null,
				paths: ["app.js"],
				reusable: true,
			},
		],
	}
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-work-context-")))
		await fs.writeFile(path.join(root, "app.js"), "console.log('okay')")
		provider = {
			getParentCompletionDecision: vi.fn(async () => ({ allowed: true })),
			recordParentVerificationEvidence: vi.fn(async () => undefined),
		}
		save = vi.fn(async () => undefined)
		task = Object.assign(Object.create(Task.prototype), {
			workspacePath: root,
			taskKind: "primary",
			commandExecutionEvidence: new Map(),
			pendingCommandVerification: Promise.resolve(),
			pendingCommandVerificationCount: 0,
			completionRuntimeRevision: 0,
			providerRef: { deref: () => provider },
			requireAlphaMessagesSaved: save,
			abort: false,
		}) as Task
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})
	it.each([false, true])(
		"cancels only this primary instance's background commands (reader settled=%s)",
		async (isSettled) => {
			const owned = Object.assign(new EventEmitter(), { executionId: "owned", isSettled, abort: vi.fn() })
			owned.abort.mockImplementation(() => {
				owned.emit("shell_execution_complete", { exitCode: 130 })
				owned.emit("completed")
			})
			const foreign = Object.assign(new EventEmitter(), { executionId: "other-instance", abort: vi.fn() })
			vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([
				{ process: owned, running: true },
				{ process: foreign },
			] as never)
			task.beginCommandExecution("owned-call", "owned", "node app.js")
			await (task as unknown as { stopActiveTaskCommands(): Promise<void> }).stopActiveTaskCommands()
			expect(owned.abort).toHaveBeenCalledOnce()
			expect(foreign.abort).not.toHaveBeenCalled()
			expect(task.getCommandExecutionEvidence()[0].status).toBe("cancelled")
		},
	)
	it("persists running evidence before launch and rejects missing, failed, and changed evidence", async () => {
		await task.updateWorkPlan(plan)
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "verification_missing",
		})
		await task.admitCommandExecution("first", "physical-1", "node app.js", root)
		expect(save).toHaveBeenLastCalledWith("acceptance check admission")
		expect(task.workContext?.receipts[0].status).toBe("running")
		expect(await task.getCompletionGateDecision()).toMatchObject({ classification: "waiting" })
		task.completeCommandExecution("first", { exitCode: 1 }, "physical-1")
		await task.getWorkContext()
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "verification_missing",
		})
		await task.admitCommandExecution("repair", "physical-2", "node app.js", root)
		task.completeCommandExecution("repair", { exitCode: 0 }, "physical-2")
		await task.getWorkContext()
		expect(save).toHaveBeenLastCalledWith("acceptance evidence")
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true })
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true })
		await fs.writeFile(path.join(root, "app.js"), "changed")
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			message: expect.stringContaining("inputs changed"),
		})
	})
	it("prioritizes a command admitted while the completion snapshot is being read", async () => {
		await task.updateWorkPlan(plan)
		provider.getParentCompletionDecision.mockImplementation(async () => {
			task.beginCommandExecution("late", "physical-late", "node app.js")
			return { allowed: true }
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			classification: "waiting",
			reasonCode: "command_running",
		})
	})
	it("serializes a background result with admission of another acceptance check", async () => {
		await task.updateWorkPlan({
			...plan,
			checks: [...plan.checks, { ...plan.checks[0], id: "second", command: "node other.js" }],
		})
		await task.admitCommandExecution("first", "physical-1", "node app.js", root)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered!: () => void
		const capturing = new Promise<void>((resolve) => {
			entered = resolve
		})
		const capture = workContext.captureAcceptanceChecks
		vi.spyOn(workContext, "captureAcceptanceChecks").mockImplementation(async (...args) => {
			entered()
			await gate
			return capture(...args)
		})
		const settle = vi.spyOn(workContext, "settleAcceptanceChecks")
		const admission = task.admitCommandExecution("second", "physical-2", "node other.js", root)
		await capturing
		task.completeCommandExecution("first", { exitCode: 0 }, "physical-1")
		await Promise.resolve()
		expect(settle).not.toHaveBeenCalled()
		release()
		await admission
		await task.getWorkContext()
		expect(task.workContext?.receipts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ checkId: "behavior", status: "passed" }),
				expect.objectContaining({ checkId: "second", status: "running" }),
			]),
		)
	})
	it("keeps a small task optional and records multiple skill identities in its durable metadata", async () => {
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true })
		await task.recordLoadedSkill("prepare", "/skills/prepare", "first")
		await task.recordLoadedSkill("finish", "/skills/finish", "second")
		expect(task.workContext?.skills.map((skill) => skill.name)).toEqual(["prepare", "finish"])
		expect(save).toHaveBeenCalledTimes(2)
		expect(await task.getWorkContext()).toContain("Saved skill identities are not instructions")
	})
})
