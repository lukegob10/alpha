import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	agentLifecycleEventSchema,
	TaskLifecycleState,
	TaskStatus,
	type AgentLifecycleSnapshot,
	type AlphaMessage,
	type ExtensionState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

type Scenario = "continuation" | "malformed-call" | "incomplete-output"
interface BoundaryTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	alphaMessages: AlphaMessage[]
	getActiveAskTimestamp(): number | undefined
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
interface BoundaryProvider {
	getLiveTask(id: string): BoundaryTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
	getAgentLifecycleSnapshot(taskId: string): AgentLifecycleSnapshot | undefined
	getStateToPostToWebview(): Promise<ExtensionState>
}
interface Observation {
	requests: number
	task?: BoundaryTask
	removeFromCache?: () => void
}

// FakeAI configuration is serializable; live task references remain fixture-owned.
const observations = new WeakMap<object, Observation>()
const PARTIAL = "BOUNDARY_PARTIAL_TEXT"
const FINAL = "BOUNDARY_FINAL_TEXT"
const INCOMPLETE_REASON = "Fixture ended before provider completion"
const expectedStatus = {
	continuation: "completed",
	"malformed-call": "completed",
	"incomplete-output": "interrupted",
} as const
class BoundaryAI {
	readonly id: string
	constructor(
		private readonly scenario: Scenario,
		observation: Observation,
		private readonly resolveTask: (id: string) => BoundaryTask,
	) {
		this.id = `core-boundary-${scenario}`
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		observation.task = this.resolveTask(metadata.taskId)
		const request = ++observation.requests
		assert.ok(request <= (this.scenario === "incomplete-output" ? 1 : 2), "Only one continuation is expected")
		if (request === 2) {
			if (this.scenario === "malformed-call") {
				// Completed malformed calls return correlated errors before the model
				// corrects its response, matching AgentResponseAccumulator's contract.
				assert.deepEqual(inspectToolTransactions(messages).errors, [])
				const rejected = resultFor(messages, "malformed-call")
				assert.equal(rejected.is_error, true)
				assert.match(JSON.stringify(rejected.content), /argument|parse|invalid/i)
			}
			yield { type: "text" as const, text: FINAL }
			return
		}
		yield { type: "text" as const, text: PARTIAL }
		if (this.scenario === "malformed-call") {
			yield { type: "tool_call" as const, id: "malformed-call", name: "apply_patch", arguments: "[]" }
		}
		yield {
			type: "outcome" as const,
			status: this.scenario === "incomplete-output" ? ("incomplete" as const) : ("completed" as const),
			terminal: this.scenario !== "incomplete-output",
			semanticOutputObserved: true,
			...(this.scenario === "continuation" ? { requiresContinuation: true } : {}),
			...(this.scenario === "incomplete-output" ? { reason: INCOMPLETE_REASON, retryable: false } : {}),
		}
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

function resultFor(history: unknown, callId: string): Record<string, unknown> {
	assert.ok(Array.isArray(history), "Provider history must be an array")
	const matches: Record<string, unknown>[] = []
	const messages: unknown[] = history
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("content" in message)) continue
		if (!Array.isArray(message.content)) continue
		const content: unknown[] = message.content
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "tool_result" &&
				"tool_use_id" in block &&
				block.tool_use_id === callId
			) {
				matches.push(block as Record<string, unknown>)
			}
		}
	}
	assert.equal(matches.length, 1, `Expected exactly one result for ${callId}`)
	return matches[0]!
}

function processExitCode(result: Record<string, unknown>): number {
	assert.ok(typeof result.content === "string", "Native command receipts must contain formatted output")
	const match = /^Process exited with code (-?\d+)$/m.exec(result.content)
	assert.ok(match, "The inspection must finish with an explicit process exit code")
	return Number(match[1])
}

