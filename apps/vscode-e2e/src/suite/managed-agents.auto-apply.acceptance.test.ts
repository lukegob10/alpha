import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	agentControlStateSchema,
	managedAgentTreeProjectionSchema,
	subagentGroupStateSchema,
	type AlphaCodeSettings,
	type AlphaMessage,
	type ExtensionState,
	type SubagentGroupState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

const FIXTURE_DIRECTORY = "managed-auto-apply"
const STATE_PATH = `${FIXTURE_DIRECTORY}/state.mjs`
const STEERING = "AUTO_APPLY_PARENT_STEERING: verify the applied Worker result and finish."
const RESULT = "Collected all five agent outcomes and verified the automatically applied change."
const CHILD_COUNT = 5
const execFile = promisify(execFileCallback)

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

interface LiveTask {
	taskId: string
	metadata: { task: string }
	clineMessages: AlphaMessage[]
	didComplete: boolean
	messageQueueService: { hasUnconsumedInput(): boolean }
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
	steerUserMessageDurably(text: string, images: string[], receiptId: string): Promise<void>
}

interface HostProvider {
	context: { globalStorageUri: { fsPath: string } }
	agentControlStore: { getSnapshot(): unknown }
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<ExtensionState>
	cancelAgent(parent: LiveTask, target: string, reason: string): Promise<unknown>
}

interface Observation {
	provider: HostProvider
	rootTaskId?: string
	rootRequests: number
	childIds: Map<number, string>
	childRequests: Map<string, number>
	allChildrenEntered: ReturnType<typeof deferred>
	waitingForSteering: boolean
	steeringObserved: boolean
	verificationIssued: boolean
	removeFromCache?: () => void
}

type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

function toolCall(id: string, name: string, args: Record<string, unknown>): ScriptChunk {
	return { type: "tool_call", id, name, arguments: JSON.stringify(args) }
}

