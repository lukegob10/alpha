import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	RooCodeEventName,
	toolNames,
	type ToolName,
	type ClineMessage,
	type RooCodeAPI,
	type RooCodeSettings,
} from "@alpha-code/types"

import { waitFor } from "../suite/utils"
import { WorkflowFailure } from "./contracts"
import {
	workflowCommands,
	workflowPrompt,
	WORKFLOW_COMMANDS,
	WORKFLOW_TRACE_COMMANDS,
	type WorkflowPromptName,
} from "./prompts"
import { inspectWorkflowTrace } from "./workflowTrace"
import { inspectRecoveryTrace, isRecoveryPhase } from "./recoveryTrace"
import { guardTaskApi, WorkflowRequestBudget } from "./requestBudget"
import { WorkflowScriptedAI } from "./scriptedWorkflow"
import { inspectTaskLifecycle, inspectToolTransactions } from "./transactionAssertions"
import type { WorkflowEvidence, WorkflowHost } from "./workflowDriver"

const workflowTools = new Set<ToolName>([
	"read_file",
	"list_files",
	"search_files",
	"read_command_output",
	"execute_command",
	"write_to_file",
	"apply_diff",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
	"apply_patch",
	"attempt_completion",
	"update_todo_list",
	"ask_followup_question",
])

// A closed scenario surface prevents unrelated browser, GitHub, MCP, image and
// delegation calls from relying on a model's obedience to the fixture prompt.
export const WORKFLOW_DISABLED_TOOLS = toolNames.filter((name) => !workflowTools.has(name))

interface HostTask {
	taskId: string
	api: unknown
	apiConversationHistory: unknown[]
	clineMessages: ClineMessage[]
	taskAsk?: ClineMessage
	didComplete?: boolean
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface HostProvider {
	viewLaunched: boolean
	getLiveTask(taskId: string): HostTask | undefined
	getStateToPostToWebview(): Promise<{ currentTaskId?: string }>
	getTaskWithId(taskId: string): Promise<{ historyItem: unknown; taskDirPath: string }>
	createTaskWithHistoryItem(
		historyItem: unknown,
		options: { subagentRuntime: { apiConfiguration: RooCodeSettings } },
	): Promise<unknown>
	on(event: "taskCreated", listener: (task: HostTask) => void): void
	off(event: "taskCreated", listener: (task: HostTask) => void): void
}

export async function readBoundedJson(filePath: string, jsonl = false): Promise<unknown> {
	const file = await fs.open(filePath, "r").catch(() => {
		throw new WorkflowFailure("persistence", "evidence_unreadable")
	})
	try {
		const limit = 16 * 1024 * 1024
		const stat = await file.stat()
		if (!stat.isFile() || stat.size > limit) throw new WorkflowFailure("persistence", "evidence_size_limit")
		const buffer = Buffer.alloc(stat.size + 1)
		let bytesRead = 0
		while (bytesRead < buffer.length) {
			const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
			if (read.bytesRead === 0) break
			bytesRead += read.bytesRead
		}
		if (bytesRead > stat.size) throw new WorkflowFailure("persistence", "evidence_changed_during_read")
		const text = buffer.subarray(0, bytesRead).toString("utf8")
		try {
			return jsonl
				? text
						.split(/\r?\n/)
						.filter(Boolean)
						.map((line) => JSON.parse(line))
				: JSON.parse(text)
		} catch {
			throw new WorkflowFailure("persistence", "evidence_invalid_json")
		}
	} finally {
		await file.close()
	}
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

function unexpectedAskFailure(ask: ClineMessage): WorkflowFailure {
	if (ask.ask === "tool") {
		let tool = ""
		try {
			const value = record(JSON.parse(ask.text ?? ""))?.tool
			if (typeof value === "string") tool = value
		} catch {
			/* Report only a closed diagnostic code. */
		}
		if (
			[
				"readFile",
				"listFiles",
				"listFilesTopLevel",
				"listFilesRecursive",
				"searchFiles",
				"codebaseSearch",
			].includes(tool)
		)
			return new WorkflowFailure("policy", "unexpected_read_approval")
		if (["editedExistingFile", "newFileCreated", "appliedDiff"].includes(tool))
			return new WorkflowFailure("policy", "unexpected_write_approval")
		return new WorkflowFailure("policy", "unexpected_tool_approval")
	}
	if (ask.ask === "resume_task") return new WorkflowFailure("lifecycle", "unexpected_resume_task")
	if (ask.ask === "resume_completed_task") return new WorkflowFailure("lifecycle", "unexpected_resume_completed_task")
	if (ask.ask === "api_req_failed" || ask.ask === "auto_approval_max_req_reached")
		return new WorkflowFailure("provider", ask.ask, true)
	return new WorkflowFailure("lifecycle", "unexpected_recovery_or_approval")
}

export function isApprovedWorkflowCommand(
	command: string,
	history: unknown[],
	workspace: string,
	allowedCommands: readonly string[] = Object.values(WORKFLOW_COMMANDS),
): boolean {
	if (!allowedCommands.includes(command)) return false
	for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex--) {
		const message = record(history[messageIndex])
		const content = message?.content
		if (!Array.isArray(content)) continue
		const calls = content
			.map(record)
			.filter((block) => block?.type === "tool_use" && block.name === "execute_command")
		if (message?.role !== "assistant") {
			if (calls.length > 0) return false
			continue
		}
		// A live response can request several serial commands. Match within its batch, never older assistant turns.
		const matches = calls.map((block) => record(block?.input)).filter((input) => input?.command === command)
		return (
			matches.length > 0 &&
			matches.every(
				(input) =>
					input?.cwd === undefined ||
					input.cwd === null ||
					(typeof input.cwd === "string" &&
						path.relative(workspace, path.resolve(workspace, input.cwd)) === ""),
			)
		)
	}
	// Approval text alone does not prove the command's workspace scope.
	return false
}

export class ExtensionWorkflowHost implements WorkflowHost {
	private readonly provider: HostProvider
	private readonly completions = new Map<string, number>()
	private readonly expectedCompletions = new Map<string, number>()
	private readonly guardedTasks = new WeakSet<HostTask>()
	private readonly cleanup: Array<() => void> = []
	private readonly approvedAsks = new Set<number>()
	private readonly scripted?: WorkflowScriptedAI
	private readonly configuration: RooCodeSettings
	private readonly deadline: number
	private currentId?: string
	private activePrompt: WorkflowPromptName = "review"
	private readonly onCompleted = (id: string) => this.completions.set(id, (this.completions.get(id) ?? 0) + 1)
	private readonly onCreated = (task: HostTask) => {
		if (this.scripted || this.guardedTasks.has(task)) return
		this.cleanup.push(guardTaskApi(task, this.budget))
		this.guardedTasks.add(task)
	}