class ReadRecoveryAI {
	readonly id = "core-missing-file-recovery"
	constructor(
		private readonly fixture: string,
		observation: Observation,
		private readonly resolveTask: (id: string) => BoundaryTask,
	) {
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		observation.task = this.resolveTask(metadata.taskId)
		const request = ++observation.requests
		assert.ok(request <= 3, "Read recovery permits one failed read, one corrected read, and a final answer")
		if (request > 1) {
			assert.deepEqual(inspectToolTransactions(messages).errors, [])
			const missing = resultFor(messages, "missing-workflow-read")
			assert.notEqual(missing.is_error, true)
			assert.equal(processExitCode(missing), 1)
			assert.ok(
				JSON.stringify(missing.content).includes("ENOENT"),
				"The first inspection must reach the filesystem",
			)
		}
		if (request === 3) {
			const result = resultFor(messages, "corrected-workflow-read")
			assert.notEqual(result.is_error, true)
			assert.equal(processExitCode(result), 0)
			assert.ok(JSON.stringify(result.content).includes("WORKFLOW_RECOVERY_ANSWER=42"))
			yield { type: "text" as const, text: "The corrected file contains WORKFLOW_RECOVERY_ANSWER=42." }
			return
		}
		yield {
			type: "tool_call" as const,
			id: request === 1 ? "missing-workflow-read" : "corrected-workflow-read",
			name: "exec_command",
			arguments: JSON.stringify({
				cmd: `node -e "console.log(require('fs').readFileSync('${request === 1 ? "missing.txt" : "answer.txt"}','utf8'))"`,
				workdir: this.fixture,
				yield_time_ms: 10_000,
				max_output_tokens: 1000,
			}),
		}
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

suite("Core response boundary contracts", function () {
	this.timeout(120_000)
	for (const scenario of ["continuation", "malformed-call", "incomplete-output"] as const) {
		test(`${scenario}: truthful terminal state and durable tool history`, async () => {
			assert.equal(vscode.version, "1.138.0")
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
			assert.ok(artifacts)
			const provider = (globalThis.api as unknown as { sidebarProvider: BoundaryProvider }).sidebarProvider
			const configuration = globalThis.api.getConfiguration()
			const observation: Observation = { requests: 0 }
			const scripted = new BoundaryAI(scenario, observation, (id) => {
				const task = provider.getLiveTask(id)
				assert.ok(task)
				return task
			})
			let completions = 0
			const onCompleted = (id: string) => {
				if (id === observation.task?.taskId) completions++
			}
			globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
			await withBoundedFixtureCleanup(async () => {
				await globalThis.api.startNewTask({
					text: "Exercise the scripted response boundary.",
					configuration: {
						...configuration,
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						autoApprovalEnabled: true,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				await waitFor(
					() => {
						const task = observation.task
						if (!task) return false
						if (scenario !== "incomplete-output") return completions === 1
						assert.equal(task.didComplete, false, "An invalid or incomplete response must not complete")
						return (
							provider.getAgentLifecycleSnapshot(task.taskId)?.status === expectedStatus[scenario] &&
							task.alphaMessages.some(
								(message) =>
									message.ts === task.getActiveAskTimestamp() &&
									message.ask === "resume_task" &&
									!message.partial,
							)
						)
					},
					{ description: `${scenario} terminal turn and published recovery boundary`, timeout: 30_000 },
				)
				const task = observation.task!
				if (scenario !== "incomplete-output") await task.waitForTermination()
				await task.flushApiConversationHistoryPersistence()
				const { taskDirPath } = await provider.getTaskWithId(task.taskId)
				const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
				const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
				const transactions = inspectToolTransactions(history)
				const lifecycle = inspectTaskLifecycle(events, task.taskId)
				const state = await provider.getStateToPostToWebview()
				const snapshot = provider.getAgentLifecycleSnapshot(task.taskId)
				const projected = state.liveTasksById?.[task.taskId]
				const recoveryAsks = task.alphaMessages.filter((message) => message.ask === "resume_task")
				assert.ok(snapshot, "Every tested terminal outcome must have canonical lifecycle state")
				const expectedCallIds = scenario === "malformed-call" ? ["malformed-call"] : []
				assert.deepEqual(snapshot.acceptedToolCallIds, expectedCallIds)
				assert.deepEqual(snapshot.effectStartedToolCallIds, [], "These responses must not start a tool effect")
				assert.deepEqual(snapshot.terminalToolCallIds, expectedCallIds)
				await fs.writeFile(
					path.join(artifacts, `core-boundary-${scenario}.json`),
					JSON.stringify(
						{
							schemaVersion: 1,
							hostVersion: vscode.version,
							provider: "scripted",
							scenario,
							taskId: task.taskId,
							requests: observation.requests,
							completions,
							didComplete: task.didComplete,
							canonicalStatus: snapshot.status,
							projected,
							recoveryAskCount: recoveryAsks.length,
							activeAskTimestamp: task.getActiveAskTimestamp(),
							effectStartedToolCallIds: snapshot.effectStartedToolCallIds,
							transactions,
							lifecycle,
						},
						null,
						2,
					),
					{ flag: "wx" },
				)
				assert.deepEqual(transactions.errors, [])
				assert.deepEqual(lifecycle.errors, [])
				assert.equal(transactions.callCount, expectedCallIds.length)
				assert.equal(transactions.resultCount, expectedCallIds.length)
				assert.equal(snapshot.status, expectedStatus[scenario])
				assert.ok(Array.isArray(events))
				const terminalEvents = events
					.map((event: unknown) => agentLifecycleEventSchema.parse(event))
					.filter((event) => event.taskId === task.taskId)
					.filter((event) => event.type === "turn_terminal")
				assert.equal(terminalEvents.length, 1)
				assert.equal(terminalEvents[0]!.payload.status, expectedStatus[scenario])
				assert.equal(snapshot.terminalEventId, terminalEvents[0]!.eventId)
				assert.ok(projected)
				assert.equal(projected.turnId, snapshot.turnId)
				assert.equal(projected.hasPendingToolCalls, false)
				assert.equal(
					state.agentLifecycleSnapshots,
					undefined,
					"UI state must omit the accumulated lifecycle journal",
				)
				assert.equal(projected.isTurnActive, false)
				assert.equal(projected.canInterrupt, false)
				if (scenario !== "incomplete-output") {
					assert.equal(observation.requests, 2)
					assert.equal(completions, 1)
					assert.equal(task.didComplete, true)
					assert.equal(lifecycle.completedTurns, 1)
					assert.equal(lifecycle.failedTurns, 0)
					assert.equal(lifecycle.cancelledTurns, 0)
					assert.equal(projected.lifecycle, TaskLifecycleState.Completed)
					assert.equal(projected.status, TaskStatus.Idle)
					assert.equal(projected.isWaitingForInput, false)
					assert.equal(recoveryAsks.length, 0)
					assert.ok(task.alphaMessages.some((message) => !message.partial && message.text === FINAL))
					assert.ok(!task.alphaMessages.some((message) => message.ask === "api_req_failed"))
					if (scenario === "continuation") {
						assert.ok(!task.alphaMessages.some((message) => message.say === "error"))
					} else {
						assert.equal(resultFor(history, "malformed-call").is_error, true)
					}
				} else {
					assert.equal(observation.requests, 1)
					assert.equal(completions, 0)
					assert.equal(task.didComplete, false)
					assert.equal(lifecycle.completedTurns, 0)
					assert.equal(lifecycle.failedTurns, 0)
					// The journal inspector groups interrupted turns under cancellation; the exact status is above.
					assert.equal(lifecycle.cancelledTurns, scenario === "incomplete-output" ? 1 : 0)
					assert.equal(projected.lifecycle, TaskLifecycleState.Waiting)
					assert.equal(projected.status, TaskStatus.Resumable)
					assert.equal(projected.isWaitingForInput, true)
					assert.equal(recoveryAsks.length, 1)
					assert.equal(Boolean(recoveryAsks[0]!.partial), false)
					assert.equal(recoveryAsks[0]!.ts, task.getActiveAskTimestamp())
					assert.equal(task.alphaMessages.filter((message) => message.say === "error").length, 1)
					assert.ok(
						!task.alphaMessages.some(
							(message) =>
								message.ask === "api_req_failed" ||
								message.ask === "completion_result" ||
								message.ask === "resume_completed_task",
						),
					)
					if (scenario === "incomplete-output") {
						assert.equal(terminalEvents[0]!.payload.reason, INCOMPLETE_REASON)
						assert.ok(
							task.alphaMessages.some(
								(message) =>
									message.say === "error" &&
									message.text ===
										"The turn ended before the task was complete. You can resume the task or send new guidance.",
							),
						)
					}
				}
			}, [
				() => globalThis.api.clearCurrentTask(),
				() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
				() => scripted.removeFromCache?.(),
				() => globalThis.api.setConfiguration(configuration),
			])
		})
	}
})

suite("Coding workflow tool recovery", function () {
	this.timeout(120_000)
	test("a missing file can be corrected without losing its failed receipt or requiring user confirmation", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace && artifacts)
		const fixture = await fs.mkdtemp(path.join(workspace, ".alpha-read-recovery-"))
		const provider = (globalThis.api as unknown as { sidebarProvider: BoundaryProvider }).sidebarProvider
		const configuration = globalThis.api.getConfiguration()
		const observation: Observation = { requests: 0 }
		const scripted = new ReadRecoveryAI(fixture, observation, (id) => {
			const task = provider.getLiveTask(id)
			assert.ok(task)
			return task
		})
		let completions = 0
		const onCompleted = (id: string) => {
			if (id === observation.task?.taskId) completions++
		}
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		await withBoundedFixtureCleanup(async () => {
			await fs.writeFile(path.join(fixture, "answer.txt"), "WORKFLOW_RECOVERY_ANSWER=42\n", { flag: "wx" })
			await globalThis.api.startNewTask({
				text: "Read the answer file. If the initial path is missing, correct it and report the value.",
				configuration: {
					...configuration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowExecute: true,
					allowedCommands: ["node"],
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(() => completions === 1, { description: "corrected read completes", timeout: 30_000 })
			const task = observation.task!
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()
			const { taskDirPath } = await provider.getTaskWithId(task.taskId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
			const transactions = inspectToolTransactions(history)
			const lifecycle = inspectTaskLifecycle(events, task.taskId)
			const snapshot = provider.getAgentLifecycleSnapshot(task.taskId)
			const failedRead = resultFor(history, "missing-workflow-read")
			const correctedRead = resultFor(history, "corrected-workflow-read")
			await fs.writeFile(
				path.join(artifacts, "core-read-recovery.json"),
				JSON.stringify({
					hostVersion: vscode.version,
					provider: "scripted",
					requests: observation.requests,
					completions,
					failedReadExitCode: processExitCode(failedRead),
					correctedReadExitCode: processExitCode(correctedRead),
					transactions,
					lifecycle,
					canonicalStatus: snapshot?.status,
				}),
				{ flag: "wx" },
			)
			assert.equal(observation.requests, 3)
			assert.equal(completions, 1)
			assert.equal(task.didComplete, true)
			assert.notEqual(failedRead.is_error, true)
			assert.equal(processExitCode(failedRead), 1)
			assert.ok(JSON.stringify(failedRead.content).includes("ENOENT"))
			assert.notEqual(correctedRead.is_error, true)
			assert.equal(processExitCode(correctedRead), 0)
			assert.ok(JSON.stringify(correctedRead.content).includes("WORKFLOW_RECOVERY_ANSWER=42"))
			assert.deepEqual(transactions, { callCount: 2, resultCount: 2, errors: [] })
			assert.deepEqual(lifecycle, { completedTurns: 1, cancelledTurns: 0, failedTurns: 0, errors: [] })
			assert.equal(snapshot?.status, "completed")
			assert.deepEqual(snapshot?.terminalToolCallIds, ["missing-workflow-read", "corrected-workflow-read"])
			assert.equal(task.getActiveAskTimestamp(), undefined)
			assert.ok(
				!task.alphaMessages.some(
					(message) =>
						message.ask === "api_req_failed" ||
						message.ask === "resume_task" ||
						message.ask === "completion_result",
				),
			)
		}, [
			() => globalThis.api.clearCurrentTask(),
			() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => scripted.removeFromCache?.(),
			() => globalThis.api.setConfiguration(configuration),
			() => fs.rm(fixture, { recursive: true, force: true }),
		])
	})
})
