import { EventEmitter } from "events"

import type { SubagentGroupState } from "@alpha-code/types"

import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { Task } from "../Task"

describe("sub-agent task authority", () => {
	it("records ordered credential-free terminal evidence and preserves the first terminal outcome", () => {
		const child = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			commandExecutionEvidence: new Map(),
		}) as Task

		child.beginCommandExecution("call-1", "execution-1")
		child.beginCommandExecution("call-2", "execution-2")
		child.completeCommandExecution("call-1", { exitCode: 0 })
		child.failCommandExecution("call-2", "timed_out")
		child.completeCommandExecution("call-2", { exitCode: 0 })

		expect(child.hasActiveCommandExecutions()).toBe(false)
		expect(child.getCommandExecutionEvidence()).toEqual([
			expect.objectContaining({
				toolCallId: "call-1",
				executionId: "execution-1",
				status: "succeeded",
				exitCode: 0,
			}),
			expect.objectContaining({
				toolCallId: "call-2",
				executionId: "execution-2",
				status: "timed_out",
			}),
		])
	})

	it("preserves cancellation when abort emits a synchronous command completion", async () => {
		const terminalProcess = Object.assign(new EventEmitter(), { abort: vi.fn() })
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "worker-current",
			taskKind: "subagent",
			subagentRole: "worker",
			terminalProcess,
			commandExecutionEvidence: new Map(),
		}) as Task
		child.beginCommandExecution("call-1", "execution-1")
		terminalProcess.abort.mockImplementation(() => {
			child.completeCommandExecution("call-1", { exitCode: 1, signalName: "SIGTERM" })
			terminalProcess.emit("completed")
		})

		await (child as any).stopActiveWorkerCommand()

		expect(child.getCommandExecutionEvidence()).toEqual([
			expect.objectContaining({ toolCallId: "call-1", status: "cancelled" }),
		])
	})

	it("stops a backgrounded command still owned by a managed Worker", async () => {
		const backgroundProcess = Object.assign(new EventEmitter(), { abort: vi.fn() })
		backgroundProcess.abort.mockImplementation(() => backgroundProcess.emit("completed"))
		const getTerminals = vi
			.spyOn(TerminalRegistry, "getTerminals")
			.mockReturnValue([{ taskId: "worker-1", busy: true, process: backgroundProcess } as any])
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "worker-1",
			taskKind: "subagent",
			subagentRole: "worker",
			commandExecutionEvidence: new Map(),
		}) as Task
		child.beginCommandExecution("call-1", "execution-1")

		try {
			await (child as any).stopActiveWorkerCommand()
		} finally {
			getTerminals.mockRestore()
		}

		expect(backgroundProcess.abort).toHaveBeenCalledOnce()
		expect(child.getCommandExecutionEvidence()).toEqual([
			expect.objectContaining({ toolCallId: "call-1", status: "cancelled" }),
		])
	})

	it("cancels command evidence even when process launch has not become visible", async () => {
		const getTerminals = vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([])
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "worker-starting",
			taskKind: "subagent",
			subagentRole: "worker",
			commandExecutionEvidence: new Map(),
		}) as Task
		child.beginCommandExecution("call-starting", "execution-starting")

		try {
			await (child as any).stopActiveWorkerCommand()
		} finally {
			getTerminals.mockRestore()
		}

		expect(child.getCommandExecutionEvidence()).toEqual([
			expect.objectContaining({ toolCallId: "call-starting", status: "cancelled" }),
		])
	})

	it("waits for both process termination and terminal settlement", async () => {
		let resolveAbort!: () => void
		const terminalProcess = Object.assign(new EventEmitter(), {
			abort: vi.fn(
				async () =>
					await new Promise<void>((resolve) => {
						resolveAbort = resolve
					}),
			),
		})
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "worker-await-cleanup",
			taskKind: "subagent",
			subagentRole: "worker",
			terminalProcess,
			commandExecutionEvidence: new Map(),
		}) as Task

		let settled = false
		const stopping = (child as any).stopActiveWorkerCommand().then(() => {
			settled = true
		})
		await vi.waitFor(() => expect(terminalProcess.abort).toHaveBeenCalledOnce())
		terminalProcess.emit("completed")
		await Promise.resolve()
		expect(settled).toBe(false)
		resolveAbort()
		await stopping
		expect(settled).toBe(true)
	})

	it("narrows child tools to reads, upward progress, and completion", () => {
		const child = Object.assign(Object.create(Task.prototype), { taskKind: "subagent" }) as Task
		const allowed = child.getTaskAllowedToolNames()

		expect(allowed).toEqual([
			"read_file",
			"search_files",
			"list_files",
			"codebase_search",
			"report_progress",
			"attempt_completion",
		])
		expect(child.isToolAllowedForTask("report_progress")).toBe(true)
		expect(child.isToolAllowedForTask("read_file")).toBe(true)
		expect(child.isToolAllowedForTask("apply_patch")).toBe(false)
		expect(child.isToolAllowedForTask("execute_command")).toBe(false)
		expect(child.isToolAllowedForTask("delegate_task")).toBe(false)
		expect(child.isToolAllowedForTask("use_mcp_tool")).toBe(false)
	})

	it("does not narrow primary task authority", () => {
		const parent = Object.assign(Object.create(Task.prototype), { taskKind: "primary" }) as Task
		expect(parent.getTaskAllowedToolNames()).toBeUndefined()
		expect(parent.isToolAllowedForTask("apply_patch")).toBe(true)
	})

	it("allows worker edits and commands but rejects delegation, MCP, and out-of-scope edits", () => {
		const child = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentRole: "worker",
			subagentWriteScope: ["core/task"],
			subagentAuthority: {
				role: "worker",
				logicalWorkspace: process.cwd(),
				writeScope: ["core/task"],
				approvalProvenance: "group",
			},
			workspacePath: process.cwd(),
		}) as Task

		expect(child.isToolAllowedForTask("apply_patch")).toBe(true)
		expect(child.isToolAllowedForTask("execute_command")).toBe(true)
		expect(child.isToolAllowedForTask("delegate_task")).toBe(false)
		expect(child.isToolAllowedForTask("use_mcp_tool")).toBe(false)
		expect(child.getTaskToolDenialReason("edit", { file_path: "core/task/Task.ts" })).toBeUndefined()
		expect(child.getTaskToolDenialReason("edit", { file_path: "outside.ts" })).toContain("outside")
		expect(
			child.getTaskToolDenialReason("apply_patch", {
				patch: "*** Begin Patch\n*** Update File: outside.ts\n*** End Patch",
			}),
		).toContain("outside")
	})

	it("reserves the completion tool after the research deadline", () => {
		const child = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentResearchDeadlineAt: Date.now() - 1,
		}) as Task

		expect(child.isToolAllowedForTask("read_file")).toBe(false)
		expect(child.getTaskToolDenialReason("read_file")).toContain("call attempt_completion now")
		expect(child.isToolAllowedForTask("attempt_completion")).toBe(true)
	})

	it("persists the exact terminal status after a managed child stops", async () => {
		const updateTaskHistory = vi.fn(async () => undefined)
		const saveClineMessages = vi.fn(async () => true)
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "child-1",
			taskKind: "subagent",
			initialStatus: "active",
			clineMessages: [],
			saveClineMessages,
			providerRef: {
				deref: () => ({
					getTaskWithId: async () => ({
						historyItem: {
							id: "child-1",
							number: 1,
							ts: 1,
							task: "child",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
							status: "timed_out",
						},
					}),
					updateTaskHistory,
				}),
			},
		}) as Task

		await child.finalizeSubagentHistory("timed_out", "Timed out after inspecting 4 files.")

		expect(saveClineMessages).toHaveBeenCalledOnce()
		expect((child as any).initialStatus).toBe("timed_out")
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "timed_out",
				completionResultSummary: "Timed out after inspecting 4 files.",
			}),
		)
		expect((child as any).clineMessages).toContainEqual(
			expect.objectContaining({ say: "error", text: "Timed out after inspecting 4 files.", partial: false }),
		)
	})

	it("repairs a missing completed transcript before persisting terminal history", async () => {
		const updateTaskHistory = vi.fn(async () => undefined)
		const saveClineMessages = vi.fn(async () => true)
		const child = Object.assign(Object.create(Task.prototype), {
			taskId: "child-2",
			taskKind: "subagent",
			initialStatus: "active",
			clineMessages: [{ ts: 1, type: "say", say: "api_req_started", text: "{}" }],
			saveClineMessages,
			providerRef: {
				deref: () => ({
					getTaskWithId: async () => ({
						historyItem: {
							id: "child-2",
							number: 1,
							ts: 1,
							task: "child",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
					}),
					updateTaskHistory,
				}),
			},
		}) as Task

		await child.finalizeSubagentHistory("completed", "Durable terminal report")

		expect((child as any).clineMessages).toContainEqual(
			expect.objectContaining({
				type: "say",
				say: "completion_result",
				text: "Durable terminal report",
				partial: false,
			}),
		)
		expect(updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ status: "completed", completionResultSummary: "Durable terminal report" }),
		)
	})

	it("reconciles only nonterminal children after a reload", async () => {
		const saveClineMessages = vi.fn(async () => true)
		const group: SubagentGroupState = {
			groupId: "group-1",
			parentTaskId: "parent-1",
			status: "running",
			createdAt: 1,
			startedAt: 2,
			agents: [
				{
					taskId: "finished",
					nickname: "Maple",
					role: "explore",
					objective: "done",
					status: "completed",
					summary: "done",
					usage: { durationMs: 10 },
				},
				{
					taskId: "missing",
					nickname: "Nova",
					role: "review",
					objective: "unfinished",
					status: "running",
					phase: "working",
					phaseStartedAt: 3,
					usage: { durationMs: 0 },
				},
			],
		}
		const parent = Object.assign(Object.create(Task.prototype), {
			clineMessages: [{ ts: 1, type: "say", say: "subagent_group", subagentGroup: group }],
			saveClineMessages,
			providerRef: { deref: () => ({ getLiveTaskIds: () => [] }) },
		}) as Task

		await (parent as any).reconcileInterruptedSubagentGroups()

		expect(group.status).toBe("interrupted")
		expect(group.agents[0].status).toBe("completed")
		expect(group.agents[1]).toMatchObject({ status: "interrupted" })
		expect(group.agents[1]).not.toHaveProperty("phase")
		expect(saveClineMessages).toHaveBeenCalledOnce()
	})

	it("marks a prepared but never launched group as cancelled after reload", async () => {
		const saveClineMessages = vi.fn(async () => true)
		const group: SubagentGroupState = {
			groupId: "group-awaiting-launch",
			parentTaskId: "parent-1",
			status: "pending",
			createdAt: 1,
			agents: [
				{
					taskId: "never-launched",
					nickname: "Nova",
					role: "worker",
					objective: "Wait for launch approval",
					status: "pending",
					phase: "queued",
					phaseStartedAt: 1,
					usage: { durationMs: 0 },
				},
			],
		}
		const parent = Object.assign(Object.create(Task.prototype), {
			clineMessages: [{ ts: 1, type: "say", say: "subagent_group", subagentGroup: group }],
			saveClineMessages,
			providerRef: { deref: () => ({ getLiveTaskIds: () => [] }) },
		}) as Task

		await (parent as any).reconcileInterruptedSubagentGroups()

		expect(group.status).toBe("cancelled")
		expect(group.agents[0]).toMatchObject({
			status: "cancelled",
			stopReason: "never_launched",
			error: expect.stringContaining("never launched"),
		})
		expect(group.agents[0].error).not.toContain("resume")
		expect(saveClineMessages).toHaveBeenCalledOnce()
	})
})