	constructor(
		private readonly api: RooCodeAPI,
		private readonly workspace: string,
		providerMode: string,
		readonly budget: WorkflowRequestBudget,
		timeoutMs: number,
	) {
		const provider = (api as unknown as { sidebarProvider?: HostProvider }).sidebarProvider
		if (!provider || typeof provider.on !== "function")
			throw new WorkflowFailure("harness", "host_provider_unavailable", true)
		if (providerMode !== "scripted" && providerMode !== "live-copilot")
			throw new WorkflowFailure("configuration", "unsupported_workflow_provider", true)
		this.provider = provider
		this.deadline = Date.now() + timeoutMs
		this.scripted = providerMode === "scripted" ? new WorkflowScriptedAI(budget, workspace) : undefined
		this.configuration = {
			...api.getConfiguration(),
			...(this.scripted ? { apiProvider: "fake-ai", fakeAi: this.scripted } : {}),
			mode: "code",
			disabledTools: WORKFLOW_DISABLED_TOOLS,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: false,
			alwaysAllowMcp: false,
			mcpEnabled: false,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
			alwaysAllowSubagents: false,
			alwaysAllowFollowupQuestions: false,
			allowedCommands: [],
			deniedCommands: ["git push", "git remote", "git config", "npm install", "pnpm install"],
			allowedMaxRequests: budget.limit,
			requestDelaySeconds: 0,
			writeDelayMs: 0,
			commandExecutionTimeout: 30,
			commandTimeoutAllowlist: [],
			enableCheckpoints: false,
			terminalShellIntegrationDisabled: true,
		}
		this.api.on(RooCodeEventName.TaskCompleted, this.onCompleted)
		this.provider.on("taskCreated", this.onCreated)
	}

	private requireTask(taskId: string): HostTask {
		const task = this.provider.getLiveTask(taskId)
		if (!task || task.taskId !== taskId) throw new WorkflowFailure("lifecycle", "task_identity_lost")
		return task
	}

	private checkBudget(): void {
		if (this.budget.failure) throw this.budget.failure
		if (this.budget.exhausted) throw new WorkflowFailure("provider", "request_limit_reached", true)
		if (Date.now() >= this.deadline) throw new WorkflowFailure("timeout", "scenario_deadline")
	}

	private async until(condition: () => boolean | Promise<boolean>, code: string): Promise<void> {
		this.checkBudget()
		try {
			await waitFor(
				async () => {
					this.checkBudget()
					return condition()
				},
				{
					timeout: Math.max(1, this.deadline - Date.now()),
					interval: 50,
					description: code,
				},
			)
		} catch (error) {
			if (error instanceof WorkflowFailure) throw error
			throw new WorkflowFailure("timeout", code)
		}
	}

