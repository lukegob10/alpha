import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	TaskLifecycleState,
	agentLifecycleEventSchema,
	type AlphaMessage,
	type ExtensionState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface SmallTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
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

interface ReadObservation extends Observation {
	startedBeforeEof?: string[]
	preEofJournal?: unknown[]
}

const readProviders = new WeakMap<object, Provider>()

class CommandReadAI {
	readonly id = "core-workdir-read-stream"
	constructor(
		observation: ReadObservation,
		private readonly calls: Array<{ id: string; workdir: string }>,
		provider: Provider,
	) {
		observations.set(this, observation)
		readProviders.set(this, provider)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)! as ReadObservation
		const provider = readProviders.get(this)!
		assert.ok(metadata?.taskId)
		const task = provider.getLiveTask(metadata.taskId)
		assert.ok(task)
		observation.task = task
		const request = ++observation.requests
		assert.ok(request <= 2, "The inspection must not need synthetic repair requests")
		if (request === 2) {
			const transactions = inspectToolTransactions(messages)
			assert.deepEqual(transactions.errors, [])
			assert.equal(transactions.callCount, this.calls.length)
			assert.equal(transactions.resultCount, this.calls.length)
			yield { type: "text" as const, text: "WORKDIR_INSPECTION_COMPLETE" }
			return
		}
		for (const call of this.calls) {
			yield {
				type: "tool_call" as const,
				id: call.id,
				name: "exec_command",
				arguments: JSON.stringify({ cmd: "rg -n ALPHA_EARLY_READ_SENTINEL .", workdir: call.workdir }),
			}
			yield { type: "tool_call_end" as const, id: call.id }
		}
		await waitFor(
			async () => {
				const state = await provider.getStateToPostToWebview()
				const snapshot = state.agentLifecycleSnapshots?.[task.taskId]
				if (!snapshot || !this.calls.every(({ id }) => snapshot.effectStartedToolCallIds?.includes(id)))
					return false
				observation.startedBeforeEof = [...snapshot.effectStartedToolCallIds!]
				assert.deepEqual(
					snapshot.terminalToolCallIds,
					[],
					"Results must stay deferred while the provider stream is open",
				)
				return true
			},
			{ description: "both workspace reads start before provider EOF", timeout: 15_000 },
		)
		const { taskDirPath } = await provider.getTaskWithId(task.taskId)
		const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
		assert.ok(Array.isArray(events))
		observation.preEofJournal = events
		const parsed = events.map((event) => agentLifecycleEventSchema.parse(event))
		for (const call of this.calls) {
			const accepted = parsed.findIndex(
				(event) => event.type === "tool_call_accepted" && event.payload.item.toolCallId === call.id,
			)
			const started = parsed.findIndex(
				(event) => event.type === "tool_effect_started" && event.payload.toolCallId === call.id,
			)
			assert.ok(accepted >= 0 && started > accepted, "Durable acceptance must precede the read effect")
		}
		assert.ok(
			!task.clineMessages.some((message) => message.say === "command_output"),
			"Read presentation must await the durable assistant transcript",
		)
		yield { type: "outcome" as const, status: "completed" as const, terminal: true, semanticOutputObserved: true }
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

suite("Workspace read streaming", function () {
	this.timeout(120_000)
	test("absolute and nested reads start before EOF with durable, ordered tool results", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(artifacts && workspace)
		const fixture = await fs.mkdtemp(path.join(workspace, ".alpha-workdir-read-"))
		await fs.writeFile(path.join(fixture, "sentinel.txt"), "ALPHA_EARLY_READ_SENTINEL\n")
		const provider = (globalThis.api as unknown as { sidebarProvider: Provider }).sidebarProvider
		const configuration = globalThis.api.getConfiguration()
		const observation: ReadObservation = { requests: 0 }
		const calls = [
			{ id: "absolute-workdir-read", workdir: fixture },
			{ id: "nested-workdir-read", workdir: path.relative(workspace, fixture) },
		]
		const scripted = new CommandReadAI(observation, calls, provider)
		let completions = 0
		const onCompleted = (id: string) => {
			if (id === observation.task?.taskId) completions++
		}
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		await withBoundedFixtureCleanup(async () => {
			await globalThis.api.startNewTask({
				text: "Inspect the controlled directory through the streamed command calls.",
				configuration: {
					...configuration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: ["rg"],
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(() => completions === 1, { description: "streamed inspection completion", timeout: 30_000 })
			const task = observation.task!
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()
			const { taskDirPath } = await provider.getTaskWithId(task.taskId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
			const transactions = inspectToolTransactions(history)
			const lifecycle = inspectTaskLifecycle(events, task.taskId)
			const snapshot = (await provider.getStateToPostToWebview()).agentLifecycleSnapshots?.[task.taskId]
			await fs.writeFile(
				path.join(artifacts, "core-workdir-read-stream.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						hostVersion: vscode.version,
						provider: "scripted",
						taskId: task.taskId,
						requests: observation.requests,
						completions,
						startedBeforeEof: observation.startedBeforeEof,
						preEofJournal: observation.preEofJournal,
						transactions,
						lifecycle,
						snapshot,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
			assert.equal(observation.requests, 2)
			assert.equal(completions, 1)
			assert.deepEqual(
				observation.startedBeforeEof,
				calls.map(({ id }) => id),
			)
			assert.deepEqual(
				snapshot?.terminalToolCallIds,
				calls.map(({ id }) => id),
			)
			assert.deepEqual(transactions.errors, [])
			assert.equal(transactions.callCount, 2)
			assert.equal(transactions.resultCount, 2)
			assert.deepEqual(lifecycle.errors, [])
			assert.equal(lifecycle.completedTurns, 1)
			assert.ok(
				task.clineMessages.some(
					(message) =>
						message.say === "command_output" &&
						message.text?.includes("sentinel.txt:1:ALPHA_EARLY_READ_SENTINEL"),
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

suite("Core loop proportional completion", function () {
	this.timeout(120_000)
	for (let sample = 1; sample <= 3; sample++) {
		test(`small answer ${sample}: one request, zero tools, one durable completion`, async () => {
			assert.equal(vscode.version, "1.125.0")
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
			globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
			await withBoundedFixtureCleanup(async () => {
				await globalThis.api.startNewTask({
					text: "What is 6 times 7? Reply with the number.",
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
						assert.ok(
							!task?.taskAsk || task.taskAsk.partial,
							"A small answer must not wait for user acknowledgement",
						)
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
				assert.ok(!task.clineMessages.some((message) => message.ask === "completion_result"))
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
				() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
				() => scripted.removeFromCache?.(),
				() => globalThis.api.setConfiguration(configuration),
			])
		})
	}
})
