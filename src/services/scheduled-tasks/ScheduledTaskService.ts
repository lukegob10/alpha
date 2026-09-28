import * as crypto from "crypto"
import { execFile } from "child_process"
import * as vscode from "vscode"
import { promisify } from "util"
import * as path from "path"

import {
	AlphaCodeEventName,
	deriveAutoApprovalFlags,
	hasStoredApprovalSurface,
	isApprovalMode,
	migrateApprovalMode,
	type ApprovalMode,
	scheduledTaskExecutionSchema,
	scheduledTaskProfileSchema,
	taskReasoningPreferenceSchema,
	taskReasoningStateSchema,
	type CreateScheduledTaskPayload,
	type ScheduledTask,
	type ScheduledTaskAutoApproval,
	type ScheduledTaskExecution,
	type ScheduledTaskPermissionSet,
	type ScheduledTaskRun,
	type ScheduledTaskState,
	type TaskReasoningPreference,
	type TaskReasoningState,
	type UpdateScheduledTaskPayload,
} from "@alpha-code/types"

import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import { Package } from "../../shared/package"
import { arePathsEqual, getWorkspacePath } from "../../utils/path"
import { defaultModeSlug } from "../../shared/modes"
import { t } from "../../i18n"
import { SkillsManager } from "../skills/SkillsManager"
import { buildSkillResult, resolveSkillContentForMode } from "../skills/skillInvocation"
import { ScheduledTaskStore } from "./ScheduledTaskStore"
import { checkAutoApproval } from "../../core/auto-approval"
import { getNextRunAt, isRecurringSchedule } from "./schedule"

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
const defaultReasoningPreference: TaskReasoningPreference = { kind: "default" }
const normalizeExecution = (execution?: ScheduledTaskExecution): ScheduledTaskExecution =>
	scheduledTaskExecutionSchema.parse(execution ?? defaultExecution)

const normalizeReasoningPreference = (preference?: TaskReasoningPreference): TaskReasoningPreference =>
	taskReasoningPreferenceSchema.parse(preference ?? defaultReasoningPreference)

const normalizeReasoningState = (state: unknown): TaskReasoningState | undefined => {
	const parsed = taskReasoningStateSchema.safeParse(state)
	return parsed.success ? parsed.data : undefined
}

const readReasoningState = async (task: unknown): Promise<TaskReasoningState | undefined> => {
	const reasoningTask = task as {
		getReasoningState?: () => TaskReasoningState | Promise<TaskReasoningState>
	}
	if (typeof reasoningTask.getReasoningState !== "function") {
		return undefined
	}
	return normalizeReasoningState(await reasoningTask.getReasoningState.call(task))
}

const normalizeAutoApproval = (
	autoApproval?: ScheduledTaskAutoApproval,
	fallback: ApprovalMode = "ask",
): ScheduledTaskAutoApproval => ({
	approvalMode:
		autoApproval && (isApprovalMode(autoApproval.approvalMode) || hasStoredApprovalSurface(autoApproval))
			? migrateApprovalMode(autoApproval)
			: fallback,
	...(autoApproval?.deniedCommands?.length ? { deniedCommands: autoApproval.deniedCommands } : {}),
})

const permissionsForExecution = (
	autoApproval: ScheduledTaskAutoApproval,
	permissions?: Partial<ScheduledTaskPermissionSet>,
): ScheduledTaskPermissionSet => {
	const flags = deriveAutoApprovalFlags(migrateApprovalMode(autoApproval))
	return {
		...defaultPermissions,
		...permissions,
		readFiles: flags.autoApprovalEnabled && flags.alwaysAllowReadOnly,
		runCommands: flags.autoApprovalEnabled && flags.alwaysAllowExecute,
		editFiles: flags.autoApprovalEnabled && flags.alwaysAllowWrite,
	}
}

const truncateOutput = (output: string): string =>
	output.length > MAX_COMMAND_OUTPUT_CHARS
		? `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[output truncated]`
		: output

