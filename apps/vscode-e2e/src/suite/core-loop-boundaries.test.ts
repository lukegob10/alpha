import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	agentLifecycleEventSchema,
	TaskLifecycleState,
	TaskStatus,
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
	clineMessages: AlphaMessage[]
	getActiveAskTimestamp(): number | undefined
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
interface BoundaryProvider {
	getLiveTask(id: string): BoundaryTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
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
	"malformed-call": "failed",
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
	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		observation.task = this.resolveTask(metadata.taskId)
		const request = ++observation.requests
		assert.ok(request <= (this.scenario === "continuation" ? 2 : 1), "No synthetic repair request is expected")
		if (request === 2) {
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

suite("Core response boundary contracts", function () {
	this.timeout(120_000)
	for (const scenario of ["continuation", "malformed-call", "incomplete-output"] as const) {
		test(`${scenario}: truthful terminal state and durable tool history`, async () => {
			assert.equal(vscode.version, "1.125.0")
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
					async () => {
						const task = observation.task
						if (!task) return false
						if (scenario === "continuation") return completions === 1
						assert.equal(task.didComplete, false, "An invalid or incomplete response must not complete")
						const state = await provider.getStateToPostToWebview()
						return (
							state.agentLifecycleSnapshots?.[task.taskId]?.status === expectedStatus[scenario] &&
							task.clineMessages.some(
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
				if (scenario === "continuation") await task.waitForTermination()
				await task.flushApiConversationHistoryPersistence()
				const { taskDirPath } = await provider.getTaskWithId(task.taskId)
				const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
				const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
				const transactions = inspectToolTransactions(history)
				const lifecycle = inspectTaskLifecycle(events, task.taskId)
				const state = await provider.getStateToPostToWebview()
				const snapshot = state.agentLifecycleSnapshots?.[task.taskId]
				const projected = state.liveTasksById?.[task.taskId]
				const recoveryAsks = task.clineMessages.filter((message) => message.ask === "resume_task")
				assert.ok(snapshot, "Every tested terminal outcome must have canonical lifecycle state")
				assert.deepEqual(snapshot.acceptedToolCallIds, [])
				assert.deepEqual(snapshot.effectStartedToolCallIds, [], "These responses must not start a tool effect")
				assert.deepEqual(snapshot.terminalToolCallIds, [])
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
				assert.equal(transactions.callCount, 0)
				assert.equal(transactions.resultCount, 0)
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
				assert.equal(projected.isTurnActive, false)
				assert.equal(projected.canInterrupt, false)
				if (scenario === "continuation") {
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
					assert.ok(task.clineMessages.some((message) => !message.partial && message.text === FINAL))
					assert.ok(
						!task.clineMessages.some(
							(message) => message.say === "error" || message.ask === "api_req_failed",
						),
					)
				} else {
					assert.equal(observation.requests, 1)
					assert.equal(completions, 0)
					assert.equal(task.didComplete, false)
					assert.equal(lifecycle.completedTurns, 0)
					assert.equal(lifecycle.failedTurns, scenario === "malformed-call" ? 1 : 0)
					// The journal inspector groups interrupted turns under cancellation; the exact status is above.
					assert.equal(lifecycle.cancelledTurns, scenario === "incomplete-output" ? 1 : 0)
					assert.equal(projected.lifecycle, TaskLifecycleState.Waiting)
					assert.equal(projected.status, TaskStatus.Resumable)
					assert.equal(projected.isWaitingForInput, true)
					assert.equal(recoveryAsks.length, 1)
					assert.equal(Boolean(recoveryAsks[0]!.partial), false)
					assert.equal(recoveryAsks[0]!.ts, task.getActiveAskTimestamp())
					assert.equal(task.clineMessages.filter((message) => message.say === "error").length, 1)
					assert.ok(
						!task.clineMessages.some(
							(message) =>
								message.ask === "api_req_failed" ||
								message.ask === "completion_result" ||
								message.ask === "resume_completed_task",
						),
					)
					if (scenario === "incomplete-output") {
						assert.equal(terminalEvents[0]!.payload.reason, INCOMPLETE_REASON)
						assert.ok(
							task.clineMessages.some(
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