function terminalReports(messages: unknown[]): Set<string> {
	const taskIds = new Set<string>()
	for (const message of messages) {
		if (!message || typeof message !== "object" || !("content" in message)) continue
		if (!Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (!block || block.type !== "text" || typeof block.text !== "string") continue
			let notification: unknown
			try {
				notification = JSON.parse(block.text)
			} catch {
				continue
			}
			if (!notification || typeof notification !== "object") continue
			if (!("source" in notification) || notification.source !== "managed_agent_notification") continue
			if (!("kind" in notification) || notification.kind !== "result") continue
			if (!("payload" in notification) || !notification.payload || typeof notification.payload !== "object")
				continue
			if ("taskId" in notification.payload && typeof notification.payload.taskId === "string") {
				taskIds.add(notification.payload.taskId)
			}
		}
	}
	return taskIds
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

function groupsFor(task: LiveTask): SubagentGroupState[] {
	return task.clineMessages.flatMap((message) =>
		message.subagentGroup?.parentTaskId === task.taskId ? [message.subagentGroup] : [],
	)
}

// Runtime barriers are not part of the configuration serialized by the extension.
const observations = new WeakMap<object, Observation>()

class AutoApplyFanoutAI {
	readonly id = `managed-auto-apply-${Date.now()}`
	constructor(observation: Observation) {
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; signal?: AbortSignal },
	): AsyncGenerator<ScriptChunk> {
		if (metadata?.attemptId === "title") {
			yield { type: "text", text: "Fixture task" }
			return
		}
		assert.ok(metadata?.taskId)
		assert.ok(metadata.signal)
		const observation = observations.get(this)!
		const taskId = metadata.taskId
		const task = observation.provider.getLiveTask(taskId)
		assert.ok(task)
		observation.rootTaskId ??= taskId
		if (taskId !== observation.rootTaskId) {
			const child = Number(/AUTO_APPLY_CHILD_(\d)/u.exec(task.metadata.task)?.[1])
			assert.ok(child >= 1 && child <= CHILD_COUNT, "Child objective must identify its fixture branch")
			const request = (observation.childRequests.get(taskId) ?? 0) + 1
			observation.childRequests.set(taskId, request)
			observation.childIds.set(child, taskId)
			if (observation.childIds.size === CHILD_COUNT) observation.allChildrenEntered.resolve()
			await observation.allChildrenEntered.promise
			if (metadata.signal.aborted) return
			if (child >= 2 && child <= 4) {
				await waitForAbort(metadata.signal)
				return
			}
			if (child === 1 && request === 1) {
				yield toolCall(`auto-apply-patch-${taskId}`, "apply_patch", {
					patch: `*** Begin Patch\n*** Update File: ${STATE_PATH}\n@@\n-export default {"owner":"baseline"}\n+export default {"owner":"worker"}\n*** End Patch`,
				})
				return
			}
			assert.equal(request, child === 1 ? 2 : 1)
			yield { type: "text", text: child === 1 ? "AUTO_APPLY_WORKER_COMPLETE" : "AUTO_APPLY_REVIEW_COMPLETE" }
			return
		}

		const request = ++observation.rootRequests
		assert.ok(request <= 16, "Parent must not enter an unbounded agent-result loop")
		if (request === 1) {
			for (let child = 1; child <= CHILD_COUNT; child++) {
				yield toolCall(`auto-apply-spawn-${child}`, "spawn_agent", {
					task_name: `auto_apply_child_${child}`,
					fork_turns: "none",
					agent_type: child === 1 ? "worker" : child === 2 ? "explorer" : "review",
					message: `AUTO_APPLY_CHILD_${child}: ${child === 1 ? `Change ${STATE_PATH} owner from baseline to worker.` : "Review the fixture read-only and return your findings."}`,
				})
			}
			return
		}
		if (terminalReports(messages).size !== CHILD_COUNT) {
			yield toolCall(`auto-apply-wait-${request}`, "wait_agent", {
				timeout_ms: 20_000,
				until_terminal: true,
			})
			return
		}
		if (!JSON.stringify(messages).includes(STEERING)) {
			observation.waitingForSteering = true
			await waitForAbort(metadata.signal)
			return
		}
		observation.steeringObserved = true
		if (!observation.verificationIssued) {
			const writer = groupsFor(task)
				.flatMap((group) => group.agents)
				.find((agent) => agent.role === "worker")
			assert.equal(writer?.changeSet?.status, "applied")
			assert.ok(writer.changeSet)
			observation.verificationIssued = true
			yield toolCall(`auto-apply-verification-${request}`, "exec_command", {
				cmd: `node --test ${FIXTURE_DIRECTORY}/state.test.mjs`,
				yield_time_ms: 30_000,
				verification: { change_set_ids: [writer.changeSet.id] },
			})
			return
		}
		const commandSession = JSON.stringify(messages.slice(-1)).match(/Process running with session ID\s+(\d+)/u)
		if (commandSession) {
			yield toolCall(`auto-apply-poll-${request}`, "write_stdin", {
				session_id: Number(commandSession[1]),
				chars: "",
				yield_time_ms: 30_000,
			})
			return
		}
		yield { type: "text", text: RESULT }
	}

	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens(content: unknown[]) {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt() {
		return ""
	}
}

async function initializeFixture(workspace: string): Promise<void> {
	await fs.mkdir(path.join(workspace, FIXTURE_DIRECTORY), { recursive: true })
	await fs.writeFile(path.join(workspace, STATE_PATH), 'export default {"owner":"baseline"}\n')
	await fs.writeFile(
		path.join(workspace, FIXTURE_DIRECTORY, "state.test.mjs"),
		[
			'import assert from "node:assert/strict"',
			'import test from "node:test"',
			'import state from "./state.mjs"',
			'test("Worker change reached the parent workspace", () => assert.deepEqual(state, { owner: "worker" }))',
			"",
		].join("\n"),
	)
	await execFile("git", ["init"], { cwd: workspace, windowsHide: true })
	await execFile("git", ["add", "--", FIXTURE_DIRECTORY], { cwd: workspace, windowsHide: true })
	await execFile(
		"git",
		[
			"-c",
			"user.name=Alpha E2E",
			"-c",
			"user.email=alpha-e2e@local.invalid",
			"commit",
			"-m",
			"auto-apply baseline",
		],
		{ cwd: workspace, windowsHide: true },
	)
}

suite("Managed-agent automatic Apply Extension Host acceptance", function () {
	this.timeout(120_000)

	test("retains applied review state across mixed child outcomes and accepts parent steering", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace)
		assert.ok(artifacts)
		await initializeFixture(workspace)
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider: HostProvider }).sidebarProvider
		const previousConfiguration = api.getConfiguration()
		const observation: Observation = {
			provider,
			rootRequests: 0,
			childIds: new Map(),
			childRequests: new Map(),
			allChildrenEntered: deferred(),
			waitingForSteering: false,
			steeringObserved: false,
			verificationIssued: false,
		}
		const model = new AutoApplyFanoutAI(observation)
		const completions = new Map<string, number>()
		const onCompleted = (taskId: string) => completions.set(taskId, (completions.get(taskId) ?? 0) + 1)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		let root: LiveTask | undefined
		await withBoundedFixtureCleanup(async () => {
			const configuration = {
				...previousConfiguration,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				alwaysAllowSubagents: true,
				alwaysAllowFollowupQuestions: false,
				allowedCommands: ["node"],
				deniedCommands: [],
				mcpEnabled: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
				maxConcurrentTasks: CHILD_COUNT + 1,
				maxConcurrentSubagents: CHILD_COUNT,
				subagentMaxDepth: 1,
				subagentDelegationPolicy: "proactive",
				subagentRoleTimeoutsMs: { worker: 60_000, explore: 10_000, review: 60_000 },
				subagentMaxInputTokens: 250_000,
				subagentRootTokenBudget: null,
				subagentRootCostBudget: null,
			} satisfies AlphaCodeSettings
			await api.setConfiguration(configuration)
			const rootTaskId = await api.startNewTask({
				configuration,
				text: "Launch five agents, integrate the Worker patch automatically, collect every terminal outcome and verify it.",
			})
			root = provider.getLiveTask(rootTaskId)
			assert.ok(root)
			await waitFor(() => observation.childIds.size === CHILD_COUNT, {
				description: "all five child provider barriers",
			})
			for (const child of [3, 4]) {
				await provider.cancelAgent(
					root,
					observation.childIds.get(child)!,
					"Cancel the deterministic review branch",
				)
			}
			await waitFor(
				() => {
					const groups = groupsFor(root!)
					return groups.length === CHILD_COUNT && groups.every((group) => group.completedAt !== undefined)
				},
				{ timeout: 60_000, description: "mixed child finalization and final group publication" },
			)
			const changeSetId = groupsFor(root)
				.flatMap((group) => group.agents)
				.find((agent) => agent.role === "worker")?.changeSet?.id
			assert.ok(changeSetId)
			const artifactPath = path.join(
				provider.context.globalStorageUri.fsPath,
				"subagent-change-sets",
				changeSetId,
				"metadata.json",
			)
			// A terminal child can publish while its parent is still busy. Automatic
			// apply commits at the parent's next safe review boundary.
			await waitFor(
				async () => {
					const artifact: unknown = await readBoundedJson(artifactPath)
					return (
						!!artifact &&
						typeof artifact === "object" &&
						"status" in artifact &&
						artifact.status === "applied"
					)
				},
				{ timeout: 60_000, description: "automatic Worker apply at the parent review boundary" },
			)
			await waitFor(() => observation.waitingForSteering, {
				description: "parent model receives every terminal report after automatic apply",
				onTimeout: () => ({ rootRequests: observation.rootRequests, groups: groupsFor(root!) }),
			})
			// upsertSubagentGroup clones projections; inspect the current publication.
			const writerGroup = groupsFor(root).find((group) => group.agents.some((agent) => agent.role === "worker"))
			const writer = writerGroup?.agents.find((agent) => agent.role === "worker")
			assert.ok(writer?.changeSet)
			const artifact: unknown = await readBoundedJson(artifactPath)
			assert.ok(artifact && typeof artifact === "object" && "status" in artifact)
			assert.equal(artifact.status, "applied", "The Worker artifact must already have been automatically applied")
			assert.equal(
				writer.changeSet.status,
				artifact.status,
				"Terminal group publication must not restore an applied proposal to pending review",
			)
			const { taskDirPath } = await provider.getTaskWithId(rootTaskId)
			const persistedUi = await readBoundedJson(path.join(taskDirPath, "ui_messages.json"))
			assert.ok(Array.isArray(persistedUi))
			const persistedGroups = persistedUi.flatMap((message: unknown) => {
				if (!message || typeof message !== "object" || !("subagentGroup" in message)) return []
				return [subagentGroupStateSchema.parse(message.subagentGroup)]
			})
			assert.equal(
				persistedGroups.find((group) => group.groupId === writerGroup!.groupId)?.agents[0]?.changeSet?.status,
				"applied",
				"Reloaded review state must retain the artifact's applied status",
			)
			await root.steerUserMessageDurably(STEERING, [], "auto-apply-parent-steering")
			await waitFor(() => root!.didComplete, {
				timeout: 60_000,
				description: "parent accepts steering, verifies the applied change and completes",
				onTimeout: () => ({
					rootRequests: observation.rootRequests,
					groups: groupsFor(root!),
					steering: observation.steeringObserved,
				}),
			})
			await root.waitForTermination()
			await root.flushApiConversationHistoryPersistence()
			const state = await provider.getStateToPostToWebview()
			const tree = managedAgentTreeProjectionSchema.parse(state.managedAgentTree)
			const control = agentControlStateSchema.parse(provider.agentControlStore.getSnapshot())
			const terminal = Array.from(
				{ length: CHILD_COUNT },
				(_, index) => observation.childIds.get(index + 1)!,
			).map((id) => {
				const record = control.agents.find((agent) => agent.taskId === id)
				assert.ok(record)
				assert.equal(
					control.mailbox.filter((event) => event.kind === "result" && event.senderTaskId === id).length,
					1,
				)
				return { taskId: id, status: record.status }
			})
			assert.deepEqual(
				terminal.map(({ status }) => status),
				["completed", "timed_out", "cancelled", "cancelled", "completed"],
			)
			assert.equal(tree.capacity.active, 0)
			assert.equal(tree.capacity.queued, 0)
			assert.equal(tree.capacity.terminal, CHILD_COUNT)
			assert.equal(completions.get(rootTaskId), 1)
			assert.equal(observation.steeringObserved, true)
			assert.equal(observation.verificationIssued, true)
			assert.equal(root.messageQueueService.hasUnconsumedInput(), false)
			assert.equal(state.liveTasksById?.[rootTaskId]?.isTurnActive, false)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const transactions = inspectToolTransactions(history)
			assert.deepEqual(transactions.errors, [])
			assert.equal(transactions.callCount, transactions.resultCount)
			assert.equal(JSON.stringify(history).split(STEERING).length - 1, 1, "Human steering must be persisted once")
			assert.equal(root.clineMessages.filter((message) => !message.partial && message.text === RESULT).length, 1)
			await fs.writeFile(
				path.join(artifacts, "managed-agents-auto-apply.json"),
				JSON.stringify(
					{
						hostVersion: vscode.version,
						provider: "scripted",
						terminal,
						tree,
						rootRequests: observation.rootRequests,
						artifactStatus: artifact.status,
						transcriptStatus: writer.changeSet.status,
						steeringObserved: observation.steeringObserved,
						transactions,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		}, [
			() => observation.allChildrenEntered.resolve(),
			async () => {
				if (root && !root.didComplete) await api.cancelCurrentTask()
			},
			() => api.clearCurrentTask(),
			() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => model.removeFromCache?.(),
			() => api.setConfiguration(previousConfiguration),
		])
	})
})
