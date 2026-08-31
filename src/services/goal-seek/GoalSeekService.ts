import * as crypto from "crypto"
import { realpathSync } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { execFile } from "child_process"
import * as vscode from "vscode"
import { promisify } from "util"

import {
	type CreateGoalSeekJobPayload,
	type GoalSeekAttempt,
	type GoalSeekCandidate,
	type GoalSeekJob,
	type GoalSeekRankingWeights,
	type GoalSeekRun,
	type GoalSeekState,
	type GoalSeekVerifier,
	type GoalSeekVerifierResult,
	RooCodeEventName,
	type UpdateGoalSeekJobPayload,
} from "@alpha-code/types"

import { getLatestTaskCompletionText } from "../../core/task-persistence/completionText"
import type { Task } from "../../core/task/Task"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import { getWorkspacePath } from "../../utils/path"
import { GoalSeekStore } from "./GoalSeekStore"
import {
	calculateGoalSeekUtility,
	compareGoalSeekScores,
	defaultGoalSeekRankingWeights,
	hasPassedGoalSeekTarget,
	normalizeGoalSeekVerifierResult,
} from "./goalSeekUtils"

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_COMMAND_OUTPUT_CHARS = 12_000

type TaskWaiter = {
	resolve: (value: string) => void
	reject: (error: Error) => void
}

type PendingRunStart = {
	jobId: string
	canceled: boolean
	completion: Promise<void>
	resolveCompletion: () => void
}

class GoalSeekRunCanceledError extends Error {
	constructor() {
		super("Goal Seek run was canceled.")
		this.name = "GoalSeekRunCanceledError"
	}
}

const truncateOutput = (output: string): string =>
	output.length > MAX_COMMAND_OUTPUT_CHARS
		? `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[output truncated]`
		: output

