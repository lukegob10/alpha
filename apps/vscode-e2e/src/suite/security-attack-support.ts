import assert from "node:assert/strict"
import * as path from "node:path"
import * as vscode from "vscode"
import { AlphaCodeEventName, type AlphaCodeSettings, type AlphaMessage, type McpServer } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"
import {
	securityTerminalResults,
	securityTransactions,
	securityDecision,
	assertSecurityDecisionHealthy,
	assertSecurityToolVisible,
	type SecurityDecisionState,
	type SecurityResultStatus,
	type SecurityTransaction,
} from "../scenarios/securityAttackFixture"
import { assertOwnedTestWorkspace } from "../testProfile"
import { assistantVisibleText } from "./live-transcript-support"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

export interface SecurityTask {
	taskId: string
	api: unknown
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	denyAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
	getTaskMode(): Promise<string>
}

export interface SecurityMcpHub {
	isConnecting: boolean
	getServers(): McpServer[]
	getAllServers(): McpServer[]
	refreshAllConnections(): Promise<void>
	updateServerConnections(servers: Record<string, unknown>, source: "project"): Promise<void>
}

export interface SecurityProvider {
	getLiveTask(taskId: string): SecurityTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getActiveTaskId(): string | undefined
	getMcpHub(): SecurityMcpHub | undefined
	createTask(
		text: string,
		images: undefined,
		parent: undefined,
		options: { preserveExisting: true; background: true; apiConfiguration: AlphaCodeSettings },
		configuration: AlphaCodeSettings,
	): Promise<SecurityTask>
	removeTaskFromStack(options: { taskId: string }): Promise<void>
	on(event: "taskCreated", listener: (task: SecurityTask) => void): void
	off(event: "taskCreated", listener: (task: SecurityTask) => void): void
}

export interface SecurityCall {
	id: string
	name: string
	arguments: Record<string, unknown>
	/** Ordinary discovery/invocation probes must not accidentally force a hidden tool. */
	requireVisible?: boolean
}

interface SecurityRuntime extends SecurityDecisionState {
	calls: readonly SecurityCall[]
	observedInputs: Array<{ messages: unknown[]; tools: unknown[] }>
	beforeRequest?: (index: number, taskId: string) => Promise<void>
	removeFromCache?: () => void
}

const runtimes = new WeakMap<object, SecurityRuntime>()

class SecurityAI {
	readonly id = "security-authority-scripted"
	constructor(runtime: SecurityRuntime) {
		runtimes.set(this, runtime)
	}
	get removeFromCache() {
		return runtimes.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		runtimes.get(this)!.removeFromCache = value
	}
	async *createMessage(
		_system: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; tools?: unknown[] },
	) {
		const runtime = runtimes.get(this)!
		assertSecurityDecisionHealthy(runtime)
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Security fixture" }
			return
		}
		yield await securityDecision(runtime, async (index) => {
			assert.ok(metadata?.taskId)
			assert.ok(
				index <= runtime.calls.length,
				"The security fixture must not recover through extra provider requests",
			)
			runtime.observedInputs.push({
				messages: structuredClone(messages),
				tools: structuredClone(metadata.tools ?? []),
			})
			await runtime.beforeRequest?.(index, metadata.taskId)
			const call = runtime.calls[index]
			if (call?.requireVisible) assertSecurityToolVisible(metadata.tools ?? [], call.name)
			return call
				? {
						type: "tool_call" as const,
						id: call.id,
						name: call.name,
						arguments: JSON.stringify(call.arguments),
					}
				: { type: "text" as const, text: "42" }
		})
	}
	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens() {
		return 1
	}
	async completePrompt() {
		return ""
	}
}

export function securityProvider(): SecurityProvider {
	return (globalThis.api as unknown as { sidebarProvider: SecurityProvider }).sidebarProvider
}

export interface SecurityHostOutcome {
	taskId: string
	transactions: SecurityTransaction[]
	terminalResults: Map<string, SecurityResultStatus>
	answer: string
	requests: number
	reviews: string[]
	observedInputs: SecurityRuntime["observedInputs"]
}

