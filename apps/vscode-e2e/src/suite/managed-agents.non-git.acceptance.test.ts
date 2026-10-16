import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	TaskLifecycleState,
	managedAgentTreeProjectionSchema,
	type AlphaCodeSettings,
	type AlphaMessage,
	type ExtensionState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

const execFile = promisify(execFileCallback)
const CHILD_COUNT = 2
const RESULT = "Both non-Git agents have returned their replies."

interface LiveTask {
	taskId: string
	taskKind: "primary" | "subagent"
	subagentRole?: string
	cwd: string
	abort: boolean
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
	workspace: string
	root?: LiveTask
	rootRequests: number
	children: Map<string, { index: number; role: string; isolated: boolean }>
	privateWorkspaces: Set<string>
	completed: Map<string, number>
	childrenEntered: ReturnType<typeof deferred>
	childrenCompleted: ReturnType<typeof deferred>
	removeFromCache?: () => void
}

// Keep runtime barriers out of the configuration serialized by the extension.
const observations = new WeakMap<object, Observation>()
class NonGitAgentsAI {
	readonly id = "non-git-default-agents-" + Date.now()
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
		const task = observation.provider.getLiveTask(metadata.taskId)
		assert.ok(task)
		if (task.taskKind === "subagent") {
			assert.equal(task.subagentRole, "worker", "Default agents must retain Worker authority")
			const index = Number(/NON_GIT_AGENT_(\d+)/u.exec(task.metadata.task)?.[1])
			assert.ok(index >= 1 && index <= CHILD_COUNT)
			assert.equal(observation.children.has(task.taskId), false, "Each child needs one request")
			const relative = path.relative(observation.workspace, task.cwd)
			const isolated = path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)
			assert.equal(isolated, true, "Workers must keep their private workspace isolation")
			const privateWorkspace = process.platform === "win32" ? task.cwd.toLowerCase() : task.cwd
			assert.equal(observation.privateWorkspaces.has(privateWorkspace), false, "Workers need separate workspaces")
			observation.privateWorkspaces.add(privateWorkspace)
			observation.children.set(task.taskId, { index, role: task.subagentRole, isolated })
			if (observation.children.size === CHILD_COUNT) observation.childrenEntered.resolve()
			await observation.childrenEntered.promise
			assert.ok(observation.root)
			assert.equal(observation.provider.getLiveTask(observation.root.taskId), observation.root)
			assert.equal(observation.root.abort, false, "Starting children must not abort the parent")
			await assertNonGitWorkspace(observation.workspace)
			yield { type: "text" as const, text: "NON_GIT_REPLY_" + index }
			return
		}

		observation.root ??= task
		assert.equal(task, observation.root, "The parent must retain the same live task")
		assert.equal(path.relative(observation.workspace, task.cwd), "", "The parent must keep its source workspace")
		const request = ++observation.rootRequests
		if (request === 1) {
			for (let index = 1; index <= CHILD_COUNT; index++) {
				yield {
					type: "tool_call" as const,
					id: "non-git-spawn-" + index,
					name: "spawn_agent",
					arguments: JSON.stringify({
						task_name: "reply_" + index,
						message: "Return a short reply for NON_GIT_AGENT_" + index + ". Do not change any files.",
						fork_turns: "none",
					}),
				}
			}
			return
		}
		if (request === 2) {
			await observation.childrenCompleted.promise
			yield {
				type: "tool_call" as const,
				id: "non-git-wait",
				name: "wait_agent",
				arguments: JSON.stringify({ timeout_ms: 10_000 }),
			}
			return
		}
		assert.equal(request, 3, "Result collection must not enter an unbounded retry loop")
		const serialized = JSON.stringify(messages)
		for (let index = 1; index <= CHILD_COUNT; index++) {
			assert.ok(serialized.includes("NON_GIT_REPLY_" + index), "Every reply must reach the parent")
		}
		yield { type: "text" as const, text: RESULT }
	}
	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens(content: unknown[]) {
		return Math.ceil(JSON.stringify(content).length / 4)
	}
	async completePrompt() {
		return ""
	}
}

async function assertNonGitWorkspace(workspace: string): Promise<void> {
	await assert.rejects(fs.lstat(path.join(workspace, ".git")), { code: "ENOENT" })
	await assert.rejects(
		execFile("git", ["rev-parse", "--show-toplevel"], {
			cwd: workspace,
			windowsHide: true,
			timeout: 5_000,
			maxBuffer: 1024,
		}),
		{ code: 128 },
	)
}

