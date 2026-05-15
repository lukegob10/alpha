import * as crypto from "crypto"
import { execFile } from "child_process"
import * as vscode from "vscode"
import { promisify } from "util"

import {
	RooCodeEventName,
	type CreateScheduledTaskPayload,
	type ScheduledTask,
	type ScheduledTaskAutoApproval,
	type ScheduledTaskExecution,
	type ScheduledTaskPermissionSet,
	type ScheduledTaskRun,
	type ScheduledTaskState,
	type UpdateScheduledTaskPayload,
} from "@alpha-code/types"

import type { ClineProvider } from "../../core/webview/ClineProvider"
import { Package } from "../../shared/package"
import { getWorkspacePath } from "../../utils/path"
import { ScheduledTaskStore } from "./ScheduledTaskStore"
import { formatScheduleForPrompt, getNextRunAt, isRecurringSchedule } from "./schedule"

const ACTIVE_RUN_STATUSES = new Set(["pending", "queued", "running", "waiting_for_approval"])
const DEFAULT_TICK_MS = 60 * 1000
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_COMMAND_OUTPUT_CHARS = 12_000
const execFileAsync = promisify(execFile)

const defaultPermissions: ScheduledTaskPermissionSet = {
	readFiles: true,
	runCommands: false,
	editFiles: false,
	stageChanges: false,
	commitChanges: false,
	pushBranches: false,
	openPullRequests: false,
	sendNotifications: false,
}

const defaultExecution: ScheduledTaskExecution = { type: "prompt" }
const defaultAutoApproval: ScheduledTaskAutoApproval = {
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	allowedCommands: [],
	deniedCommands: [],
}

const normalizeExecution = (execution?: ScheduledTaskExecution): ScheduledTaskExecution => execution ?? defaultExecution

const normalizeAutoApproval = (
	autoApproval: ScheduledTaskAutoApproval | undefined,
	execution: ScheduledTaskExecution,
): ScheduledTaskAutoApproval => ({
	...defaultAutoApproval,
	...autoApproval,
	alwaysAllowExecute:
		execution.type === "command"
			? true
			: (autoApproval?.alwaysAllowExecute ?? defaultAutoApproval.alwaysAllowExecute),
	allowedCommands:
		execution.type === "command" && autoApproval?.allowedCommands?.length
			? autoApproval.allowedCommands
			: (autoApproval?.allowedCommands ?? defaultAutoApproval.allowedCommands),
})

const permissionsForExecution = (
	execution: ScheduledTaskExecution,
	autoApproval: ScheduledTaskAutoApproval,
	permissions?: Partial<ScheduledTaskPermissionSet>,
): ScheduledTaskPermissionSet => ({
	...defaultPermissions,
	...permissions,
	readFiles: autoApproval.autoApprovalEnabled && autoApproval.alwaysAllowReadOnly,
	runCommands: autoApproval.autoApprovalEnabled && (autoApproval.alwaysAllowExecute || execution.type === "command"),
	editFiles: autoApproval.autoApprovalEnabled && autoApproval.alwaysAllowWrite,
})

const truncateOutput = (output: string): string =>
	output.length > MAX_COMMAND_OUTPUT_CHARS
		? `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[output truncated]`
		: output

