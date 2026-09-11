import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	RooCodeEventName,
	toolNames,
	type ToolName,
	type ClineMessage,
	type RooCodeAPI,
	type RooCodeSettings,
	type ExtensionState,
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
	condenseContext(): Promise<void>
}

interface HostProvider {
	createTask(
		text: string,
		images: undefined,
		parent: undefined,
		options: { preserveExisting: true; background: true; apiConfiguration: RooCodeSettings },
		configuration: RooCodeSettings,
	): Promise<HostTask>
	closeTask(taskId: string): Promise<void>
	viewLaunched: boolean
	getLiveTask(taskId: string): HostTask | undefined
	getStateToPostToWebview(): Promise<ExtensionState>
	getTaskSettlementDiagnostics(task: HostTask): unknown
	recordPrimaryMutation(task: HostTask, ...args: unknown[]): Promise<boolean>
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
	private readonly backgroundIds = new Set<string>()
	private readonly admissions: Array<{ taskId: string; text: string; after: number }> = []
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
		terminalProvider: "execa" | "vscode" = "execa",
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
			terminalShellIntegrationDisabled: terminalProvider === "execa",
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

	private async until(condition: () => boolean | Promise<boolean>, code: string, timeoutMs?: number): Promise<void> {
		this.checkBudget()
		try {
			await waitFor(
				async () => {
					this.checkBudget()
					return condition()
				},
				{
					timeout: Math.max(1, Math.min(this.deadline - Date.now(), timeoutMs ?? Infinity)),
					interval: 50,
					description: code,
				},
			)
		} catch (error) {
			if (error instanceof WorkflowFailure) throw error
			throw new WorkflowFailure("timeout", code)
		}
	}

