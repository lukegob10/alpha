import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { execFile, spawn } from "child_process"
import { promisify } from "util"

import {
	DEFAULT_PARALLEL_AGENT_MAX_CONCURRENT,
	HARD_PARALLEL_AGENT_MAX_CONCURRENT,
	type HistoryItem,
	type ParallelAgentRecord,
	type ParallelAgentResult,
	type ParallelAgentStatus,
	type ResolvedWorkspaceStrategy,
	type WorkspaceStrategy,
	RooCodeEventName,
} from "@roo-code/types"
import { worktreeService } from "@roo-code/core"

import type { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"

const execFileAsync = promisify(execFile)

export interface SpawnAgentParams {
	taskName: string
	message: string
	mode?: string
	agentRole?: string
	workspaceStrategy?: WorkspaceStrategy
	writeScopes?: string[]
}

export interface SpawnAgentsResult {
	records: ParallelAgentRecord[]
	failures: Array<{ taskName: string; error: string }>
}

export interface IntegrationPreview {
	agent: ParallelAgentRecord
	diff: string
	stat: string
	changedFiles: string[]
}

type AgentTerminalStatus = Exclude<ParallelAgentStatus, "running">
type PreparedAgent = { record: ParallelAgentRecord; task: Task }

export class AgentCoordinator {
	private readonly agents = new Map<string, ParallelAgentRecord>()
	private readonly tasks = new Map<string, Task>()
	private readonly taskCleanups = new Map<string, () => void>()
	private readonly writeLocks = new Map<string, string>()
	private readonly waiters = new Set<() => void>()

	constructor(private readonly provider: ClineProvider) {}

	list(status?: string | null): ParallelAgentRecord[] {
		const records = Array.from(this.agents.values()).sort((a, b) => b.updatedAt - a.updatedAt)
		return status ? records.filter((agent) => agent.status === status) : records
	}

	get(agentId: string): ParallelAgentRecord | undefined {
		return this.agents.get(agentId)
	}

	async spawn(parentTask: Task, params: SpawnAgentParams): Promise<ParallelAgentRecord> {
		const prepared = await this.prepareSpawn(parentTask, params)
		this.startPreparedAgents([prepared])
		await this.postAgentState()
		return prepared.record
	}

	async spawnMany(parentTask: Task, paramsList: SpawnAgentParams[]): Promise<SpawnAgentsResult> {
		const preparedAgents: PreparedAgent[] = []
		const failures: SpawnAgentsResult["failures"] = []

		for (const params of paramsList) {
			try {
				preparedAgents.push(await this.prepareSpawn(parentTask, params))
			} catch (error) {
				failures.push({
					taskName: params.taskName,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}

		this.startPreparedAgents(preparedAgents)
		await this.postAgentState()

		return {
			records: preparedAgents.map(({ record }) => record),
			failures,
		}
	}

	private async prepareSpawn(parentTask: Task, params: SpawnAgentParams): Promise<PreparedAgent> {
		const state = await this.provider.getState()
		if (!state.parallelSubagents) {
			throw new Error("Parallel subagents are disabled. Enable parallelSubagents in Experimental settings.")
		}
		if (parentTask.parallelAgentId) {
			throw new Error("Recursive parallel agent spawning is disabled in v1.")
		}

		const runningCount = this.list("running").length
		const configuredMax = Math.min(
			Math.max(1, state.parallelAgentMaxConcurrent ?? DEFAULT_PARALLEL_AGENT_MAX_CONCURRENT),
			HARD_PARALLEL_AGENT_MAX_CONCURRENT,
		)
		if (runningCount >= configuredMax) {
			throw new Error(`Parallel agent limit reached (${runningCount}/${configuredMax}).`)
		}

		const taskName = this.slugify(params.taskName)
		if (!taskName) {
			throw new Error("task_name must contain at least one letter or number.")
		}

		const writeScopes = this.normalizeScopes(params.writeScopes ?? [])
		const requestedStrategy = params.workspaceStrategy ?? "auto"
		const agentId = randomUUID()
		const resolvedStrategy = await this.resolveWorkspaceStrategy({
			requestedStrategy,
			agentRole: params.agentRole,
			writeScopes,
			cwd: parentTask.cwd,
		})

		if (resolvedStrategy === "sameWorktree") {
			this.reserveWriteLocks(writeScopes, agentId)
		}

		let workspacePath = parentTask.cwd
		let baseBranch: string | undefined
		let branch: string | undefined

		try {
			if (resolvedStrategy === "newWorktree") {
				const worktree = await this.createAgentWorktree(parentTask.cwd, parentTask.taskId, taskName)
				workspacePath = worktree.workspacePath
				baseBranch = worktree.baseBranch
				branch = worktree.branch
			}

			const now = Date.now()
			const agentMessage = this.buildAgentPrompt(params, {
				agentId,
				parentTaskId: parentTask.taskId,
				workspacePath,
				resolvedStrategy,
				writeScopes,
				baseBranch,
				branch,
			})

			const record: ParallelAgentRecord = {
				id: agentId,
				parentTaskId: parentTask.taskId,
				childTaskId: agentId,
				taskName,
				message: params.message,
				mode: params.mode,
				agentRole: params.agentRole,
				status: "running",
				workspaceStrategy: requestedStrategy,
				resolvedWorkspaceStrategy: resolvedStrategy,
				workspacePath,
				baseBranch,
				branch,
				writeScopes,
				createdAt: now,
				updatedAt: now,
			}

			this.agents.set(agentId, record)
			await this.createAgentHistory(record)
			await this.updateParentChildState(parentTask.taskId, record, "running")

			const task = await this.provider.createBackgroundTask(agentMessage, parentTask, {
				taskId: agentId,
				workspacePath,
				initialMode: params.mode,
				parallelAgentId: agentId,
				initialStatus: "active",
				startTask: false,
			})

			this.tasks.set(agentId, task)
			const onAborted = () => {
				const current = this.agents.get(agentId)
				if (current?.status === "running") {
					this.markTerminal(agentId, "failed", { error: "Agent task aborted before completion." }).catch(
						(error) => this.provider.log(`[AgentCoordinator] failed to mark aborted agent: ${error}`),
					)
				}
			}
			task.on(RooCodeEventName.TaskAborted, onAborted)
			this.taskCleanups.set(agentId, () => task.off(RooCodeEventName.TaskAborted, onAborted))

			return { record, task }
		} catch (error) {
			if (resolvedStrategy === "sameWorktree") {
				this.releaseLocksForOwner(agentId)
			}
			throw error
		}
	}

	private startPreparedAgents(preparedAgents: PreparedAgent[]): void {
		for (const { record, task } of preparedAgents) {
			this.provider.log(`[AgentCoordinator] starting parallel agent ${record.id} (${record.taskName})`)
			task.start()
		}
	}

	async wait(targets?: string[] | null, timeoutMs?: number | null): Promise<ParallelAgentRecord[]> {
		const targetIds = targets?.length ? targets : this.list("running").map((agent) => agent.id)
		if (targetIds.length === 0) {
			return []
		}

		const completed = () =>
			targetIds
				.map((id) => this.agents.get(id))
				.filter((agent): agent is ParallelAgentRecord => !!agent && agent.status !== "running")

		const existing = completed()
		if (existing.length > 0) {
			return existing
		}

		const timeout = Math.max(0, timeoutMs ?? 30_000)
		return await new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined
			const check = () => {
				const done = completed()
				if (done.length > 0) {
					if (timer) {
						clearTimeout(timer)
					}
					this.waiters.delete(check)
					resolve(done)
				}
			}

			this.waiters.add(check)
			timer = setTimeout(() => {
				this.waiters.delete(check)
				resolve([])
			}, timeout)
		})
	}

	async sendInput(agentId: string, message: string): Promise<ParallelAgentRecord> {
		const record = this.requireAgent(agentId)
		if (record.status !== "running") {
			throw new Error(`Agent ${agentId} is ${record.status}; input can only be sent to running agents.`)
		}
		const task = this.tasks.get(agentId)
		if (!task) {
			throw new Error(`Agent ${agentId} task is not available.`)
		}

		await task.submitUserMessage(message)
		record.updatedAt = Date.now()
		this.agents.set(agentId, record)
		await this.postAgentState()
		return record
	}

	async close(agentId: string): Promise<ParallelAgentRecord> {
		const record = this.requireAgent(agentId)
		if (record.status === "running") {
			const task = this.tasks.get(agentId)
			task?.abortTask()
			await this.markTerminal(agentId, "cancelled", { error: "Agent cancelled by parent." })
			return this.requireAgent(agentId)
		}

		record.status = "closed"
		record.updatedAt = Date.now()
		this.agents.set(agentId, record)
		await this.postAgentState()
		return record
	}

	async complete(agentId: string, rawResult: string): Promise<ParallelAgentRecord> {
		const record = this.requireAgent(agentId)
		const changedFiles = await this.collectChangedFiles(record.workspacePath)
		const result = this.parseResult(rawResult, changedFiles, record.workspacePath)
		await this.markTerminal(agentId, "completed", { result })
		return this.requireAgent(agentId)
	}

	async getIntegrationPreview(agentId: string): Promise<IntegrationPreview> {
		const agent = this.requireAgent(agentId)
		if (agent.status !== "completed") {
			throw new Error(`Agent ${agentId} is ${agent.status}; only completed agents can be integrated.`)
		}
		if (agent.resolvedWorkspaceStrategy !== "newWorktree") {
			throw new Error(`Agent ${agentId} already ran in the parent worktree; there is no isolated diff to apply.`)
		}
		if (!agent.workspacePath || !agent.baseBranch) {
			throw new Error(`Agent ${agentId} is missing workspace metadata.`)
		}

		const [diffResult, statResult] = await Promise.all([
			execFileAsync("git", ["diff", "--binary", agent.baseBranch], {
				cwd: agent.workspacePath,
				maxBuffer: 50 * 1024 * 1024,
			}),
			execFileAsync("git", ["diff", "--stat", agent.baseBranch], {
				cwd: agent.workspacePath,
				maxBuffer: 5 * 1024 * 1024,
			}),
		])

		const diff = diffResult.stdout.toString()
		const stat = statResult.stdout.toString()
		return {
			agent,
			diff,
			stat,
			changedFiles: await this.collectChangedFiles(agent.workspacePath, agent.baseBranch),
		}
	}

	async applyIntegration(agentId: string, diff: string): Promise<ParallelAgentRecord> {
		const agent = this.requireAgent(agentId)
		if (!diff.trim()) {
			throw new Error(`Agent ${agentId} has no diff to apply.`)
		}

		await this.gitApply(this.provider.cwd, diff)
		const result = agent.result ? { ...agent.result, integrated: true } : undefined
		const updated = {
			...agent,
			result,
			updatedAt: Date.now(),
		}
		this.agents.set(agentId, updated)
		await this.updateAgentHistory(updated)
		await this.postAgentState()
		return updated
	}

	private async markTerminal(
		agentId: string,
		status: AgentTerminalStatus,
		patch: { result?: ParallelAgentResult; error?: string } = {},
	): Promise<void> {
		const record = this.requireAgent(agentId)
		const updated: ParallelAgentRecord = {
			...record,
			status,
			result: patch.result ?? record.result,
			error: patch.error ?? record.error,
			updatedAt: Date.now(),
			completedAt: Date.now(),
		}

		this.agents.set(agentId, updated)
		this.releaseLocksForOwner(agentId)
		this.tasks.delete(agentId)
		this.taskCleanups.get(agentId)?.()
		this.taskCleanups.delete(agentId)

		await this.updateAgentHistory(updated)
		await this.updateParentChildState(updated.parentTaskId, updated, status)
		await this.postAgentState()
		this.notifyWaiters()
	}

	private async resolveWorkspaceStrategy(params: {
		requestedStrategy: WorkspaceStrategy
		agentRole?: string
		writeScopes: string[]
		cwd: string
	}): Promise<ResolvedWorkspaceStrategy> {
		const roleIsReadOnly = this.isReadOnlyRole(params.agentRole)
		if (params.requestedStrategy === "newWorktree") {
			return "newWorktree"
		}

		if (params.requestedStrategy === "sameWorktree") {
			if (!roleIsReadOnly && params.writeScopes.length === 0) {
				throw new Error("sameWorktree write agents must declare disjoint write_scope paths.")
			}
			this.assertNoLockConflicts(params.writeScopes)
			return "sameWorktree"
		}

		if (roleIsReadOnly || params.writeScopes.length === 0) {
			return "sameWorktree"
		}

		return "newWorktree"
	}

	private async createAgentWorktree(cwd: string, parentTaskId: string, taskName: string) {
		const gitRoot = await worktreeService.getGitRootPath(cwd)
		if (!gitRoot) {
			throw new Error("Cannot create an agent worktree outside a git repository.")
		}

		const baseBranch = (await worktreeService.getCurrentBranch(cwd)) ?? "HEAD"
		const parentShort = parentTaskId.slice(0, 8)
		const suffix = Date.now().toString(36)
		const branch = `agent/${parentShort}/${taskName}-${suffix}`
		const workspacePath = path.join(gitRoot, ".alpha", "worktrees", `${parentShort}-${taskName}-${suffix}`)

		await fs.mkdir(path.dirname(workspacePath), { recursive: true })
		const result = await worktreeService.createWorktree(cwd, {
			path: workspacePath,
			branch,
			baseBranch,
			createNewBranch: true,
		})

		if (!result.success) {
			throw new Error(result.message)
		}

		return { workspacePath, baseBranch, branch }
	}

	private async createAgentHistory(record: ParallelAgentRecord): Promise<void> {
		const item: HistoryItem = {
			id: record.id,
			rootTaskId: record.parentTaskId,
			parentTaskId: record.parentTaskId,
			number: -1,
			ts: record.createdAt,
			task: record.message,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			size: 0,
			workspace: record.workspacePath,
			mode: record.mode,
			status: "active",
			agentStatus: record.status,
			agentRole: record.agentRole,
			workspaceStrategy: record.workspaceStrategy,
			workspacePath: record.workspacePath,
			baseBranch: record.baseBranch,
		}
		await this.provider.updateTaskHistory(item)
	}

	private async updateAgentHistory(record: ParallelAgentRecord): Promise<void> {
		const item: HistoryItem = {
			id: record.id,
			rootTaskId: record.parentTaskId,
			parentTaskId: record.parentTaskId,
			number: -1,
			ts: record.updatedAt,
			task: record.message,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			workspace: record.workspacePath,
			mode: record.mode,
			status: record.status === "completed" ? "completed" : record.status === "running" ? "active" : "completed",
			agentStatus: record.status,
			agentRole: record.agentRole,
			workspaceStrategy: record.workspaceStrategy,
			workspacePath: record.workspacePath,
			baseBranch: record.baseBranch,
			agentResultSummary: record.result?.summary,
			agentChangedFiles: record.result?.changedFiles,
			agentValidation: record.result?.validation,
			agentIntegrated: record.result?.integrated,
		}
		await this.provider.updateTaskHistory(item)
	}

	private async updateParentChildState(
		parentTaskId: string,
		record: ParallelAgentRecord,
		status: ParallelAgentStatus,
	): Promise<void> {
		try {
			const { historyItem } = await this.provider.getTaskWithId(parentTaskId)
			const childIds = this.addUnique(historyItem.childIds, record.id)
			const runningChildIds = new Set(historyItem.runningChildIds ?? [])
			const completedChildIds = new Set(historyItem.completedChildIds ?? [])
			const failedChildIds = new Set(historyItem.failedChildIds ?? [])

			runningChildIds.delete(record.id)
			completedChildIds.delete(record.id)
			failedChildIds.delete(record.id)

			if (status === "running") {
				runningChildIds.add(record.id)
			} else if (status === "completed") {
				completedChildIds.add(record.id)
			} else {
				failedChildIds.add(record.id)
			}

			await this.provider.updateTaskHistory({
				...historyItem,
				childIds,
				runningChildIds: Array.from(runningChildIds),
				completedChildIds: Array.from(completedChildIds),
				failedChildIds: Array.from(failedChildIds),
			})
		} catch (error) {
			this.provider.log(`[AgentCoordinator] failed to update parent ${parentTaskId}: ${error}`)
		}
	}

	private reserveWriteLocks(scopes: string[], ownerId: string): void {
		this.assertNoLockConflicts(scopes)
		for (const scope of scopes) {
			this.writeLocks.set(scope, ownerId)
		}
	}

	private assertNoLockConflicts(scopes: string[]): void {
		for (const scope of scopes) {
			for (const [lockedScope, owner] of this.writeLocks) {
				if (this.scopesOverlap(scope, lockedScope)) {
					throw new Error(`write_scope '${scope}' conflicts with active agent ${owner} lock '${lockedScope}'.`)
				}
			}
		}
	}

	private releaseLocksForOwner(ownerId: string): void {
		for (const [scope, owner] of this.writeLocks) {
			if (owner === ownerId) {
				this.writeLocks.delete(scope)
			}
		}
	}

	private normalizeScopes(scopes: string[]): string[] {
		return Array.from(
			new Set(
				scopes
					.map((scope) => scope.trim())
					.filter(Boolean)
					.map((scope) => scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")),
			),
		)
	}

	private scopesOverlap(a: string, b: string): boolean {
		return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
	}

	private isReadOnlyRole(role?: string): boolean {
		const normalized = role?.toLowerCase() ?? ""
		return ["explorer", "research", "review", "reviewer", "verify", "verifier", "verification", "readonly", "read-only"].some(
			(marker) => normalized.includes(marker),
		)
	}

	private slugify(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
	}

	private requireAgent(agentId: string): ParallelAgentRecord {
		const record = this.agents.get(agentId)
		if (!record) {
			throw new Error(`Unknown parallel agent: ${agentId}`)
		}
		return record
	}

	private parseResult(rawResult: string, changedFiles: string[], workspacePath?: string): ParallelAgentResult {
		const validation = rawResult.match(/validation\s*:?\s*([\s\S]*?)(?:\n\n|$)/i)?.[1]?.trim()
		return {
			summary: rawResult.trim(),
			changedFiles,
			validation,
			workspacePath,
			integrated: false,
		}
	}

	private async collectChangedFiles(workspacePath?: string, baseBranch?: string): Promise<string[]> {
		if (!workspacePath) {
			return []
		}

		try {
			const args = baseBranch
				? ["diff", "--name-only", baseBranch]
				: ["status", "--porcelain"]
			const { stdout } = await execFileAsync("git", args, { cwd: workspacePath })
			const lines = stdout
				.toString()
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)

			if (baseBranch) {
				return lines
			}

			return lines.map((line) => {
				const pathPart = line.slice(3).trim()
				const renameIndex = pathPart.lastIndexOf(" -> ")
				return renameIndex >= 0 ? pathPart.slice(renameIndex + 4) : pathPart
			})
		} catch {
			return []
		}
	}

	private async gitApply(cwd: string, diff: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("git", ["apply", "--whitespace=nowarn"], { cwd })
			let stderr = ""

			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString()
			})
			child.on("error", reject)
			child.on("close", (code) => {
				if (code === 0) {
					resolve()
				} else {
					reject(new Error(stderr || `git apply exited with code ${code}`))
				}
			})
			child.stdin.end(diff)
		})
	}

	private buildAgentPrompt(
		params: SpawnAgentParams,
		metadata: {
			agentId: string
			parentTaskId: string
			workspacePath: string
			resolvedStrategy: ResolvedWorkspaceStrategy
			writeScopes: string[]
			baseBranch?: string
			branch?: string
		},
	): string {
		const writeScopeText = metadata.writeScopes.length ? metadata.writeScopes.join(", ") : "(read-only or undeclared)"
		return [
			`You are parallel agent ${metadata.agentId}.`,
			`Parent task: ${metadata.parentTaskId}.`,
			`Role: ${params.agentRole ?? "default"}.`,
			`Workspace strategy: ${metadata.resolvedStrategy}.`,
			`Workspace path: ${metadata.workspacePath}.`,
			metadata.branch ? `Branch: ${metadata.branch}. Base branch: ${metadata.baseBranch ?? "HEAD"}.` : undefined,
			`Write scope: ${writeScopeText}.`,
			"",
			"Work only on the independent subtask below. Do not spawn additional agents. If you edit files, stay inside the declared write scope.",
			"On completion, call attempt_completion with a result containing: Summary, Changed files, Validation run, and Workspace integration note.",
			"",
			params.message,
		]
			.filter(Boolean)
			.join("\n")
	}

	private addUnique(values: string[] | undefined, value: string): string[] {
		return Array.from(new Set([...(values ?? []), value]))
	}

	private async postAgentState(): Promise<void> {
		await this.provider.postMessageToWebview({
			type: "state",
			state: { parallelAgents: this.list() },
		})
	}

	private notifyWaiters(): void {
		for (const waiter of this.waiters) {
			waiter()
		}
	}
}