	async start(prompt: WorkflowPromptName): Promise<string> {
		this.activePrompt = prompt
		this.scripted?.setPhase(prompt)
		// Policy stays explicit across reloads and never derives from the selected model.
		await this.api.setConfiguration(this.configuration)
		const id = await this.api.startNewTask({ configuration: this.configuration, text: workflowPrompt(prompt) })
		this.currentId = id
		this.expectedCompletions.set(id, 1)
		return id
	}

	async followup(taskId: string, prompt: WorkflowPromptName, step?: number): Promise<void> {
		await this.assertUiTask(taskId)
		const task = this.requireTask(taskId)
		const previousAsk = task.taskAsk
		const previousTimestamp = Math.max(previousAsk?.ts ?? 0, task.clineMessages.at(-1)?.ts ?? 0)
		const guidance = workflowPrompt(prompt, step)
		this.activePrompt = prompt
		this.scripted?.setPhase(prompt, step)
		this.expectedCompletions.set(taskId, (this.completions.get(taskId) ?? 0) + 1)
		let admitted = false
		const onFeedback = (event: { taskId: string; action: string; message: ClineMessage }) => {
			const message = event.message
			if (
				event.taskId === taskId &&
				event.action === "created" &&
				message.type === "say" &&
				message.say === "user_feedback" &&
				message.partial !== true &&
				message.ts > previousTimestamp &&
				message.text === guidance
			)
				admitted = true
		}
		// sendMessage acknowledges webview dispatch, not Task admission. Subscribe
		// first so synchronous and delayed same-task admissions are both observed.
		this.api.on(RooCodeEventName.Message, onFeedback)
		try {
			await this.api.sendMessage(guidance)
			await this.until(() => {
				const current = this.requireTask(taskId)
				if (current !== task) throw new WorkflowFailure("lifecycle", "message_admission_task_replaced")
				if (admitted) return true
				const ask = current.taskAsk
				// Only the exact pre-dispatch boundary may remain while its response
				// crosses the webview. A new recovery/approval is not silently ignored.
				if (ask && !ask.partial && (ask.ts !== previousAsk?.ts || ask.ask !== previousAsk?.ask))
					throw unexpectedAskFailure(ask)
				return false
			}, "message_admission_timeout")
		} finally {
			this.api.off(RooCodeEventName.Message, onFeedback)
		}
	}

	async complete(taskId: string, outcome: "completed" | "blocked" = "completed"): Promise<void> {
		const expected = this.expectedCompletions.get(taskId) ?? 1
		await this.until(() => {
			if ((this.completions.get(taskId) ?? 0) >= expected) {
				if (outcome === "blocked") throw new WorkflowFailure("lifecycle", "unexpected_completed_verification")
				return true
			}
			const task = this.requireTask(taskId)
			const ask = task.taskAsk
			if (!ask || ask.partial || this.approvedAsks.has(ask.ts)) return false
			if (ask.ask === "command") {
				if (
					!isApprovedWorkflowCommand(
						ask.text ?? "",
						task.apiConversationHistory,
						this.workspace,
						workflowCommands(this.activePrompt),
					)
				) {
					throw new WorkflowFailure("policy", "unexpected_command")
				}
				this.approvedAsks.add(ask.ts)
				task.approveAsk()
			} else if (ask.ask === "completion_result") {
				if (outcome === "blocked") throw new WorkflowFailure("lifecycle", "unexpected_completed_verification")
				this.approvedAsks.add(ask.ts)
				task.approveAsk()
			} else if (ask.ask === "resume_task" && outcome === "blocked" && !task.didComplete) {
				// Do not approve or cancel the handoff. Inspect its durable interrupted turn and visible report.
				return true
			} else if (ask.ask === "api_req_failed" || ask.ask === "auto_approval_max_req_reached") {
				throw new WorkflowFailure("provider", ask.ask, true)
			} else {
				throw unexpectedAskFailure(ask)
			}
			return false
		}, "completion_boundary_timeout")
	}

	async waitForCommandApproval(taskId: string): Promise<void> {
		await this.until(() => {
			const task = this.requireTask(taskId)
			const ask = task.taskAsk
			if (ask?.ask === "command" && !ask.partial) {
				if (
					!isApprovedWorkflowCommand(
						ask.text ?? "",
						task.apiConversationHistory,
						this.workspace,
						workflowCommands(this.activePrompt),
					)
				)
					throw new WorkflowFailure("policy", "unexpected_command")
				return true
			}
			if (ask && !ask.partial) throw new WorkflowFailure("lifecycle", "expected_pending_command")
			return false
		}, "command_approval_timeout")
	}

