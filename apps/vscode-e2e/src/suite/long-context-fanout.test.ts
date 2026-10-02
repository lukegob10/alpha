import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	TaskLifecycleState,
	managedAgentTreeProjectionSchema,
	type AlphaCodeSettings,
	type AlphaMessage,
	type ExtensionState,
} from "@alpha-code/types"

import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

const TICKET_COUNT = 5
const RESULT = "All five ticket reviews are collected."

interface LiveTask {
	taskId: string
	metadata: { task: string }
	clineMessages: AlphaMessage[]
	didComplete: boolean
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface HostProvider {
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<ExtensionState>
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

interface Observation {
	provider: HostProvider
	rootId?: string
	rootRequests: number
	childRequests: Map<string, number>
	completed: Map<string, number>
	requestBytes: Map<string, number>
	allChildrenEntered: ReturnType<typeof deferred>
	allChildrenCompleted: ReturnType<typeof deferred>
	removeFromCache?: () => void
}

// Runtime barriers stay outside the configuration serialized by the extension.
const observations = new WeakMap<object, Observation>()
class FanoutAI {
	readonly id = `long-context-fanout-${Date.now()}`
	constructor(observation: Observation) {
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(_systemPrompt: string, messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		const taskId = metadata.taskId
		const task = observation.provider.getLiveTask(taskId)
		assert.ok(task)
		observation.rootId ??= taskId
		observation.requestBytes.set(taskId, JSON.stringify(messages).length)
		if (taskId !== observation.rootId) {
			assert.equal(observation.childRequests.has(taskId), false, "Each review needs one model request")
			const ticket = /CHILD_TICKET_(\d+)/u.exec(task.metadata.task)?.[1]
			assert.ok(ticket, "The child's own objective must identify its ticket")
			observation.childRequests.set(taskId, Number(ticket))
			if (observation.childRequests.size === TICKET_COUNT) observation.allChildrenEntered.resolve()
			// No child can finish until all five are admitted and sampling concurrently.
			await observation.allChildrenEntered.promise
			yield { type: "text" as const, text: `RESULT_AGENT_TICKET_${ticket}` }
			return
		}

		const request = ++observation.rootRequests
		if (request === 1) {
			const serialized = JSON.stringify(messages)
			for (let index = 1; index <= TICKET_COUNT; index++) {
				assert.ok(serialized.includes(`APP-${index}`), "Every requested ticket must reach the model")
				yield {
					type: "tool_call" as const,
					id: `fanout-spawn-${index}`,
					name: "spawn_agent",
					arguments: JSON.stringify({
						task_name: `ticket_${index}`,
						agent_type: "explorer",
						message: `CHILD_TICKET_${index}: Review APP-${index} read-only and return its review receipt.`,
						fork_turns: "all",
					}),
				}
			}
			return
		}
		if (request === 2) {
			await observation.allChildrenCompleted.promise
			yield {
				type: "tool_call" as const,
				id: "fanout-wait",
				name: "wait_agent",
				arguments: JSON.stringify({ timeout_ms: 10_000 }),
			}
			return
		}
		assert.equal(request, 3, "Collecting the completed reviews must not enter an unbounded loop")
		const serialized = JSON.stringify(messages)
		for (let index = 1; index <= TICKET_COUNT; index++) {
			assert.ok(
				serialized.includes(`RESULT_AGENT_TICKET_${index}`),
				"Every terminal result must reach the parent",
			)
		}
		yield { type: "text" as const, text: RESULT }
	}
	getModel() {
		return { id: this.id, info: { contextWindow: 1_000_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens(content: unknown[]) {
		return Math.ceil(JSON.stringify(content).length / 4)
	}
	async completePrompt() {
		return ""
	}
}

suite("Large ticket prompt and parallel agents", function () {
	this.timeout(120_000)
	test("admits five concurrent reviews, collects every result, and becomes idle once", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifacts)
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider: HostProvider }).sidebarProvider
		const configuration = api.getConfiguration()
		const observation: Observation = {
			provider,
			rootRequests: 0,
			childRequests: new Map(),
			completed: new Map(),
			requestBytes: new Map(),
			allChildrenEntered: deferred(),
			allChildrenCompleted: deferred(),
		}
		const model = new FanoutAI(observation)
		const onCompleted = (taskId: string) => {
			observation.completed.set(taskId, (observation.completed.get(taskId) ?? 0) + 1)
			if (
				[...observation.childRequests.keys()].filter((id) => observation.completed.has(id)).length ===
				TICKET_COUNT
			) {
				observation.allChildrenCompleted.resolve()
			}
		}
		const failures: string[] = []
		const onToolFailed = (_taskId: string, tool: string, error: string) => failures.push(`${tool}: ${error}`)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.on(AlphaCodeEventName.TaskToolFailed, onToolFailed)
		const tickets = Array.from({ length: TICKET_COUNT }, (_, index) => ({
			key: `APP-${index + 1}`,
			title: `Review app requirement ${index + 1}`,
			description: "Preserve this requirement and its acceptance evidence. ".repeat(1100),
		}))
		const prompt = `Use five Explore agents to review these tickets read-only, collect all their results, and complete:\n${JSON.stringify(tickets)}`
		assert.ok(prompt.length >= 250_000)
		await withBoundedFixtureCleanup(async () => {
			const taskConfiguration = {
				...configuration,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowSubagents: true,
				alwaysAllowReadOnly: true,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				maxConcurrentTasks: 6,
				maxConcurrentSubagents: 5,
				subagentMaxDepth: 1,
				subagentDelegationPolicy: "proactive",
				subagentMaxInputTokens: 250_000,
				subagentRootTokenBudget: null,
				subagentRootCostBudget: null,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				autoCondenseContextScope: "full-context",
				postTurnCondenseContextPercent: 0,
			} satisfies AlphaCodeSettings
			await api.setConfiguration(taskConfiguration)
			const taskId = await api.startNewTask({ text: prompt, configuration: taskConfiguration })
			await waitFor(() => observation.completed.has(taskId), {
				timeout: 60_000,
				description: "large prompt and five concurrent agent results",
				onTimeout: async () => ({
					rootRequests: observation.rootRequests,
					childrenStarted: observation.childRequests.size,
					completedTasks: observation.completed.size,
					failures,
					state: await provider.getStateToPostToWebview(),
				}),
			})
			const root = provider.getLiveTask(taskId)
			assert.ok(root)
			await root.waitForTermination()
			await root.flushApiConversationHistoryPersistence()
			const state = await provider.getStateToPostToWebview()
			const tree = managedAgentTreeProjectionSchema.parse(state.managedAgentTree)
			const { taskDirPath } = await provider.getTaskWithId(taskId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const transactions = inspectToolTransactions(history)
			await fs.writeFile(
				path.join(artifacts, "long-context-fanout.json"),
				JSON.stringify(
					{
						hostVersion: vscode.version,
						provider: "scripted",
						promptBytes: Buffer.byteLength(prompt),
						rootRequests: observation.rootRequests,
						childRequests: [...observation.childRequests],
						requestBytes: [...observation.requestBytes],
						completionCounts: [...observation.completed],
						failures,
						tree,
						transactions,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
			assert.deepEqual(failures, [])
			assert.equal(observation.childRequests.size, TICKET_COUNT)
			assert.equal(observation.rootRequests, 3)
			assert.equal(observation.completed.size, TICKET_COUNT + 1)
			assert.ok([...observation.completed.values()].every((count) => count === 1))
			assert.equal(tree.rootTaskId, taskId)
			assert.equal(tree.capacity.active, 0)
			assert.equal(tree.capacity.queued, 0)
			assert.equal(tree.capacity.terminal, TICKET_COUNT)
			assert.equal(root.didComplete, true)
			assert.equal(state.liveTasksById?.[taskId]?.lifecycle, TaskLifecycleState.Completed)
			assert.equal(state.liveTasksById?.[taskId]?.isTurnActive, false)
			assert.equal(state.liveTasksById?.[taskId]?.isWaitingForInput, false)
			assert.deepEqual(transactions.errors, [])
			assert.equal(transactions.callCount, TICKET_COUNT + 1)
			assert.equal(transactions.resultCount, TICKET_COUNT + 1)
			assert.ok(root.clineMessages.some((message) => !message.partial && message.text === RESULT))
		}, [
			() => {
				observation.allChildrenEntered.resolve()
				observation.allChildrenCompleted.resolve()
			},
			() => api.clearCurrentTask(),
			() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => api.off(AlphaCodeEventName.TaskToolFailed, onToolFailed),
			() => model.removeFromCache?.(),
			() => api.setConfiguration(configuration),
		])
	})
})