export class ScheduledTaskService implements vscode.Disposable {
	private readonly store: ScheduledTaskStore
	private timer: ReturnType<typeof setTimeout> | undefined
	private disposed = false
	private queue: ScheduledTaskRun[] = []
	private processing = false

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: ClineProvider,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly tickMs = DEFAULT_TICK_MS,
	) {
		this.store = new ScheduledTaskStore(context.globalStorageUri.fsPath)
	}

	async initialize(): Promise<void> {
		await this.store.initialize()
		this.provider.on(RooCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.on(RooCodeEventName.TaskAborted, this.handleTaskAborted)
		await this.recoverInterruptedRuns()
		await this.detectMissedRuns()
		await this.broadcast()
		this.scheduleTick()
	}

	dispose(): void {
		this.disposed = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
		this.provider.off(RooCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.off(RooCodeEventName.TaskAborted, this.handleTaskAborted)
	}

	getState(): ScheduledTaskState {
		return this.store.getState()
	}

	async createTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTask> {
		const now = Date.now()
		const execution = normalizeExecution(payload.execution)
		const autoApproval = normalizeAutoApproval(payload.autoApproval, execution)
		const task: ScheduledTask = {
			id: crypto.randomUUID(),
			name: payload.name.trim(),
			prompt: payload.prompt.trim(),
			execution,
			mode: payload.mode,
			autoApproval,
			workspace: payload.workspace || getWorkspacePath(),
			enabled: true,
			schedule: payload.schedule,
			permissions: permissionsForExecution(execution, autoApproval),
			notificationPreference: payload.notificationPreference ?? "on_failure",
			createdAt: now,
			updatedAt: now,
			nextRunAt: getNextRunAt(payload.schedule, now - 1),
		}

		await this.store.upsertTask(task)
		await this.broadcast()
		this.scheduleTick()
		return task
	}

	async updateTask(taskId: string, payload: UpdateScheduledTaskPayload): Promise<void> {
		const existing = this.requireTask(taskId)
		const now = Date.now()
		const schedule = payload.schedule ?? existing.schedule
		const execution = normalizeExecution(payload.execution ?? existing.execution)
		const autoApproval = normalizeAutoApproval(payload.autoApproval ?? existing.autoApproval, execution)
		const task: ScheduledTask = {
			...existing,
			...payload,
			id: existing.id,
			name: payload.name?.trim() ?? existing.name,
			prompt: payload.prompt?.trim() ?? existing.prompt,
			execution,
			mode: payload.mode ?? existing.mode,
			autoApproval,
			schedule,
			permissions: permissionsForExecution(execution, autoApproval, {
				...existing.permissions,
				...payload.permissions,
			}),
			updatedAt: now,
			nextRunAt: getNextRunAt(schedule, now - 1),
		}
		await this.store.upsertTask(task)
		await this.broadcast()
		this.scheduleTick()
	}

	async deleteTask(taskId: string): Promise<void> {
		await this.store.deleteTask(taskId)
		await this.broadcast()
	}

	async pauseTask(taskId: string): Promise<void> {
		const task = this.requireTask(taskId)
		await this.store.upsertTask({ ...task, enabled: false, updatedAt: Date.now() })
		await this.broadcast()
	}

	async resumeTask(taskId: string): Promise<void> {
		const task = this.requireTask(taskId)
		await this.store.upsertTask({
			...task,
			enabled: true,
			updatedAt: Date.now(),
			nextRunAt: getNextRunAt(task.schedule, Date.now() - 1),
		})
		await this.broadcast()
		this.scheduleTick()
	}

	async duplicateTask(taskId: string): Promise<void> {
		const task = this.requireTask(taskId)
		await this.createTask({
			name: `${task.name} copy`,
			prompt: task.prompt,
			execution: normalizeExecution(task.execution),
			mode: task.mode,
			autoApproval: task.autoApproval,
			schedule: task.schedule,
			workspace: task.workspace,
			notificationPreference: task.notificationPreference,
		})
	}

	async runNow(taskId: string): Promise<void> {
		const task = this.requireTask(taskId)
		await this.enqueueRun(task, Date.now(), "manual")
	}

	private scheduleTick(): void {
		if (this.disposed) {
			return
		}
		if (this.timer) {
			clearTimeout(this.timer)
		}
		this.timer = setTimeout(() => {
			this.timer = undefined
			void this.tick()
		}, this.tickMs)
	}

	private async tick(): Promise<void> {
		try {
			const now = Date.now()
			for (const task of this.store.getState().tasks) {
				if (task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now) {
					await this.enqueueRun(task, task.nextRunAt, "schedule")
				}
			}
		} catch (error) {
			this.outputChannel.appendLine(
				`[ScheduledTaskService] Tick failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			this.scheduleTick()
		}
	}

	private async enqueueRun(
		task: ScheduledTask,
		scheduledFor: number,
		trigger: ScheduledTaskRun["trigger"],
	): Promise<void> {
		const execution = normalizeExecution(task.execution)
		const autoApproval = normalizeAutoApproval(task.autoApproval, execution)
		const activeRun = this.store
			.getRunsForTask(task.id)
			.find((run) => ACTIVE_RUN_STATUSES.has(run.status) || this.queue.some((queued) => queued.id === run.id))

		if (activeRun) {
			await this.recordSkipped(task, scheduledFor, "already_running")
			return
		}

		const run: ScheduledTaskRun = {
			id: crypto.randomUUID(),
			taskId: task.id,
			status: "queued",
			trigger,
			scheduledFor,
			queuedAt: Date.now(),
			workspace: task.workspace,
			prompt: task.prompt,
			execution,
			mode: task.mode,
			autoApproval,
		}

		const nextRunAt = trigger === "manual" ? task.nextRunAt : getNextRunAt(task.schedule, scheduledFor)
		await this.store.updateTaskAndRun(
			{
				...task,
				lastRunId: run.id,
				lastRunStatus: run.status,
				lastRunSummary: undefined,
				nextRunAt,
				enabled: task.schedule.type === "once" && trigger !== "manual" ? false : task.enabled,
				updatedAt: Date.now(),
			},
			run,
		)
		this.queue.push(run)
		await this.broadcast()
		void this.processQueue()
	}

	private async processQueue(): Promise<void> {
		if (this.processing) {
			return
		}

		this.processing = true
		try {
			while (this.queue.length > 0) {
				const run = this.queue.shift()!
				const task = this.store.getTask(run.taskId)
				if (!task) {
					continue
				}
				await this.startRun(task, run)
			}
		} finally {
			this.processing = false
		}
	}

	private async startRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		const execution = normalizeExecution(task.execution)
		const autoApproval = normalizeAutoApproval(task.autoApproval, execution)
		const startedRun: ScheduledTaskRun = {
			...run,
			status: "running",
			startedAt: Date.now(),
			execution,
			autoApproval,
			mode: task.mode,
		}
		await this.store.upsertRun(startedRun)
		await this.broadcast()
		await this.notifyBeforeRun(task, startedRun)

		if (execution.type === "command") {
			await this.startCommandRun(task, startedRun, execution)
			return
		}

		try {
			const alphaTask = await this.provider.createTask(
				this.buildPrompt(task, startedRun),
				undefined,
				undefined,
				{ preserveExisting: true, background: true, workspacePath: task.workspace, taskMode: task.mode },
				this.configurationForAutoApproval(autoApproval),
			)
			await this.store.upsertRun({ ...startedRun, alphaTaskId: alphaTask.taskId })
			await this.broadcast()
		} catch (error) {
			const failedRun: ScheduledTaskRun = {
				...startedRun,
				status: "failed",
				finishedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			}
			await this.finishRun(task, failedRun)
		}
	}

	private async startCommandRun(
		task: ScheduledTask,
		run: ScheduledTaskRun,
		execution: Extract<ScheduledTaskExecution, { type: "command" }>,
	): Promise<void> {
		const autoApproval = normalizeAutoApproval(task.autoApproval, execution)
		if (!autoApproval.autoApprovalEnabled || !autoApproval.alwaysAllowExecute) {
			await this.finishRun(task, {
				...run,
				status: "failed",
				finishedAt: Date.now(),
				error: "Command execution requires Always allow execute operations.",
			})
			return
		}

		if (!execution.command.trim()) {
			await this.finishRun(task, {
				...run,
				status: "failed",
				finishedAt: Date.now(),
				error: "Command execution requires a command.",
			})
			return
		}

		try {
			const result = await execFileAsync(execution.command, {
				cwd: task.workspace || getWorkspacePath(),
				timeout: execution.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
				shell: true,
			})
			const output = truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n"))
			await this.finishRun(task, {
				...run,
				status: "succeeded",
				finishedAt: Date.now(),
				summary: output ? "Command completed with output." : "Command completed.",
				output,
				exitCode: 0,
			})
		} catch (error) {
			const commandError = error as Error & { stdout?: string; stderr?: string; code?: number | string }
			const output = truncateOutput([commandError.stdout, commandError.stderr].filter(Boolean).join("\n"))
			await this.finishRun(task, {
				...run,
				status: "failed",
				finishedAt: Date.now(),
				error: commandError.message,
				output,
				exitCode: typeof commandError.code === "number" ? commandError.code : undefined,
			})
		}
	}

	private buildPrompt(task: ScheduledTask, run: ScheduledTaskRun): string {
		const execution = normalizeExecution(task.execution)
		const autoApproval = normalizeAutoApproval(task.autoApproval, execution)
		const executionBlock =
			execution.type === "skill"
				? [
						`Execution mode: skill`,
						`Skill: ${execution.skillName}`,
						execution.arguments ? `Arguments: ${execution.arguments}` : "",
					]
				: execution.type === "plugin"
					? [
							`Execution mode: plugin`,
							`Plugin: ${execution.pluginName}`,
							execution.arguments ? `Arguments: ${execution.arguments}` : "",
						]
					: [`Execution mode: prompt`]
		return [
			`Scheduled task: ${task.name}`,
			`Run id: ${run.id}`,
			`Scheduled for: ${new Date(run.scheduledFor).toISOString()}`,
			`Schedule: ${formatScheduleForPrompt(task.schedule)}`,
			`Workspace: ${task.workspace ?? "current workspace"}`,
			`Mode: ${task.mode ?? "current mode"}`,
			`Auto-approval: ${this.describeAutoApproval(autoApproval)}`,
			...executionBlock.filter(Boolean),
			"",
			"Execution constraints:",
			...this.autoApprovalPromptLines(autoApproval),
			"- Do not stage, commit, push, or open pull requests.",
			...(execution.type === "skill" || execution.type === "plugin"
				? [
						"- Use the requested skill or plugin only if it is available; otherwise report that it is unavailable.",
					]
				: []),
			"",
			"Task prompt:",
			task.prompt,
		].join("\n")
	}

	private configurationForAutoApproval(autoApproval: ScheduledTaskAutoApproval) {
		return {
			autoApprovalEnabled: autoApproval.autoApprovalEnabled,
			alwaysAllowReadOnly: autoApproval.alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace: autoApproval.alwaysAllowReadOnlyOutsideWorkspace,
			alwaysAllowWrite: autoApproval.alwaysAllowWrite,
			alwaysAllowWriteOutsideWorkspace: autoApproval.alwaysAllowWriteOutsideWorkspace,
			alwaysAllowWriteProtected: autoApproval.alwaysAllowWriteProtected,
			alwaysAllowExecute: autoApproval.alwaysAllowExecute,
			alwaysAllowMcp: autoApproval.alwaysAllowMcp,
			alwaysAllowModeSwitch: autoApproval.alwaysAllowModeSwitch,
			alwaysAllowSubtasks: autoApproval.alwaysAllowSubtasks,
			allowedCommands: autoApproval.allowedCommands,
			deniedCommands: autoApproval.deniedCommands,
		}
	}

	private describeAutoApproval(autoApproval: ScheduledTaskAutoApproval): string {
		if (!autoApproval.autoApprovalEnabled) {
			return "ask for approval"
		}
		const enabled = [
			autoApproval.alwaysAllowReadOnly ? "read" : undefined,
			autoApproval.alwaysAllowWrite ? "write" : undefined,
			autoApproval.alwaysAllowExecute ? "execute" : undefined,
			autoApproval.alwaysAllowMcp ? "mcp" : undefined,
			autoApproval.alwaysAllowModeSwitch ? "mode switch" : undefined,
			autoApproval.alwaysAllowSubtasks ? "subtasks" : undefined,
		].filter(Boolean)
		return enabled.length ? enabled.join(", ") : "ask for approval"
	}

	private autoApprovalPromptLines(autoApproval: ScheduledTaskAutoApproval): string[] {
		if (!autoApproval.autoApprovalEnabled) {
			return ["- Ask before using tools or making changes."]
		}
		const lines = ["- Use only the auto-approved capabilities configured for this scheduled task."]
		if (!autoApproval.alwaysAllowWrite) {
			lines.push("- Do not edit files.")
		}
		if (!autoApproval.alwaysAllowExecute) {
			lines.push("- Do not run shell commands.")
		}
		return lines
	}

	private handleTaskCompleted = async (alphaTaskId: string): Promise<void> => {
		await this.finishRunByAlphaTask(alphaTaskId, "succeeded", "Scheduled task completed.")
	}

	private handleTaskAborted = async (alphaTaskId: string): Promise<void> => {
		await this.finishRunByAlphaTask(alphaTaskId, "failed", "Scheduled task was aborted.")
	}

	private async finishRunByAlphaTask(
		alphaTaskId: string,
		status: ScheduledTaskRun["status"],
		summary: string,
	): Promise<void> {
		const run = this.store
			.getState()
			.runs.find((candidate) => candidate.alphaTaskId === alphaTaskId && candidate.status === "running")
		if (!run) {
			return
		}
		const task = this.store.getTask(run.taskId)
		if (!task) {
			return
		}
		await this.finishRun(task, { ...run, status, summary, finishedAt: Date.now() })
	}

	private async finishRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		await this.store.updateTaskAndRun(
			{
				...task,
				lastRunId: run.id,
				lastRunStatus: run.status,
				lastRunSummary: run.summary ?? run.error,
				updatedAt: Date.now(),
			},
			run,
		)
		await this.broadcast()
		await this.notifyRunFinished(task, run)
	}

	private async recoverInterruptedRuns(): Promise<void> {
		for (const run of this.store.getState().runs) {
			if (ACTIVE_RUN_STATUSES.has(run.status)) {
				const task = this.store.getTask(run.taskId)
				if (!task) {
					continue
				}
				await this.finishRun(task, {
					...run,
					status: "failed",
					finishedAt: Date.now(),
					error: "Run was interrupted before the extension restarted.",
				})
			}
		}
	}

	private async detectMissedRuns(): Promise<void> {
		const now = Date.now()
		for (const task of this.store.getState().tasks) {
			if (!task.enabled || task.nextRunAt === undefined || task.nextRunAt > now) {
				continue
			}
			await this.recordSkipped(task, task.nextRunAt, "missed_while_inactive")
		}
	}

	private async recordSkipped(task: ScheduledTask, scheduledFor: number, reason: string): Promise<void> {
		const run: ScheduledTaskRun = {
			id: crypto.randomUUID(),
			taskId: task.id,
			status: "skipped",
			trigger: reason === "missed_while_inactive" ? "missed" : "schedule",
			scheduledFor,
			finishedAt: Date.now(),
			summary: `Skipped: ${reason}`,
			skipReason: reason,
			workspace: task.workspace,
			prompt: task.prompt,
			execution: normalizeExecution(task.execution),
			mode: task.mode,
			autoApproval: task.autoApproval,
		}
		const nextRunAt = isRecurringSchedule(task.schedule) ? getNextRunAt(task.schedule, Date.now()) : undefined
		await this.store.updateTaskAndRun(
			{
				...task,
				lastRunId: run.id,
				lastRunStatus: run.status,
				lastRunSummary: run.summary,
				nextRunAt,
				enabled: task.schedule.type === "once" ? false : task.enabled,
				updatedAt: Date.now(),
			},
			run,
		)
		await this.broadcast()
	}

	private async notifyBeforeRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		if (task.notificationPreference !== "before_run") {
			return
		}
		const choice = await vscode.window.showInformationMessage(
			`Scheduled task "${task.name}" started in the background.`,
			"Review",
		)
		if (choice === "Review") {
			await this.openScheduledTask(task.id, run.id)
		}
	}

	private async notifyRunFinished(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		if (task.notificationPreference === "never" || task.notificationPreference === "before_run") {
			return
		}
		const failed = run.status === "failed"
		const completed = run.status === "succeeded" || run.status === "skipped"
		if (task.notificationPreference === "on_failure" && !failed) {
			return
		}
		if (task.notificationPreference === "on_completion" && !completed && !failed) {
			return
		}

		const verb = run.status === "succeeded" ? "completed" : run.status
		const choice =
			failed || task.notificationPreference === "approval_required"
				? await vscode.window.showWarningMessage(`Scheduled task "${task.name}" ${verb}.`, "Review")
				: await vscode.window.showInformationMessage(`Scheduled task "${task.name}" ${verb}.`, "Review")
		if (choice === "Review") {
			await this.openScheduledTask(task.id, run.id)
		}
	}

	private async openScheduledTask(taskId: string, runId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		} catch {
			// The webview message below still selects the task if the view is already available.
		}
		await this.provider.postMessageToWebview({
			type: "action",
			action: "switchTab",
			tab: "scheduledTasks",
			values: { scheduledTaskId: taskId, scheduledTaskRunId: runId, force: true },
		})
	}

	private requireTask(taskId: string): ScheduledTask {
		const task = this.store.getTask(taskId)
		if (!task) {
			throw new Error(`Scheduled task not found: ${taskId}`)
		}
		return task
	}

	private async broadcast(): Promise<void> {
		const state = this.store.getState()
		await this.provider.postMessageToWebview({
			type: "scheduledTasksUpdated",
			scheduledTaskState: state,
			scheduledTasks: state.tasks,
			scheduledTaskRuns: state.runs,
		})
	}
}