	async cancel(taskId: string): Promise<void> {
		await this.assertUiTask(taskId)
		await this.api.cancelCurrentTask()
		await this.until(
			() => this.requireTask(taskId).taskAsk?.ask === "resume_task",
			"cancel_resume_boundary_timeout",
		)
	}

	async resume(taskId: string, prompt: WorkflowPromptName): Promise<void> {
		if (!(await this.api.isTaskInHistory(taskId))) throw new WorkflowFailure("persistence", "saved_task_missing")
		// The saved provider callback does not restore global execution policy.
		// Establish the same dedicated-profile policy before Task construction.
		await this.api.setConfiguration(this.configuration)
		this.scripted?.setPhase(prompt)
		const liveAsk = this.provider.getLiveTask(taskId)?.taskAsk?.ask
		if (liveAsk === "resume_task" || liveAsk === "resume_completed_task") {
			// cancelCurrentTask already rehydrates through the provider. Retain that
			// instance instead of adding a second replacement to the tested lifecycle.
		} else if (this.scripted) {
			// Only the offline provider needs its executable callback reinjected after
			// process exit. The same saved task, transcript and normal reload path are used.
			const { historyItem } = await this.provider.getTaskWithId(taskId)
			await this.provider.createTaskWithHistoryItem(historyItem, {
				subagentRuntime: { apiConfiguration: this.configuration },
			})
		} else await this.api.resumeTask(taskId)
		this.currentId = taskId
		await this.until(
			() => ["resume_task", "resume_completed_task"].includes(this.requireTask(taskId).taskAsk?.ask ?? ""),
			"saved_task_resume_timeout",
		)
		await this.followup(taskId, prompt)
	}

	async assertUiTask(taskId: string): Promise<void> {
		this.requireTask(taskId)
		if (!this.api.isReady() || !this.provider.viewLaunched)
			throw new WorkflowFailure("harness", "webview_not_launched", true)
		const state = await this.provider.getStateToPostToWebview()
		if (state.currentTaskId !== taskId || !this.api.getCurrentTaskStack().includes(taskId))
			throw new WorkflowFailure("lifecycle", "projected_task_identity_lost")
	}

	async inspect(taskId: string, outcome: "completed" | "blocked" = "completed"): Promise<WorkflowEvidence> {
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new WorkflowFailure("persistence", "invalid_task_id")
		const task = this.requireTask(taskId)
		// Join the existing Task-owned durability boundary, not a poll that could
		// accidentally turn a real integrity defect into a generic timeout.
		await this.until(async () => {
			try {
				if (outcome === "blocked") {
					// A resume ask is published after the turn journals flush. The task loop itself remains alive.
					if (task.taskAsk?.ask !== "resume_task" || task.didComplete)
						throw new WorkflowFailure("lifecycle", "blocked_boundary_lost")
				} else await task.waitForTermination()
				await task.flushApiConversationHistoryPersistence()
			} catch {
				throw new WorkflowFailure("persistence", "durability_boundary_failed")
			}
			return true
		}, "durable_lifecycle_timeout")
		// The provider resolves custom/shared storage through the same adapter as
		// persistence. Ignore its parsed history and independently read the file.
		const { taskDirPath: directory } = await this.provider.getTaskWithId(taskId)
		if (!path.isAbsolute(directory) || path.basename(directory) !== taskId)
			throw new WorkflowFailure("persistence", "invalid_task_storage_path")
		const history = await readBoundedJson(path.join(directory, "api_conversation_history.json"))
		const events = await readBoundedJson(path.join(directory, "agent_lifecycle_events.jsonl"), true)
		const transactions = inspectToolTransactions(history)
		const lifecycle = inspectTaskLifecycle(events, taskId)
		return {
			...transactions,
			...lifecycle,
			errors: [...transactions.errors, ...lifecycle.errors],
			trace: inspectWorkflowTrace(history, WORKFLOW_TRACE_COMMANDS),
			...(isRecoveryPhase(this.activePrompt)
				? {
						recoveryChecks: inspectRecoveryTrace(
							history,
							await readBoundedJson(path.join(directory, "ui_messages.json")),
							this.activePrompt,
						),
					}
				: {}),
		}
	}

	requestsUsed(): number {
		return this.budget.used
	}

	async dispose(): Promise<void> {
		try {
			if (this.currentId && !this.provider.getLiveTask(this.currentId)?.didComplete)
				await this.api.cancelCurrentTask()
		} finally {
			this.provider.off("taskCreated", this.onCreated)
			this.api.off(RooCodeEventName.TaskCompleted, this.onCompleted)
			for (const release of this.cleanup.reverse()) release()
			this.scripted?.dispose()
		}
	}
}