suite("Managed agents in a plain folder", function () {
	this.timeout(120_000)
	test("runs two native default agents without creating source Git metadata or replacing the parent", async () => {
		assert.equal(vscode.version, "1.125.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace && artifacts)
		assert.deepEqual(await fs.readdir(workspace), [], "This regression requires the runner's fresh empty folder")
		await assertNonGitWorkspace(workspace)
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider: HostProvider }).sidebarProvider
		const previousConfiguration = api.getConfiguration()
		const observation: Observation = {
			provider,
			workspace,
			rootRequests: 0,
			children: new Map(),
			privateWorkspaces: new Set(),
			completed: new Map(),
			childrenEntered: deferred(),
			childrenCompleted: deferred(),
		}
		const model = new NonGitAgentsAI(observation)
		const failures: string[] = []
		const onFailed = (_taskId: string, tool: string, error: string) => failures.push(tool + ": " + error)
		const onCompleted = (taskId: string) => {
			observation.completed.set(taskId, (observation.completed.get(taskId) ?? 0) + 1)
			if ([...observation.children.keys()].every((id) => observation.completed.has(id))) {
				if (observation.children.size === CHILD_COUNT) observation.childrenCompleted.resolve()
			}
		}
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.on(AlphaCodeEventName.TaskToolFailed, onFailed)
		await withBoundedFixtureCleanup(async () => {
			const configuration = {
				...previousConfiguration,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowSubagents: true,
				alwaysAllowReadOnly: true,
				alwaysAllowWrite: true,
				mcpEnabled: false,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				maxConcurrentTasks: CHILD_COUNT + 1,
				maxConcurrentSubagents: CHILD_COUNT,
				subagentMaxDepth: 1,
				subagentDelegationPolicy: "proactive",
				subagentRootTokenBudget: null,
				subagentRootCostBudget: null,
			} satisfies AlphaCodeSettings
			await api.setConfiguration(configuration)
			const rootId = await api.startNewTask({
				text: "Use two default sub-agents to return separate short replies, collect both, and complete.",
				configuration,
			})
			await waitFor(
				() => {
					assert.deepEqual(failures, [], "Native non-Git agent launch must not fail")
					return observation.completed.has(rootId)
				},
				{
					timeout: 60_000,
					description: "two default agents in a non-Git folder and parent completion",
					onTimeout: async () => ({
						rootRequests: observation.rootRequests,
						children: [...observation.children],
						completed: [...observation.completed],
						failures,
						state: await provider.getStateToPostToWebview(),
					}),
				},
			)
			const root = provider.getLiveTask(rootId)
			assert.ok(root)
			assert.equal(root, observation.root)
			await root.waitForTermination()
			await root.flushApiConversationHistoryPersistence()
			await assertNonGitWorkspace(workspace)
			const state = await provider.getStateToPostToWebview()
			const tree = managedAgentTreeProjectionSchema.parse(state.managedAgentTree)
			const { taskDirPath } = await provider.getTaskWithId(rootId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const transactions = inspectToolTransactions(history)
			await fs.writeFile(
				path.join(artifacts, "managed-agents-non-git.json"),
				JSON.stringify(
					{
						hostVersion: vscode.version,
						rootId,
						rootRequests: observation.rootRequests,
						children: [...observation.children],
						privateWorkspaceCount: observation.privateWorkspaces.size,
						completionCounts: [...observation.completed],
						sourceGitMetadataCreated: false,
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
			assert.equal(observation.rootRequests, 3)
			assert.equal(observation.children.size, CHILD_COUNT)
			assert.equal(observation.privateWorkspaces.size, CHILD_COUNT)
			assert.equal(observation.completed.size, CHILD_COUNT + 1)
			assert.ok([...observation.completed.values()].every((count) => count === 1))
			assert.equal(tree.rootTaskId, rootId)
			assert.equal(tree.capacity.active, 0)
			assert.equal(tree.capacity.queued, 0)
			assert.equal(tree.capacity.terminal, CHILD_COUNT)
			assert.ok(tree.nodes.filter((node) => node.taskId !== rootId).every((node) => node.role === "worker"))
			assert.equal(state.currentTaskId, rootId)
			assert.equal(state.liveTasksById?.[rootId]?.lifecycle, TaskLifecycleState.Completed)
			assert.equal(state.liveTasksById?.[rootId]?.isTurnActive, false)
			assert.equal(root.didComplete, true)
			assert.ok(root.clineMessages.some((message) => !message.partial && message.text === RESULT))
			assert.deepEqual(transactions.errors, [])
			assert.equal(transactions.callCount, CHILD_COUNT + 1)
			assert.equal(transactions.resultCount, CHILD_COUNT + 1)
		}, [
			() => {
				observation.childrenEntered.resolve()
				observation.childrenCompleted.resolve()
			},
			() => api.clearCurrentTask(),
			() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => api.off(AlphaCodeEventName.TaskToolFailed, onFailed),
			() => model.removeFromCache?.(),
			() => api.setConfiguration(previousConfiguration),
		])
	})
})