export class GoalSeekService implements vscode.Disposable {
	private readonly store: GoalSeekStore
	private readonly taskWaiters = new Map<string, TaskWaiter>()
	private readonly canceledRuns = new Set<string>()
	private readonly activeWorkspaceRuns = new Map<string, string>()
	private readonly runExecutions = new Map<string, Promise<void>>()
	private readonly pendingRunStarts = new Map<string, PendingRunStart>()
	private readonly deletingJobs = new Set<string>()
	private readonly jobDeletionOperations = new Map<string, Promise<void>>()
	private readonly activeTasksByRun = new Map<string, Task>()
	private readonly commandAbortControllers = new Map<string, AbortController>()
	private disposed = false

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: ClineProvider,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.store = new GoalSeekStore(context.globalStorageUri.fsPath)
	}

	async initialize(): Promise<void> {
		await this.store.initialize()
		this.provider.on(RooCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.on(RooCodeEventName.TaskAborted, this.handleTaskAborted)
		await this.recoverInterruptedRuns()
		await this.broadcast()
	}

	dispose(): void {
		this.disposed = true
		this.provider.off(RooCodeEventName.TaskCompleted, this.handleTaskCompleted)
		this.provider.off(RooCodeEventName.TaskAborted, this.handleTaskAborted)
		for (const runId of this.runExecutions.keys()) {
			this.canceledRuns.add(runId)
		}
		for (const controller of this.commandAbortControllers.values()) {
			controller.abort()
		}
		for (const task of this.activeTasksByRun.values()) {
			void task.abortTask().catch(() => undefined)
		}
		for (const waiter of this.taskWaiters.values()) {
			waiter.reject(new Error("Goal Seek service disposed."))
		}
		this.taskWaiters.clear()
	}

	getState(): GoalSeekState {
		return this.store.getState()
	}

	async createJob(payload: CreateGoalSeekJobPayload): Promise<GoalSeekJob> {
		const now = Date.now()
		const job: GoalSeekJob = {
			id: crypto.randomUUID(),
			name: payload.name.trim(),
			goal: payload.goal.trim(),
			verifier: payload.verifier,
			direction: payload.direction,
			targetScore: payload.targetScore,
			maxAttempts: Math.max(1, payload.maxAttempts ?? 10),
			maxFailedAttempts: Math.max(0, payload.maxFailedAttempts ?? 3),
			candidateCount: Math.max(1, payload.candidateCount ?? 10),
			mode: payload.mode,
			workspace: payload.workspace || getWorkspacePath(),
			rankingWeights: { ...defaultGoalSeekRankingWeights, ...payload.rankingWeights },
			createdAt: now,
			updatedAt: now,
		}
		await this.store.upsertJob(job)
		await this.broadcast()
		return job
	}

	async updateJob(jobId: string, payload: UpdateGoalSeekJobPayload): Promise<void> {
		if (this.deletingJobs.has(jobId)) {
			throw new Error(`Goal Seek job is being deleted: ${jobId}`)
		}
		const existing = this.requireJob(jobId)
		const job: GoalSeekJob = {
			...existing,
			...payload,
			id: existing.id,
			name: payload.name?.trim() ?? existing.name,
			goal: payload.goal?.trim() ?? existing.goal,
			maxAttempts: Math.max(1, payload.maxAttempts ?? existing.maxAttempts),
			maxFailedAttempts: Math.max(0, payload.maxFailedAttempts ?? existing.maxFailedAttempts),
			candidateCount: Math.max(1, payload.candidateCount ?? existing.candidateCount),
			rankingWeights: { ...existing.rankingWeights, ...payload.rankingWeights },
			updatedAt: Date.now(),
		}
		await this.store.upsertJob(job)
		await this.broadcast()
	}

	deleteJob(jobId: string): Promise<void> {
		const activeDeletion = this.jobDeletionOperations.get(jobId)
		if (activeDeletion) {
			return activeDeletion
		}

		this.deletingJobs.add(jobId)
		const operation = this.deleteJobExclusive(jobId)
		this.jobDeletionOperations.set(jobId, operation)
		const releaseDeletion = () => {
			if (this.jobDeletionOperations.get(jobId) === operation) {
				this.jobDeletionOperations.delete(jobId)
				this.deletingJobs.delete(jobId)
			}
		}
		void operation.then(releaseDeletion, releaseDeletion)
		return operation
	}

	private async deleteJobExclusive(jobId: string): Promise<void> {
		const pendingStarts = [...this.pendingRunStarts.values()].filter((pending) => pending.jobId === jobId)
		for (const pending of pendingStarts) {
			pending.canceled = true
		}
		await Promise.all(pendingStarts.map((pending) => pending.completion))

		const activeRuns = this.store.getState().runs.filter((run) => run.jobId === jobId && run.status === "running")
		for (const run of activeRuns) {
			await this.cancelRun(run.id)
		}
		await this.store.deleteJob(jobId)
		await this.broadcast()
	}

	async cancelRun(runId: string): Promise<void> {
		const run = this.store.getRun(runId)
		if (!run || run.status !== "running") {
			return
		}

		this.canceledRuns.add(runId)
		this.commandAbortControllers.get(runId)?.abort()
		const activeTask = this.activeTasksByRun.get(runId)
		if (activeTask) {
			const waiter = this.taskWaiters.get(activeTask.taskId)
			if (waiter) {
				this.taskWaiters.delete(activeTask.taskId)
				waiter.reject(new GoalSeekRunCanceledError())
			}
			await Promise.allSettled([activeTask.abortTask()])
		}

		const execution = this.runExecutions.get(runId)
		if (execution) {
			await execution
			return
		}

		const job = this.store.getJob(run.jobId)
		try {
			if (job) {
				await this.finishCanceledExecution(job, runId)
			}
		} finally {
			this.canceledRuns.delete(runId)
		}
	}

	async runJob(jobId: string): Promise<GoalSeekRun> {
		if (this.deletingJobs.has(jobId)) {
			throw new Error(`Goal Seek job was deleted before its run could start: ${jobId}`)
		}
		const job = this.requireJob(jobId)
		const workspace = job.workspace || getWorkspacePath()
		const run: GoalSeekRun = {
			id: crypto.randomUUID(),
			jobId: job.id,
			status: "running",
			startedAt: Date.now(),
			currentIteration: 0,
			failedAttempts: 0,
		}
		const workspaceKey = this.getWorkspaceKey(workspace)
		if (this.activeWorkspaceRuns.has(workspaceKey)) {
			throw new Error(`Goal Seek workspace already has an active run: ${workspace}`)
		}
		this.activeWorkspaceRuns.set(workspaceKey, run.id)
		let resolveStartCompletion!: () => void
		const pendingStart: PendingRunStart = {
			jobId,
			canceled: false,
			completion: new Promise<void>((resolve) => {
				resolveStartCompletion = resolve
			}),
			resolveCompletion: () => resolveStartCompletion(),
		}
		this.pendingRunStarts.set(run.id, pendingStart)

		try {
			await this.assertCleanWorkspace(workspace)
			const currentJob = this.requireRunnableJob(pendingStart, run.id, workspaceKey, false)
			await this.store.updateJobAndRun(
				{
					...currentJob,
					lastRunId: run.id,
					lastRunStatus: run.status,
					lastRunSummary: undefined,
					updatedAt: Date.now(),
				},
				run,
			)
			this.requireRunnableJob(pendingStart, run.id, workspaceKey, true)
			await this.broadcast()
			this.requireRunnableJob(pendingStart, run.id, workspaceKey, true)
			const execution = this.executeRun(job.id, run.id)
			this.runExecutions.set(run.id, execution)
			const releaseOwnership = () => {
				if (this.runExecutions.get(run.id) === execution) {
					this.runExecutions.delete(run.id)
				}
				if (this.activeWorkspaceRuns.get(workspaceKey) === run.id) {
					this.activeWorkspaceRuns.delete(workspaceKey)
				}
				this.canceledRuns.delete(run.id)
			}
			void execution.then(releaseOwnership, releaseOwnership)
			return run
		} catch (error) {
			if (!this.runExecutions.has(run.id) && this.activeWorkspaceRuns.get(workspaceKey) === run.id) {
				this.activeWorkspaceRuns.delete(workspaceKey)
			}
			throw error
		} finally {
			this.pendingRunStarts.delete(run.id)
			pendingStart.resolveCompletion()
		}
	}

	private requireRunnableJob(
		pendingStart: PendingRunStart,
		runId: string,
		workspaceKey: string,
		requirePersistedRun: boolean,
	): GoalSeekJob {
		const currentJob = this.store.getJob(pendingStart.jobId)
		if (pendingStart.canceled || this.deletingJobs.has(pendingStart.jobId) || !currentJob) {
			throw new Error(`Goal Seek job was deleted before its run could start: ${pendingStart.jobId}`)
		}
		const currentWorkspace = currentJob.workspace || getWorkspacePath()
		if (this.getWorkspaceKey(currentWorkspace) !== workspaceKey) {
			throw new Error("Goal Seek job workspace changed while its run was starting. Start the run again.")
		}
		if (requirePersistedRun) {
			const currentRun = this.store.getRun(runId)
			if (!currentRun || currentRun.status !== "running") {
				throw new GoalSeekRunCanceledError()
			}
		}
		return currentJob
	}

	private getWorkspaceKey(workspace: string): string {
		const resolved = path.resolve(workspace)
		let canonical = resolved
		try {
			canonical = realpathSync.native(resolved)
		} catch {
			// The cleanliness check reports inaccessible workspaces after the claim is established.
		}
		return process.platform === "win32" ? canonical.toLowerCase() : canonical
	}

	private async executeRun(jobId: string, runId: string): Promise<void> {
		const job = this.requireJob(jobId)
		let run = this.store.getRun(runId)
		if (!run) {
			return
		}
		let activeAttempt: GoalSeekAttempt | undefined
		let activeCheckpointRef: string | undefined

		try {
			let feedback = ""
			while (run.currentIteration < job.maxAttempts && run.failedAttempts < job.maxFailedAttempts) {
				this.throwIfRunCanceled(run.id)
				activeAttempt = undefined
				activeCheckpointRef = undefined

				const iteration = run.currentIteration + 1
				let attempt: GoalSeekAttempt = {
					id: crypto.randomUUID(),
					runId: run.id,
					iteration,
					status: "planning",
					candidates: [],
					startedAt: Date.now(),
				}
				activeAttempt = attempt
				await this.store.upsertAttempt(attempt)
				this.throwIfRunCanceled(run.id)
				run = await this.updateRun({ ...run, currentIteration: iteration })
				this.throwIfRunCanceled(run.id)

				const candidates = await this.generateCandidates(job, run, feedback)
				this.throwIfRunCanceled(run.id)
				const selected = candidates[0]
				attempt = { ...attempt, candidates, selectedCandidateId: selected.id, status: "implementing" }
				activeAttempt = attempt
				await this.store.upsertAttempt(attempt)
				this.throwIfRunCanceled(run.id)
				await this.broadcast()
				this.throwIfRunCanceled(run.id)

				const checkpointRef = await this.gitRevParse(job.workspace || getWorkspacePath(), "HEAD")
				activeCheckpointRef = checkpointRef
				this.throwIfRunCanceled(run.id)
				attempt = { ...attempt, checkpointRef }
				activeAttempt = attempt
				await this.store.upsertAttempt(attempt)
				this.throwIfRunCanceled(run.id)

				try {
					const implementationResult = await this.runAlphaTask(
						this.buildImplementationPrompt(job, run, selected, feedback),
						job.workspace,
						job.mode,
						true,
						run.id,
					)
					this.throwIfRunCanceled(run.id)
					attempt = {
						...attempt,
						implementationTaskId: implementationResult.taskId,
						status: "verifying",
						summary: implementationResult.result,
					}
					activeAttempt = attempt
					await this.store.upsertAttempt(attempt)
					this.throwIfRunCanceled(run.id)

					const verifierResult = await this.runVerifier(job, run, attempt)
					this.throwIfRunCanceled(run.id)
					const improved = compareGoalSeekScores(run.bestScore, verifierResult.score, job.direction)
					const passedTarget = hasPassedGoalSeekTarget(verifierResult.score, job.targetScore, job.direction)
					const finishedAt = Date.now()

					if (improved) {
						this.throwIfRunCanceled(run.id)
						await this.commitAcceptedAttempt(job, selected, attempt)
						this.throwIfRunCanceled(run.id)
						attempt = {
							...attempt,
							status: "accepted",
							verifierResult: { ...verifierResult, improved, passedTarget },
							finishedAt,
						}
						activeAttempt = attempt
						await this.store.upsertAttempt(attempt)
						this.throwIfRunCanceled(run.id)
						run = await this.updateRun({
							...run,
							bestScore: verifierResult.score,
							bestAttemptId: attempt.id,
						})
						this.throwIfRunCanceled(run.id)
					} else {
						await this.gitResetHard(job.workspace || getWorkspacePath(), checkpointRef)
						this.throwIfRunCanceled(run.id)
						attempt = {
							...attempt,
							status: "reverted",
							verifierResult: { ...verifierResult, improved, passedTarget },
							finishedAt,
							summary: `Reverted: ${verifierResult.reason}`,
						}
						activeAttempt = attempt
						await this.store.upsertAttempt(attempt)
						this.throwIfRunCanceled(run.id)
						run = await this.updateRun({ ...run, failedAttempts: run.failedAttempts + 1 })
						this.throwIfRunCanceled(run.id)
					}

					feedback = verifierResult.nextInstructions || verifierResult.reason
					if (passedTarget) {
						this.throwIfRunCanceled(run.id)
						await this.finishRun(job, {
							...run,
							status: "succeeded",
							exitReason: "target_reached",
							finishedAt: Date.now(),
						})
						this.throwIfRunCanceled(run.id)
						return
					}
					activeCheckpointRef = undefined
					activeAttempt = undefined
				} catch (error) {
					if (this.isRunCancellation(error, run.id)) {
						throw new GoalSeekRunCanceledError()
					}
					await this.gitResetHard(job.workspace || getWorkspacePath(), checkpointRef)
					this.throwIfRunCanceled(run.id)
					const message = error instanceof Error ? error.message : String(error)
					attempt = {
						...attempt,
						status: "failed",
						error: message,
						finishedAt: Date.now(),
					}
					activeAttempt = attempt
					await this.store.upsertAttempt(attempt)
					this.throwIfRunCanceled(run.id)
					run = await this.updateRun({ ...run, failedAttempts: run.failedAttempts + 1 })
					this.throwIfRunCanceled(run.id)
					feedback = message
					activeCheckpointRef = undefined
					activeAttempt = undefined
				}
			}

			this.throwIfRunCanceled(run.id)
			await this.finishRun(job, {
				...run,
				status: "failed",
				exitReason:
					run.failedAttempts >= job.maxFailedAttempts
						? "failed_attempt_limit_reached"
						: "max_attempts_reached",
				finishedAt: Date.now(),
			})
			this.throwIfRunCanceled(run.id)
		} catch (error) {
			if (this.isRunCancellation(error, runId)) {
				await this.finishCanceledExecution(job, runId, activeAttempt, activeCheckpointRef)
				return
			}
			const latestRun = this.store.getRun(runId) ?? run
			await this.finishRun(job, {
				...latestRun,
				status: "failed",
				exitReason: "error",
				error: error instanceof Error ? error.message : String(error),
				finishedAt: Date.now(),
			})
		}
	}

	private isRunCancellation(error: unknown, runId: string): boolean {
		return error instanceof GoalSeekRunCanceledError || this.canceledRuns.has(runId) || this.disposed
	}

	private throwIfRunCanceled(runId: string): void {
		if (this.canceledRuns.has(runId) || this.disposed) {
			throw new GoalSeekRunCanceledError()
		}
	}

	private async finishCanceledExecution(
		job: GoalSeekJob,
		runId: string,
		attempt?: GoalSeekAttempt,
		checkpointRef?: string,
	): Promise<void> {
		let rollbackError: unknown
		if (checkpointRef) {
			try {
				await this.gitResetHard(job.workspace || getWorkspacePath(), checkpointRef)
			} catch (error) {
				rollbackError = error
			}
		}
		const errorMessage = rollbackError instanceof Error ? rollbackError.message : undefined
		if (attempt) {
			await this.store.upsertAttempt({
				...attempt,
				status: "canceled",
				finishedAt: Date.now(),
				error: errorMessage,
			})
		}
		const latestRun = this.store.getRun(runId)
		if (!latestRun) {
			return
		}
		await this.finishRun(job, {
			...latestRun,
			status: "canceled",
			exitReason: "canceled",
			finishedAt: Date.now(),
			error: errorMessage,
		})
	}

	private async generateCandidates(
		job: GoalSeekJob,
		run: GoalSeekRun,
		feedback: string,
	): Promise<GoalSeekCandidate[]> {
		const result = await this.runAlphaTask(
			this.buildCandidatePrompt(job, run, feedback),
			job.workspace,
			job.mode,
			false,
			run.id,
		)
		const parsed = this.parseJsonFromText(result.result) as { candidates?: Partial<GoalSeekCandidate>[] }
		const candidates = (parsed.candidates ?? []).slice(0, job.candidateCount).map((candidate) => {
			const candidateWithoutUtility: Omit<GoalSeekCandidate, "utilityScore"> = {
				id: crypto.randomUUID(),
				title: String(candidate.title ?? "Untitled improvement"),
				rationale: String(candidate.rationale ?? ""),
				expectedRewardImpact: Number(candidate.expectedRewardImpact ?? 0),
				affectedPaths: Array.isArray(candidate.affectedPaths) ? candidate.affectedPaths.map(String) : [],
				directoryRisk: Number(candidate.directoryRisk ?? 50),
				complexity: Number(candidate.complexity ?? 50),
				regressionRisk: Number(candidate.regressionRisk ?? 50),
				reversibility: Number(candidate.reversibility ?? 50),
			}
			return {
				...candidateWithoutUtility,
				utilityScore: calculateGoalSeekUtility(candidateWithoutUtility, job.rankingWeights),
			}
		})
		if (candidates.length === 0) {
			throw new Error("Candidate generation did not return any candidates.")
		}
		return candidates.sort((a, b) => b.utilityScore - a.utilityScore)
	}

	private async runVerifier(
		job: GoalSeekJob,
		run: GoalSeekRun,
		attempt: GoalSeekAttempt,
	): Promise<GoalSeekVerifierResult> {
		const outputs: string[] = []
		let verifierTaskId: string | undefined
		if (job.verifier.type === "command" || job.verifier.type === "promptAndCommand") {
			outputs.push(await this.runCommandVerifier(job, job.verifier, run.id))
		}
		if (job.verifier.type === "prompt" || job.verifier.type === "promptAndCommand") {
			const result = await this.runAlphaTask(
				this.buildVerifierPrompt(job, run, attempt, outputs.join("\n")),
				job.workspace,
				job.mode,
				false,
				run.id,
			)
			verifierTaskId = result.taskId
			outputs.push(result.result)
		}
		await this.store.upsertAttempt({ ...attempt, verifierTaskId })
		const rawOutput = outputs.join("\n\n")
		const parsed = this.parseJsonFromText(rawOutput) as Partial<GoalSeekVerifierResult> & { score?: number }
		if (typeof parsed.score !== "number") {
			throw new Error("Verifier output did not include a numeric score.")
		}
		return normalizeGoalSeekVerifierResult(
			{ ...parsed, score: parsed.score },
			job.direction,
			job.targetScore,
			run.bestScore,
			rawOutput,
		)
	}

	private async runCommandVerifier(
		job: GoalSeekJob,
		verifier: Extract<GoalSeekVerifier, { command: string }>,
		runId: string,
	) {
		const controller = new AbortController()
		this.commandAbortControllers.set(runId, controller)
		try {
			const result = await execFileAsync(verifier.command, {
				cwd: job.workspace || getWorkspacePath(),
				timeout: verifier.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
				shell: true,
				signal: controller.signal,
			})
			return truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n"))
		} finally {
			if (this.commandAbortControllers.get(runId) === controller) {
				this.commandAbortControllers.delete(runId)
			}
		}
	}

	private async runAlphaTask(
		prompt: string,
		workspace: string | undefined,
		mode: string | undefined,
		writeCapable: boolean,
		runId?: string,
	): Promise<{ taskId: string; result: string }> {
		const task = await this.provider.createTask(
			prompt,
			undefined,
			undefined,
			{
				preserveExisting: true,
				background: true,
				workspacePath: workspace,
				taskMode: mode,
				startTask: false,
			},
			{
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowReadOnlyOutsideWorkspace: false,
				alwaysAllowWrite: writeCapable,
				alwaysAllowWriteOutsideWorkspace: false,
				alwaysAllowWriteProtected: false,
				alwaysAllowExecute: writeCapable,
				alwaysAllowMcp: writeCapable,
				alwaysAllowModeSwitch: false,
				alwaysAllowSubtasks: false,
				allowedCommands: [],
				deniedCommands: [],
			},
		)
		if (runId) {
			this.activeTasksByRun.set(runId, task)
			if (this.canceledRuns.has(runId) || this.disposed) {
				await Promise.allSettled([task.abortTask()])
				this.activeTasksByRun.delete(runId)
				throw new GoalSeekRunCanceledError()
			}
		}
		try {
			const resultPromise = new Promise<string>((resolve, reject) => {
				this.taskWaiters.set(task.taskId, { resolve, reject })
			})
			task.start()
			const result = await resultPromise
			return { taskId: task.taskId, result }
		} finally {
			this.taskWaiters.delete(task.taskId)
			if (runId && this.activeTasksByRun.get(runId) === task) {
				this.activeTasksByRun.delete(runId)
			}
		}
	}

	private buildCandidatePrompt(job: GoalSeekJob, run: GoalSeekRun, feedback: string): string {
		return [
			`Goal Seek candidate generation for: ${job.name}`,
			`Goal: ${job.goal}`,
			`Score direction: ${job.direction}`,
			`Target score: ${job.targetScore}`,
			`Current best score: ${run.bestScore ?? "none"}`,
			`Generate exactly ${job.candidateCount} bounded improvement candidates for this repository.`,
			"Rank for expected reward while penalizing directory risk, implementation complexity, regression risk, broad rewrites, and low reversibility.",
			"Return only JSON in this shape:",
			`{"candidates":[{"title":"...","rationale":"...","expectedRewardImpact":0,"affectedPaths":["..."],"directoryRisk":0,"complexity":0,"regressionRisk":0,"reversibility":0}]}`,
			"All numeric scores are 0-100.",
			feedback ? `Previous verifier feedback: ${feedback}` : "",
		]
			.filter(Boolean)
			.join("\n")
	}

	private buildImplementationPrompt(
		job: GoalSeekJob,
		run: GoalSeekRun,
		candidate: GoalSeekCandidate,
		feedback: string,
	): string {
		return [
			`Goal Seek implementation attempt ${run.currentIteration} for: ${job.name}`,
			`Goal: ${job.goal}`,
			`Selected candidate: ${candidate.title}`,
			`Rationale: ${candidate.rationale}`,
			`Affected paths: ${candidate.affectedPaths.join(", ") || "not specified"}`,
			"Implement only this bounded candidate. Avoid broad rewrites unless directly required.",
			"Do not stage, commit, push, or open pull requests. The Goal Seek service manages git checkpoints.",
			"Run focused verification if appropriate and summarize what changed.",
			feedback ? `Verifier feedback to address: ${feedback}` : "",
		]
			.filter(Boolean)
			.join("\n")
	}

	private buildVerifierPrompt(
		job: GoalSeekJob,
		run: GoalSeekRun,
		attempt: GoalSeekAttempt,
		commandOutput: string,
	): string {
		const selected = attempt.candidates.find((candidate) => candidate.id === attempt.selectedCandidateId)
		const verifierPrompt =
			job.verifier.type === "prompt" || job.verifier.type === "promptAndCommand" ? job.verifier.prompt : ""
		return [
			"Goal Seek verifier. Inspect the workspace without modifying files.",
			`Goal: ${job.goal}`,
			`Selected candidate: ${selected?.title ?? "unknown"}`,
			`Score direction: ${job.direction}`,
			`Target score: ${job.targetScore}`,
			`Previous accepted score: ${run.bestScore ?? "none"}`,
			verifierPrompt ? `Verifier instructions: ${verifierPrompt}` : "",
			commandOutput ? `Command verifier output:\n${commandOutput}` : "",
			"Return only JSON in this shape:",
			`{"score":0,"reason":"...","nextInstructions":"..."}`,
		]
			.filter(Boolean)
			.join("\n")
	}

	private parseJsonFromText(text: string): unknown {
		const trimmed = text.trim()
		try {
			return JSON.parse(trimmed)
		} catch {
			const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\{[\s\S]*\})/)
			if (!match) {
				throw new Error("Expected JSON output but none was found.")
			}
			return JSON.parse(match[1])
		}
	}

	private async finishRun(job: GoalSeekJob, run: GoalSeekRun): Promise<void> {
		const currentJob = this.store.getJob(job.id)
		if (!currentJob) {
			return
		}
		const summary = this.describeRunSummary(run)
		await this.store.updateJobAndRun(
			{
				...currentJob,
				lastRunId: run.id,
				lastRunStatus: run.status,
				lastRunSummary: summary,
				updatedAt: Date.now(),
			},
			run,
		)
		await this.broadcast()
	}

	private async updateRun(run: GoalSeekRun): Promise<GoalSeekRun> {
		await this.store.upsertRun(run)
		await this.broadcast()
		return run
	}

	private describeRunSummary(run: GoalSeekRun): string {
		if (run.exitReason === "target_reached") {
			return `Target reached with score ${run.bestScore}.`
		}
		if (run.error) {
			return run.error
		}
		return `Exited: ${run.exitReason ?? run.status}. Best score: ${run.bestScore ?? "none"}.`
	}

	private async assertCleanWorkspace(workspace: string): Promise<void> {
		const status = await this.git(workspace, ["status", "--porcelain"])
		if (status.trim()) {
			throw new Error("Goal Seek requires a clean git workspace before it can manage rollback checkpoints.")
		}
	}

	private async commitAcceptedAttempt(
		job: GoalSeekJob,
		candidate: GoalSeekCandidate,
		attempt: GoalSeekAttempt,
	): Promise<void> {
		const workspace = job.workspace || getWorkspacePath()
		const status = await this.git(workspace, ["status", "--porcelain"])
		if (!status.trim()) {
			return
		}
		await this.git(workspace, ["add", "-A"])
		await this.git(workspace, [
			"commit",
			"-m",
			`Goal seek accepted: ${candidate.title}`,
			"-m",
			`Attempt: ${attempt.id}`,
		])
	}

	private async gitRevParse(workspace: string, ref: string): Promise<string> {
		return (await this.git(workspace, ["rev-parse", ref])).trim()
	}

	private async gitResetHard(workspace: string, ref: string): Promise<void> {
		await this.git(workspace, ["reset", "--hard", ref])
		await this.git(workspace, ["clean", "-fd"])
	}

	private async git(workspace: string, args: string[]): Promise<string> {
		const result = await execFileAsync("git", args, {
			cwd: workspace,
			windowsHide: true,
			maxBuffer: 2 * 1024 * 1024,
		})
		return [result.stdout, result.stderr].filter(Boolean).join("\n")
	}

	private handleTaskCompleted = async (alphaTaskId: string): Promise<void> => {
		const waiter = this.taskWaiters.get(alphaTaskId)
		if (!waiter) {
			return
		}
		this.taskWaiters.delete(alphaTaskId)
		try {
			waiter.resolve(await this.getTaskCompletionText(alphaTaskId))
		} catch (error) {
			waiter.reject(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private handleTaskAborted = async (alphaTaskId: string): Promise<void> => {
		const waiter = this.taskWaiters.get(alphaTaskId)
		if (!waiter) {
			return
		}
		this.taskWaiters.delete(alphaTaskId)
		waiter.reject(new Error("Goal Seek background task was aborted."))
	}

	private async getTaskCompletionText(alphaTaskId: string): Promise<string> {
		const task = await this.provider.getTaskWithId(alphaTaskId)
		const rawMessages = await fs.readFile(task.uiMessagesFilePath, "utf8")
		const messages = JSON.parse(rawMessages)
		if (!Array.isArray(messages)) {
			throw new Error(`Task ${alphaTaskId} has invalid persisted UI messages.`)
		}
		const completionText = getLatestTaskCompletionText(messages)
		if (!completionText) {
			throw new Error(`Task ${alphaTaskId} completed without a non-empty assistant result.`)
		}
		return completionText
	}

	private async recoverInterruptedRuns(): Promise<void> {
		for (const run of this.store.getState().runs) {
			if (run.status !== "running" && run.status !== "queued") {
				continue
			}
			const job = this.store.getJob(run.jobId)
			if (!job) {
				continue
			}
			await this.finishRun(job, {
				...run,
				status: "failed",
				exitReason: "error",
				error: "Run was interrupted before the extension restarted.",
				finishedAt: Date.now(),
			})
		}
	}

	private requireJob(jobId: string): GoalSeekJob {
		const job = this.store.getJob(jobId)
		if (!job) {
			throw new Error(`Goal Seek job not found: ${jobId}`)
		}
		return job
	}

	private async broadcast(): Promise<void> {
		const state = this.store.getState()
		await this.provider.postMessageToWebview({
			type: "goalSeekUpdated",
			goalSeekState: state,
			goalSeekJobs: state.jobs,
			goalSeekRuns: state.runs,
			goalSeekAttempts: state.attempts,
		})
	}
}