	async start(prompt: WorkflowPromptName, options?: { autoApprovalEnabled?: boolean }): Promise<string> {
		if (options?.autoApprovalEnabled !== undefined)
			this.configuration.autoApprovalEnabled = options.autoApprovalEnabled
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
			this.admissions.push({ taskId, text: guidance, after: previousTimestamp })
			await this.api.sendMessage(guidance)
			await this.until(
				() => {
					const current = this.requireTask(taskId)
					if (current !== task) throw new WorkflowFailure("lifecycle", "message_admission_task_replaced")
					if (admitted) return true
					const ask = current.taskAsk
					// Only the exact pre-dispatch boundary may remain while its response
					// crosses the webview. A new recovery/approval is not silently ignored.
					if (ask && !ask.partial && (ask.ts !== previousAsk?.ts || ask.ask !== previousAsk?.ask))
						throw unexpectedAskFailure(ask)
					return false
				},
				"message_admission_timeout",
				30_000,
			)
		} finally {
			this.api.off(RooCodeEventName.Message, onFeedback)
		}
	}

	async complete(taskId: string, outcome: "completed" | "blocked" | "review" = "completed"): Promise<void> {
		const expected = this.expectedCompletions.get(taskId) ?? 1
		await this.until(() => {
			if ((this.completions.get(taskId) ?? 0) >= expected) {
				if (outcome === "review") throw new WorkflowFailure("lifecycle", "review_automatically_accepted")
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
				if (outcome === "review") return true
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

	async resume(
		taskId: string,
		prompt: WorkflowPromptName,
		step?: number,
		options: { reopen?: boolean } = {},
	): Promise<void> {
		if (!(await this.api.isTaskInHistory(taskId))) throw new WorkflowFailure("persistence", "saved_task_missing")
		// The saved provider callback does not restore global execution policy.
		// Establish the same dedicated-profile policy before Task construction.
		await this.api.setConfiguration(this.configuration)
		this.scripted?.setPhase(prompt)
		const previous = options.reopen ? this.requireTask(taskId) : undefined
		const summaryCount = (task: HostTask) =>
			task.apiConversationHistory.filter((message) => record(message)?.isSummary === true).length
		const previousSummaries = previous ? summaryCount(previous) : undefined
		if (previous) {
			await previous.flushApiConversationHistoryPersistence()
			await this.provider.closeTask(taskId)
		}
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
		if (
			previous &&
			(this.requireTask(taskId) === previous || summaryCount(this.requireTask(taskId)) !== previousSummaries)
		) {
			throw new WorkflowFailure("persistence", "compacted_task_reopen_failed")
		}
		await this.followup(taskId, prompt, step)
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

	/** Capture only fixture lifecycle state; never export profile configuration or credentials. */
	async captureCompletionReview(taskId: string) {
		const task = this.requireTask(taskId)
		if (task.taskAsk?.ask !== "completion_result" || task.didComplete)
			throw new WorkflowFailure("lifecycle", "completion_review_lost")
		return this.captureTaskState(taskId)
	}

	async captureTaskState(taskId: string) {
		const task = this.requireTask(taskId)
		const state = await this.provider.getStateToPostToWebview()
		return {
			currentTaskId: state.currentTaskId,
			activeTaskId: state.activeTaskId,
			currentView: state.currentView,
			liveTaskIds: state.liveTaskIds,
			liveTasksById: { [taskId]: state.liveTasksById?.[taskId] },
			agentLifecycleSnapshots: { [taskId]: state.agentLifecycleSnapshots?.[taskId] },
			clineMessages: task.clineMessages.slice(-2),
		}
	}

	captureSettlement(taskId: string) {
		const task = this.requireTask(taskId)
		return {
			runtime: this.provider.getTaskSettlementDiagnostics(task),
			shellIntegrationWarnings: task.clineMessages.filter(
				(message) => message.say === "shell_integration_warning",
			).length,
		}
	}

	/** Explicit test fault after the real file effect/reservation, before its durable receipt. */
	injectReceiptFailureOnce() {
		const original = this.provider.recordPrimaryMutation
		let injected = false
		const replacement: HostProvider["recordPrimaryMutation"] = async (task, ...args) => {
			if (!injected && task.taskId === this.currentId) {
				injected = true
				throw Object.assign(new Error("Injected receipt persistence failure"), { code: "EBUSY" })
			}
			return original.call(this.provider, task, ...args)
		}
		this.provider.recordPrimaryMutation = replacement
		const restore = () => {
			if (this.provider.recordPrimaryMutation === replacement) this.provider.recordPrimaryMutation = original
		}
		this.cleanup.push(restore)
		return { injected: () => injected, restore }
	}

	inspectContext(taskId: string, expectedReceipt: string) {
		const task = this.requireTask(taskId)
		const handler = task.api as {
			getModel?: () => { id: string; info: { contextWindow?: number; maxTokens?: number } }
		}
		const model = handler?.getModel?.()
		const messages = task.apiConversationHistory.map(record)
		const assistant = [...messages].reverse().find((message) => message?.role === "assistant")
		const blocks: unknown[] = Array.isArray(assistant?.content) ? assistant.content : []
		const report = blocks
			.flatMap((block) => {
				const item = record(block)
				if (item?.type === "text" && typeof item.text === "string") return [item.text]
				const input = record(item?.input)
				return item?.type === "tool_use" &&
					item.name === "attempt_completion" &&
					typeof input?.result === "string"
					? [input.result]
					: []
			})
			.join("\n")
		return {
			modelContext: {
				id: model?.id,
				contextWindow: model?.info.contextWindow,
				maxTokens: model?.info.maxTokens,
				autoCondenseContext: this.configuration.autoCondenseContext,
				autoCondenseContextPercent: this.configuration.autoCondenseContextPercent,
			},
			apiMessages: messages.length,
			apiHistoryBytes: Buffer.byteLength(JSON.stringify(task.apiConversationHistory)),
			summaries: messages.filter((message) => message?.isSummary === true).length,
			emptyWarnings: task.clineMessages.filter(
				(message) => message.say === "error" && message.text === "MODEL_NO_ASSISTANT_MESSAGES",
			).length,
			receiptPresent: report.trim() === expectedReceipt,
		}
	}

	async waitForFault(condition: () => boolean): Promise<void> {
		await this.until(condition, "live_fault_boundary_timeout", 60_000)
	}

	admissionsAreUnique(taskId: string): boolean {
		const messages = this.requireTask(taskId).clineMessages
		const expected = this.admissions.filter((admission) => admission.taskId === taskId)
		return expected.every(
			(admission, index) =>
				messages.filter(
					(message) =>
						message.type === "say" &&
						message.say === "user_feedback" &&
						message.partial !== true &&
						message.text === admission.text &&
						message.ts > admission.after &&
						message.ts <= (expected[index + 1]?.after ?? Infinity),
				).length === 1,
		)
	}

	async startBackgroundReview(): Promise<string> {
		const task = await this.provider.createTask(
			workflowPrompt("review"),
			undefined,
			undefined,
			{ preserveExisting: true, background: true, apiConfiguration: this.configuration },
			{ ...this.configuration, maxConcurrentTasks: 2 },
		)
		this.backgroundIds.add(task.taskId)
		return task.taskId
	}

	async condense(taskId: string): Promise<boolean> {
		const task = this.requireTask(taskId)
		const summaries = () =>
			task.apiConversationHistory.filter((message) => record(message)?.isSummary === true).length
		const before = summaries()
		const condensing = task.condenseContext().catch(() => {
			throw new WorkflowFailure("lifecycle", "live_compaction_failed")
		})
		await this.until(
			async () => {
				await condensing
				return true
			},
			"live_compaction_timeout",
			90_000,
		)
		return summaries() > before
	}

	async cancelAtStreamBoundary(taskId: string): Promise<void> {
		await this.assertUiTask(taskId)
		const cancellation = this.api.cancelCurrentTask()
		await this.until(
			async () => {
				await cancellation
				return true
			},
			"stream_cancel_timeout",
			10_000,
		)
	}

	async waitForResumeBoundary(taskId: string): Promise<void> {
		await this.until(
			() => this.requireTask(taskId).taskAsk?.ask === "resume_task",
			"cancel_resume_boundary_timeout",
			30_000,
		)
	}

	async recoverProviderError(taskId: string, requestsBeforeFault = 0): Promise<void> {
		await this.until(
			() => {
				const task = this.requireTask(taskId)
				const ask = task.taskAsk
				if (ask?.ask === "api_req_failed" && !ask.partial) {
					task.approveAsk()
					return true
				}
				// Automatic retry is also a valid recovery, but must have reached another real request.
				return this.budget.used > requestsBeforeFault + 1
			},
			"provider_recovery_timeout",
			60_000,
		)
	}

	async dispose(): Promise<void> {
		try {
			for (const id of this.backgroundIds) await this.provider.closeTask(id)
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