export class ScheduledTaskService implements vscode.Disposable {
	private readonly store: ScheduledTaskStore
	private readonly ownerId = crypto.randomUUID()
	private releaseOwnerLease: (() => Promise<void>) | undefined
	private workspaceListener: vscode.Disposable | undefined
	private stopWatching: (() => void) | undefined
	private refreshTimer: ReturnType<typeof setTimeout> | undefined
	private timer: ReturnType<typeof setTimeout> | undefined
	private disposed = false
	private readonly commandControllers = new Set<AbortController>()
	private readonly activeAlphaTasks = new Map<
		string,
		{ alphaTask: Awaited<ReturnType<AlphaProvider["createTask"]>>; task: ScheduledTask; run: ScheduledTaskRun }
	>()
	private queue: Array<{ task: ScheduledTask; run: ScheduledTaskRun }> = []
	private processing = false

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: AlphaProvider,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly tickMs = DEFAULT_TICK_MS,
	) {
		this.store = new ScheduledTaskStore(
			context.globalStorageUri.fsPath,
			() => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
		)
	}

	async initialize(): Promise<void> {
		await this.store.initialize()
		this.releaseOwnerLease = await this.store.acquireOwnerLease(this.ownerId, (error) => {
			this.outputChannel.appendLine(`[ScheduledTaskService] Owner lease lost: ${error.message}`)
			this.dispose()
		})
		if (this.disposed) {
			await this.releaseOwnerLease()
			this.releaseOwnerLease = undefined
			return
		}
		this.provider.on(AlphaCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.on(AlphaCodeEventName.TaskAborted, this.handleTaskAborted)
		this.workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void this.store
				.refresh()
				.then(() => this.broadcast())
				.catch((error) => {
					this.outputChannel.appendLine(`[ScheduledTaskService] Workspace refresh failed: ${String(error)}`)
				})
		})
		try {
			await this.recoverInterruptedRuns()
			await this.detectMissedRuns()
			await this.broadcast()
			try {
				this.stopWatching = await this.store.watchChanges(
					() => this.scheduleRefresh(),
					(error) =>
						this.outputChannel.appendLine(
							`[ScheduledTaskService] Schedule watcher failed: ${error.message}`,
						),
				)
			} catch (error) {
				this.outputChannel.appendLine(`[ScheduledTaskService] Schedule watcher unavailable: ${String(error)}`)
			}
			if (this.disposed) {
				this.stopWatching?.()
				this.stopWatching = undefined
				return
			}
			this.scheduleTick()
		} catch (error) {
			this.dispose()
			throw error
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer)
			this.refreshTimer = undefined
		}
		this.stopWatching?.()
		this.stopWatching = undefined
		for (const controller of this.commandControllers) controller.abort()
		this.commandControllers.clear()
		for (const { alphaTask } of this.activeAlphaTasks.values()) {
			void alphaTask.abortTask().catch((error) => {
				this.outputChannel.appendLine(
					`[ScheduledTaskService] Could not abort task ${alphaTask.taskId}: ${String(error)}`,
				)
			})
		}
		this.activeAlphaTasks.clear()
		this.provider.off(AlphaCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.off(AlphaCodeEventName.TaskAborted, this.handleTaskAborted)
		this.workspaceListener?.dispose()
		this.workspaceListener = undefined
		const release = this.releaseOwnerLease
		this.releaseOwnerLease = undefined
		if (release) {
			void release().catch((error) => {
				this.outputChannel.appendLine(`[ScheduledTaskService] Could not release owner lease: ${String(error)}`)
			})
		}
	}

	getState(): ScheduledTaskState {
		return this.store.getState()
	}

	async createTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTask> {
		this.validateSetup(payload)
		const now = Date.now()
		const execution = normalizeExecution(payload.execution)
		const autoApproval = normalizeAutoApproval(payload.autoApproval, "auto")
		const task: ScheduledTask = {
			id: crypto.randomUUID(),
			name: payload.name.trim(),
			prompt: payload.prompt.trim(),
			apiConfig: scheduledTaskProfileSchema.optional().parse(payload.apiConfig),
			reasoningPreference: normalizeReasoningPreference(payload.reasoningPreference),
			execution,
			mode: payload.mode,
			autoApproval,
			workspace: payload.workspace || getWorkspacePath(),
			enabled: true,
			schedule: payload.schedule,
			permissions: permissionsForExecution(autoApproval),
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
		const now = Date.now()
		await this.store.updateTask(taskId, (existing) => {
			this.validateSetup({ ...existing, ...payload })
			const schedule = payload.schedule ?? existing.schedule
			const execution = normalizeExecution(payload.execution ?? existing.execution)
			const autoApproval = normalizeAutoApproval(payload.autoApproval ?? existing.autoApproval)
			return {
				...existing,
				...payload,
				id: existing.id,
				name: payload.name?.trim() ?? existing.name,
				prompt: payload.prompt?.trim() ?? existing.prompt,
				apiConfig: scheduledTaskProfileSchema.optional().parse(payload.apiConfig ?? existing.apiConfig),
				reasoningPreference: normalizeReasoningPreference(
					payload.reasoningPreference ?? existing.reasoningPreference,
				),
				execution,
				mode: payload.mode ?? existing.mode,
				autoApproval,
				schedule,
				permissions: permissionsForExecution(autoApproval, {
					...existing.permissions,
					...payload.permissions,
				}),
				updatedAt: now,
				nextRunAt: getNextRunAt(schedule, now - 1),
			}
		})
		await this.broadcast()
		this.scheduleTick()
	}

	async deleteTask(taskId: string): Promise<void> {
		await this.store.deleteTask(taskId)
		await this.broadcast()
	}

	async pauseTask(taskId: string): Promise<void> {
		await this.store.updateTask(taskId, (task) => ({ ...task, enabled: false, updatedAt: Date.now() }))
		await this.broadcast()
	}

	async resumeTask(taskId: string): Promise<void> {
		await this.store.updateTask(taskId, (task) => ({
			...task,
			enabled: true,
			updatedAt: Date.now(),
			nextRunAt: getNextRunAt(task.schedule, Date.now() - 1),
		}))
		await this.broadcast()
		this.scheduleTick()
	}

	async duplicateTask(taskId: string): Promise<void> {
		await this.store.refresh()
		const task = this.requireTask(taskId)
		await this.createTask({
			name: `${task.name} copy`,
			prompt: task.prompt,
			apiConfig: task.apiConfig,
			reasoningPreference: task.reasoningPreference,
			execution: normalizeExecution(task.execution),
			mode: task.mode,
			autoApproval: task.autoApproval,
			schedule: task.schedule,
			workspace: task.workspace,
			notificationPreference: task.notificationPreference,
		})
	}

	async runNow(taskId: string): Promise<void> {
		await this.store.refresh()
		await this.recoverInterruptedRuns()
		const task = this.requireTask(taskId)
		if (!task.workspace) throw new Error("Assign this legacy schedule to the open workspace before running it")
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

	private scheduleRefresh(): void {
		if (this.disposed) return
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined
			void this.refreshState().catch((error) => {
				this.outputChannel.appendLine(`[ScheduledTaskService] Schedule refresh failed: ${String(error)}`)
			})
		}, 75)
	}

	private async refreshState(): Promise<void> {
		if (!this.disposed && (await this.store.refresh())) await this.broadcast()
	}

	private async tick(): Promise<void> {
		try {
			await this.refreshState()
			await this.recoverInterruptedRuns()
			const now = Date.now()
			for (const task of this.store.getState().tasks) {
				if (task.workspace && task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now) {
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
		const claimed = await this.store.claimRun(task.id, scheduledFor, trigger, (current, hasActiveRun) => {
			const run: ScheduledTaskRun = {
				id: crypto.randomUUID(),
				taskId: current.id,
				ownerId: this.ownerId,
				status: hasActiveRun ? "skipped" : "queued",
				trigger,
				scheduledFor,
				...(hasActiveRun
					? { finishedAt: Date.now(), summary: "Skipped: already_running", skipReason: "already_running" }
					: { queuedAt: Date.now() }),
				workspace: current.workspace,
				prompt: current.prompt,
				apiConfig: current.apiConfig,
				reasoningPreference: normalizeReasoningPreference(current.reasoningPreference),
				execution: normalizeExecution(current.execution),
				mode: current.mode,
				autoApproval: normalizeAutoApproval(current.autoApproval),
			}
			const nextRunAt =
				trigger === "manual"
					? current.nextRunAt
					: hasActiveRun
						? isRecurringSchedule(current.schedule)
							? getNextRunAt(current.schedule, Date.now())
							: undefined
						: getNextRunAt(current.schedule, scheduledFor)
			return {
				task: {
					...current,
					lastRunId: run.id,
					lastRunStatus: run.status,
					lastRunSummary: run.summary,
					nextRunAt,
					enabled: current.schedule.type === "once" && trigger !== "manual" ? false : current.enabled,
					updatedAt: Date.now(),
				},
				run,
			}
		})
		if (!claimed) return
		if (claimed.run.status === "queued") {
			this.queue.push(claimed)
			void this.processQueue()
		}
		await this.broadcast()
	}

	private async processQueue(): Promise<void> {
		if (this.processing) {
			return
		}

		this.processing = true
		try {
			while (this.queue.length > 0) {
				const { task, run } = this.queue.shift()!
				try {
					await this.startRun(task, run)
				} catch (error) {
					this.outputChannel.appendLine(
						`[ScheduledTaskService] Run ${run.id} failed before admission: ${error instanceof Error ? error.message : String(error)}`,
					)
					await this.finishRun(task, {
						...run,
						status: "failed",
						finishedAt: Date.now(),
						error: error instanceof Error ? error.message : String(error),
					}).catch((persistError) => {
						this.outputChannel.appendLine(
							`[ScheduledTaskService] Could not finalize run ${run.id}: ${String(persistError)}`,
						)
					})
				}
			}
		} finally {
			this.processing = false
		}
	}

	private async startRun(task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		// A queued run retains its selected setup even if the schedule is edited before admission.
		task = {
			...task,
			prompt: run.prompt,
			workspace: run.workspace,
			mode: run.mode ?? defaultModeSlug,
			apiConfig: run.apiConfig,
			execution: run.execution,
			autoApproval: run.autoApproval,
			reasoningPreference: normalizeReasoningPreference(run.reasoningPreference),
		}
		const execution = normalizeExecution(task.execution)
		const autoApproval = normalizeAutoApproval(task.autoApproval)
		const startedRun: ScheduledTaskRun = {
			...run,
			status: "running",
			startedAt: Date.now(),
			execution,
			autoApproval,
			mode: task.mode,
		}
		if (!(await this.store.projectRunStatus(startedRun))) return
		await this.broadcast()
		await this.notifyBeforeRun(task, startedRun)

		if (execution.type === "command") {
			await this.startCommandRun(task, startedRun, execution)
			return
		}

		let alphaTask: Awaited<ReturnType<AlphaProvider["createTask"]>> | undefined
		let taskStarted = false
		try {
			const selectedProfile = scheduledTaskProfileSchema.safeParse(run.apiConfig)
			if (!selectedProfile.success) {
				throw new Error(t("scheduledTasks:profileRequired"))
			}
			const profile = await this.provider.providerSettingsManager
				.getProfile({ id: selectedProfile.data.id })
				.catch(() => {
					throw new Error(t("scheduledTasks:profileUnavailable", { name: selectedProfile.data.name }))
				})
			if (profile.name !== selectedProfile.data.name || !profile.apiProvider) {
				throw new Error(t("scheduledTasks:profileUnavailable", { name: selectedProfile.data.name }))
			}
			const { name, id: _id, ...apiConfiguration } = profile
			const prompt = await this.buildPrompt(task)
			if (autoApproval.deniedCommands?.length) {
				throw new Error(
					"Review and save this legacy schedule's approval mode before running it. Its old command deny rules cannot be applied to a background task.",
				)
			}
			alphaTask = await this.provider.createTask(prompt, undefined, undefined, {
				preserveExisting: true,
				background: true,
				startTask: false,
				workspacePath: task.workspace,
				taskMode: task.mode,
				taskApprovalMode: migrateApprovalMode(autoApproval),
				taskApiConfigName: name,
				apiConfiguration,
				reasoningPreference: normalizeReasoningPreference(run.reasoningPreference),
			})
			this.activeAlphaTasks.set(alphaTask.taskId, { alphaTask, task, run: startedRun })
			if (this.disposed) throw new Error("Scheduled task service stopped before admission")
			await alphaTask.prepareReasoningForAdmission()
			if (this.disposed) throw new Error("Scheduled task service stopped before admission")
			const reasoningState = await readReasoningState(alphaTask)
			await this.store.upsertRun({
				...startedRun,
				alphaTaskId: alphaTask.taskId,
				resolvedApiConfig: { id: selectedProfile.data.id, name },
				reasoningState,
			})
			if (this.disposed) throw new Error("Scheduled task service stopped before launch")
			alphaTask.start()
			taskStarted = true
			await this.broadcast()
		} catch (error) {
			if (alphaTask && !taskStarted && this.activeAlphaTasks.delete(alphaTask.taskId)) {
				await alphaTask.abortTask().catch((cleanupError) => {
					this.outputChannel.appendLine(
						`Failed to clean up scheduled task ${alphaTask?.taskId}: ${String(cleanupError)}`,
					)
				})
			}
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
			const state = await this.provider.getState()
			const approval = await checkAutoApproval({
				state: {
					...state,
					approvalMode: migrateApprovalMode(task.autoApproval),
					deniedCommands: [...(state.deniedCommands ?? []), ...(task.autoApproval?.deniedCommands ?? [])],
				},
				ask: "command",
				text: execution.command,
			})
			if (approval.decision === "deny") {
				await this.finishRun(task, {
					...run,
					status: "failed",
					finishedAt: Date.now(),
					error: "Command is blocked by an explicit deny rule.",
				})
				return
			}
			if (approval.decision !== "approve") {
				const waitingRun: ScheduledTaskRun = { ...run, status: "waiting_for_approval" }
				if (!(await this.store.projectRunStatus(waitingRun))) return
				await this.broadcast()
				// Keep the scheduler queue moving while the user considers this run.
				void this.awaitCommandApproval(task, waitingRun, execution)
				return
			}
		} catch (error) {
			await this.finishRun(task, {
				...run,
				status: "failed",
				finishedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			})
			return
		}
		await this.executeCommandRun(task, run, execution)
	}

	private async awaitCommandApproval(
		task: ScheduledTask,
		run: ScheduledTaskRun,
		execution: Extract<ScheduledTaskExecution, { type: "command" }>,
	): Promise<void> {
		try {
			const response = await vscode.window.showWarningMessage(
				`Scheduled task “${task.name}” wants to run:\n${execution.command}`,
				{ modal: true },
				"Run once",
			)
			if (
				this.disposed ||
				this.store.getState().runs.find((candidate) => candidate.id === run.id)?.status !==
					"waiting_for_approval"
			) {
				return
			}
			if (response !== "Run once") {
				await this.finishRun(task, {
					...run,
					status: "canceled",
					finishedAt: Date.now(),
					summary: "Command was not approved.",
				})
				return
			}
			const resumedRun: ScheduledTaskRun = { ...run, status: "running" }
			if (!(await this.store.projectRunStatus(resumedRun))) return
			await this.broadcast()
			await this.executeCommandRun(task, resumedRun, execution)
		} catch (error) {
			if (!this.disposed) {
				await this.finishRun(task, {
					...run,
					status: "failed",
					finishedAt: Date.now(),
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
	}

	private async executeCommandRun(
		task: ScheduledTask,
		run: ScheduledTaskRun,
		execution: Extract<ScheduledTaskExecution, { type: "command" }>,
	): Promise<void> {
		if (this.disposed) return
		const controller = new AbortController()
		this.commandControllers.add(controller)
		try {
			const result = await execFileAsync(execution.command, {
				cwd: task.workspace || getWorkspacePath(),
				signal: controller.signal,
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
		} finally {
			this.commandControllers.delete(controller)
		}
	}

	private async buildPrompt(task: ScheduledTask): Promise<string> {
		const execution = normalizeExecution(task.execution)
		if (execution.type === "skill") {
			return [await this.buildSkillPrompt(task, execution), task.prompt].filter(Boolean).join("\n\n")
		}
		if (execution.type === "plugin") {
			const invocation = [
				`Plugin: ${execution.pluginName}`,
				execution.arguments ? `Arguments: ${execution.arguments}` : "",
			]
				.filter(Boolean)
				.join("\n")
			return [invocation, task.prompt].filter(Boolean).join("\n\n")
		}
		return task.prompt
	}

	private validateSetup(payload: CreateScheduledTaskPayload): void {
		const execution = normalizeExecution(payload.execution)
		if (execution.type !== "command" && !scheduledTaskProfileSchema.safeParse(payload.apiConfig).success) {
			throw new Error(t("scheduledTasks:profileRequired"))
		}
	}

	private async discoverSkills(workspace?: string): Promise<SkillsManager> {
		const cwd = workspace || this.provider.cwd
		if (
			!cwd ||
			!path.isAbsolute(cwd) ||
			!vscode.workspace.workspaceFolders?.some((folder) => arePathsEqual(folder.uri.fsPath, cwd))
		) {
			throw new Error(t("scheduledTasks:workspaceInvalid"))
		}
		// One-shot discovery uses the existing catalog rules without adding file watchers.
		const manager = new SkillsManager(this.provider, cwd)
		await manager.discoverSkills()
		return manager
	}

	async getSkills(workspace: string | undefined, mode: string) {
		const manager = await this.discoverSkills(workspace)
		return manager.getSkillsForMode(mode)
	}

	private async buildSkillPrompt(
		task: ScheduledTask,
		execution: Extract<ScheduledTaskExecution, { type: "skill" }>,
	): Promise<string> {
		try {
			const manager = await this.discoverSkills(task.workspace)
			const content = await resolveSkillContentForMode(manager, execution.skillName, task.mode ?? defaultModeSlug)
			if (!content || (execution.skillPath && execution.skillPath !== content.path)) {
				throw new Error("Unavailable skill")
			}
			return buildSkillResult(execution.skillName, execution.arguments, content)
		} catch {
			throw new Error(t("scheduledTasks:skillUnavailable", { name: execution.skillName }))
		}
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
		const active = this.activeAlphaTasks.get(alphaTaskId)
		if (!active) return
		this.activeAlphaTasks.delete(alphaTaskId)
		await this.finishRun(active.task, { ...active.run, status, summary, finishedAt: Date.now() })
	}

	private async finishRun(_task: ScheduledTask, run: ScheduledTaskRun): Promise<void> {
		const completed = await this.store.completeRun(run)
		if (!completed) return
		await this.broadcast()
		await this.notifyRunFinished(completed.task, completed.run)
	}

	private async recoverInterruptedRuns(): Promise<void> {
		for (const run of this.store.getState().runs) {
			if (ACTIVE_RUN_STATUSES.has(run.status)) {
				if (run.ownerId === this.ownerId) continue
				if (run.ownerId && (await this.store.isOwnerLive(run.ownerId))) continue
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
			if (
				!task.workspace ||
				!task.enabled ||
				task.nextRunAt === undefined ||
				// A second window can open during the normal tick interval; that occurrence is still due.
				task.nextRunAt > now - this.tickMs
			) {
				continue
			}
			await this.recordSkipped(task, task.nextRunAt, "missed_while_inactive")
		}
	}

	private async recordSkipped(task: ScheduledTask, scheduledFor: number, reason: string): Promise<void> {
		const claimed = await this.store.claimRun(task.id, scheduledFor, "missed", (current) => {
			const run: ScheduledTaskRun = {
				id: crypto.randomUUID(),
				taskId: current.id,
				status: "skipped",
				trigger: "missed",
				scheduledFor,
				finishedAt: Date.now(),
				summary: `Skipped: ${reason}`,
				skipReason: reason,
				workspace: current.workspace,
				prompt: current.prompt,
				apiConfig: current.apiConfig,
				reasoningPreference: normalizeReasoningPreference(current.reasoningPreference),
				execution: normalizeExecution(current.execution),
				mode: current.mode,
				autoApproval: current.autoApproval,
			}
			return {
				task: {
					...current,
					lastRunId: run.id,
					lastRunStatus: run.status,
					lastRunSummary: run.summary,
					nextRunAt: isRecurringSchedule(current.schedule)
						? getNextRunAt(current.schedule, Date.now())
						: undefined,
					enabled: current.schedule.type === "once" ? false : current.enabled,
					updatedAt: Date.now(),
				},
				run,
			}
		})
		if (claimed) await this.broadcast()
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
		try {
			await this.provider.postMessageToWebview({
				type: "scheduledTasksUpdated",
				scheduledTaskState: state,
				scheduledTasks: state.tasks,
				scheduledTaskRuns: state.runs,
			})
		} catch (error) {
			this.outputChannel.appendLine(
				`[ScheduledTaskService] Could not update scheduled task view: ${String(error)}`,
			)
		}
	}
}