/** The same real task path serves scripted enforcement probes and separately labelled optional live observations. */
export async function runSecurityHostCase(options: {
	prompt: string
	calls?: readonly SecurityCall[]
	mode?: "code" | "architect"
	configuration?: Partial<AlphaCodeSettings>
	live?: boolean
	background?: boolean
	retainTask?: boolean
	onAsk?: (task: SecurityTask, ask: AlphaMessage) => Promise<void>
	beforeRequest?: SecurityRuntime["beforeRequest"]
}): Promise<SecurityHostOutcome> {
	assert.equal(vscode.version, "1.138.0")
	assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, options.live ? "live-copilot" : "scripted")
	const workspace = process.env.ALPHA_E2E_WORKSPACE
	assert.ok(workspace)
	await assertOwnedTestWorkspace(workspace, process.env.ALPHA_E2E_PROFILE_DIR)
	const api = globalThis.api
	const original = api.getConfiguration()
	const provider = securityProvider()
	const runtime: SecurityRuntime = {
		requests: 0,
		calls: options.calls ?? [],
		observedInputs: [],
		beforeRequest: options.beforeRequest,
	}
	const model = new SecurityAI(runtime)
	const acknowledge = createCompletionReviewAcknowledger()
	const handled = new Set<number>()
	const reviews: string[] = []
	const budget = new WorkflowRequestBudget(10, process.env.ALPHA_E2E_ACTUAL_MODEL_ID)
	let task: SecurityTask | undefined
	let completions = 0
	const releases: Array<() => void> = []
	const onCreated = (created: SecurityTask) => {
		if (task) return
		task = created
		if (options.live) releases.push(guardTaskApi(created, budget))
	}
	const onCompleted = (taskId: string) => {
		if (taskId === task?.taskId) completions++
	}
	provider.on("taskCreated", onCreated)
	api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
	return withBoundedFixtureCleanup(async () => {
		const configuration: AlphaCodeSettings = {
			...original,
			mode: options.mode ?? "code",
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			allowedCommands: [],
			deniedCommands: [],
			alwaysAllowMcp: false,
			mcpEnabled: false,
			alwaysAllowSubagents: false,
			alwaysAllowFollowupQuestions: false,
			disabledTools: [],
			enableCheckpoints: false,
			terminalShellIntegrationDisabled: true,
			requestDelaySeconds: 0,
			writeDelayMs: 0,
			allowedMaxRequests: 10,
			...options.configuration,
			...(options.live ? {} : { apiProvider: "fake-ai", fakeAi: model }),
		}
		const taskId = options.background
			? (
					await provider.createTask(
						options.prompt,
						undefined,
						undefined,
						{ preserveExisting: true, background: true, apiConfiguration: configuration },
						configuration,
					)
				).taskId
			: await api.startNewTask({ text: options.prompt, configuration })
		task ??= provider.getLiveTask(taskId)
		assert.ok(task)
		assert.equal(task.taskId, taskId)
		await waitFor(
			async () => {
				assertSecurityDecisionHealthy(runtime)
				if (budget.failure) throw budget.failure
				assert.equal(budget.exhausted, false, "The live security probe exceeded its declared request budget")
				const ask = task!.taskAsk
				if (ask && !ask.partial && !ask.isAnswered && !handled.has(ask.ts)) {
					handled.add(ask.ts)
					if (ask.ask !== "completion_result" && ask.ask !== "command_output") {
						reviews.push(ask.ask ?? "")
						assert.ok(options.onAsk, "Unexpected security fixture review: " + ask.ask)
						await options.onAsk(task!, ask)
					}
				}
				acknowledge(task)
				return task!.didComplete
			},
			{ timeout: 150_000, description: "the real security task completing after its tool results" },
		)
		await task.waitForTermination()
		await task.flushApiConversationHistoryPersistence()
		assert.equal(completions, 1, "Security task completion must be exactly once")
		const { taskDirPath } = await provider.getTaskWithId(taskId)
		const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
		const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
		const transactions = securityTransactions(history)
		const terminalResults = securityTerminalResults(events, taskId)
		for (const transaction of transactions)
			assert.ok(
				terminalResults.has(transaction.id),
				"Every persisted security call needs canonical terminal evidence",
			)
		assert.ok(Array.isArray(history))
		const assistantAnswer = history
			.filter((message) => message && typeof message === "object" && message.role === "assistant")
			.map((message) => assistantVisibleText(message.content))
			.filter((text) => text.trim())
			.at(-1)
		const completion = transactions.filter((call) => call.name === "attempt_completion").at(-1)?.input.result
		const answer = assistantAnswer ?? (typeof completion === "string" ? completion : "")
		if (options.live) assert.ok(budget.used > 0, "A live label requires actual selected-model requests")
		return {
			taskId,
			transactions,
			terminalResults,
			answer,
			requests: options.live ? budget.used : runtime.requests,
			reviews,
			observedInputs: runtime.observedInputs,
		}
	}, [
		() => {
			if (task && !options.retainTask) return provider.removeTaskFromStack({ taskId: task.taskId })
		},
		() => provider.off("taskCreated", onCreated),
		() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
		() => {
			for (const release of releases) release()
		},
		() => model.removeFromCache?.(),
		() => api.setConfiguration(original),
	])
}

export async function writeSecurityReceipt(name: string, payload: Record<string, unknown>): Promise<void> {
	assert.match(name, /^[a-z0-9-]+$/)
	const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
	assert.ok(artifacts)
	const fs = await import("node:fs/promises")
	await fs.writeFile(
		path.join(artifacts, name + ".json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				hostVersion: vscode.version,
				provider: process.env.ALPHA_E2E_PROVIDER_MODE,
				model: process.env.ALPHA_E2E_ACTUAL_MODEL_ID,
				effort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
				scope: "bounded security fixture; no universal safety claim",
				...payload,
			},
			null,
			2,
		),
		{ flag: "wx" },
	)
}

export function assertSecurityDenial(outcome: SecurityHostOutcome, callId: string): void {
	const transaction = outcome.transactions.find((call) => call.id === callId)
	assert.ok(transaction, "The forced forbidden call must reach the real task")
	assert.equal(transaction.isError, true, "Denied calls must not become successful provider receipts")
	assert.equal(outcome.terminalResults.get(callId), "denied")
}
