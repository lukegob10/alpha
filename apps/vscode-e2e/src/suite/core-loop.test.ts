import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { RooCodeEventName, TaskLifecycleState, type ClineMessage, type ExtensionState } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface SmallTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: ClineMessage
	clineMessages: ClineMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface Provider {
	getLiveTask(id: string): SmallTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<ExtensionState>
}

interface Observation {
	requests: number
	task?: SmallTask
	removeFromCache?: () => void
}

// FakeAI settings are serialized by the extension; host objects and callbacks stay out of that payload.
const observations = new WeakMap<object, Observation>()
const ANSWER = "42"
class SmallTaskAI {
	readonly id: string
	constructor(
		sample: number,
		observation: Observation,
		private readonly resolveTask: (id: string) => SmallTask,
	) {
		this.id = `core-small-task-${sample}`
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
		assert.equal(++observation.requests, 1, "Small answers must not require a repair or confirmation request")
		yield { type: "text" as const, text: ANSWER }
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

suite("Core loop proportional completion", function () {
	this.timeout(120_000)
	for (let sample = 1; sample <= 3; sample++) {
		test(`small answer ${sample}: one request, zero tools, one durable completion`, async () => {
			assert.equal(vscode.version, "1.122.1")
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
			assert.ok(artifacts)
			const provider = (globalThis.api as unknown as { sidebarProvider: Provider }).sidebarProvider
			const configuration = globalThis.api.getConfiguration()
			const observation: Observation = { requests: 0 }
			const scripted = new SmallTaskAI(sample, observation, (id) => {
				const task = provider.getLiveTask(id)
				assert.ok(task)
				return task
			})
			let completions = 0
			const onCompleted = (id: string) => {
				if (id === observation.task?.taskId) completions++
			}
			globalThis.api.on(RooCodeEventName.TaskCompleted, onCompleted)
			const acknowledge = createCompletionReviewAcknowledger()
			await withBoundedFixtureCleanup(async () => {
				await globalThis.api.startNewTask({
					text: "What is 6 times 7? Reply with the number.",
					configuration: {
						...configuration,
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "ask",
						autoApprovalEnabled: true,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				await waitFor(
					() => {
						const task = observation.task
						if (task?.taskAsk && !task.taskAsk.partial)
							assert.equal(
								task.taskAsk.ask,
								"completion_result",
								"Unexpected approval or recovery boundary",
							)
						acknowledge(task)
						return completions > 0
					},
					{ description: "small answer completion", timeout: 30_000 },
				)
				const task = observation.task!
				await waitFor(
					async () => {
						await task.waitForTermination()
						await task.flushApiConversationHistoryPersistence()
						return true
					},
					{ description: "small answer durable settlement", timeout: 30_000 },
				)
				const { taskDirPath } = await provider.getTaskWithId(task.taskId)
				const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
				const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
				const transactions = inspectToolTransactions(history)
				const lifecycle = inspectTaskLifecycle(events, task.taskId)
				const state = await provider.getStateToPostToWebview()
				const projected = state.liveTasksById?.[task.taskId]
				const evidence = {
					schemaVersion: 1,
					hostVersion: vscode.version,
					provider: "scripted",
					sample,
					taskId: task.taskId,
					requests: observation.requests,
					completions,
					runtime: { didComplete: task.didComplete, abort: task.abort },
					projected,
					transactions,
					lifecycle,
				}
				// Write before assertions: a status disagreement must remain inspectable after failure.
				await fs.writeFile(
					path.join(artifacts, `core-small-task-${sample}.json`),
					JSON.stringify(evidence, null, 2),
					{ flag: "wx" },
				)
				assert.equal(observation.requests, 1)
				assert.equal(completions, 1)
				assert.equal(task.didComplete, true)
				assert.equal(task.abort, false)
				assert.equal(state.currentTaskId, task.taskId)
				assert.ok(projected)
				assert.equal(projected.lifecycle, TaskLifecycleState.Completed)
				assert.equal(projected.isStreaming, false)
				assert.notEqual(projected.isTurnActive, true)
				assert.deepEqual(transactions.errors, [])
				assert.equal(transactions.callCount, 0)
				assert.equal(transactions.resultCount, 0)
				assert.deepEqual(lifecycle.errors, [])
				assert.equal(lifecycle.completedTurns, 1)
				assert.equal(lifecycle.failedTurns, 0)
				assert.equal(lifecycle.cancelledTurns, 0)
				assert.ok(task.clineMessages.some((message) => !message.partial && message.text === ANSWER))
				assert.ok(
					!task.clineMessages.some(
						(message) => message.ask === "resume_task" || message.ask === "api_req_failed",
					),
				)
			}, [
				() => globalThis.api.clearCurrentTask(),
				() => globalThis.api.off(RooCodeEventName.TaskCompleted, onCompleted),
				() => scripted.removeFromCache?.(),
				() => globalThis.api.setConfiguration(configuration),
			])
		})
	}
})
