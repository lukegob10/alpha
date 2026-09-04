import * as assert from "assert"
import { execFile as execFileCallback } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

import {
	managedAgentTreeProjectionSchema,
	RooCodeEventName,
	type ClineMessage,
	type LiveTaskMetadata,
	type ManagedAgentTreeProjection,
	type RooCodeAPI,
	type RooCodeSettings,
	type SubagentChangeSetActionCapability,
	type SubagentChangeSetActionResult,
	type SubagentGroupState,
} from "@alpha-code/types"

import { waitFor } from "./utils"

const execFile = promisify(execFileCallback)

const FIXTURE_ROOT = "managed-agent-e2e"
const WORKER_DIR = `${FIXTURE_ROOT}/worker`
const OUTER_PATH = `${WORKER_DIR}/outer/state.mjs`
const NESTED_PATH = `${WORKER_DIR}/nested/state.mjs`
const OUTER_TEST_PATH = `${WORKER_DIR}/outer/state.test.mjs`
const NESTED_TEST_PATH = `${WORKER_DIR}/nested/state.test.mjs`
const DISCARD_PATH = `${WORKER_DIR}/discard.json`
const ROOT_VERIFY_CWD = WORKER_DIR
const OUTER_VERIFY_CWD = `${WORKER_DIR}/nested`
const REPOSITORY_NODE_BIN = path.resolve(__dirname, "../../../../src/node_modules/.bin")
const REPOSITORY_VITEST_BINARY = path.join(REPOSITORY_NODE_BIN, process.platform === "win32" ? "vitest.cmd" : "vitest")
const VITEST_CONFIG = 'export default {"test":{"globals":true}}\n'

const stateModuleText = (owner: string, verified: boolean): string =>
	`export default ${JSON.stringify({ owner, verified })}\n`

const stateTestText = (owner: string): string =>
	[
		'import state from "./state.mjs"',
		'import assert from "node:assert/strict"',
		"",
		`test("validates ${owner} state", () => {`,
		`\tassert.deepEqual(state, ${JSON.stringify({ owner, verified: true })})`,
		"})",
		"",
	].join("\n")

const OUTER_OBJECTIVE = "Produce the outer Worker change after reviewing the nested Worker proposal."
const NESTED_OBJECTIVE = "Produce the nested Worker change for immediate-parent review."
const DISCARD_OBJECTIVE = "Produce a throwaway Worker proposal that the root will discard."

type ScriptRole = "root" | "outer" | "nested" | "discard"

type ScriptChunk =
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

type ScriptedToolCall = {
	name: string
	arguments: Record<string, unknown>
}

class ManagedAgentScriptedAI {
	readonly id = `managed-agent-e2e-${Date.now()}`
	removeFromCache?: () => void
	private readonly turnsByTask = new Map<string, number>()
	private readonly rolesByTask = new Map<string, ScriptRole>()
	private readonly verificationChangeSetsByRole = new Map<ScriptRole, string[]>()

	registerTaskRole(taskId: string, nickname: string): void {
		const rolesByNickname: Record<string, ScriptRole> = {
			outer_worker: "outer",
			nested_writer: "nested",
			discard_worker: "discard",
		}
		const role = rolesByNickname[nickname]
		if (!role) throw new Error(`Unexpected managed-agent nickname ${nickname}`)
		this.rolesByTask.set(taskId, role)
	}

	setVerificationChangeSets(role: Extract<ScriptRole, "root" | "outer">, changeSetIds: string[]): void {
		assert.ok(changeSetIds.length > 0, `Verification scope for ${role} must not be empty`)
		this.verificationChangeSetsByRole.set(role, [...new Set(changeSetIds)])
	}

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string },
	): AsyncGenerator<ScriptChunk> {
		const taskId = metadata?.taskId
		if (!taskId) throw new Error("Scripted managed-agent E2E request is missing metadata.taskId")

		const role = this.rolesByTask.get(taskId) ?? "root"
		const turn = this.turnsByTask.get(taskId) ?? 0
		console.log(`[managed-agent-e2e] model task=${taskId} role=${role} turn=${turn}`)
		this.assertPriorToolSucceeded(role, turn, messages)
		this.turnsByTask.set(taskId, turn + 1)
		const call = await this.getToolCall(role, turn)

		yield {
			type: "tool_call",
			id: `managed-agent-e2e-${taskId}-${turn}`,
			name: call.name,
			arguments: JSON.stringify(call.arguments),
		}
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: "managed-agent-scripted-e2e",
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}

	private assertPriorToolSucceeded(role: ScriptRole, turn: number, messages: unknown[]): void {
		if (turn === 0) return
		let result: { type?: string; content?: unknown; is_error?: boolean } | undefined
		for (let index = messages.length - 1; index >= 0 && !result; index--) {
			const content = (messages[index] as { content?: unknown } | undefined)?.content
			if (!Array.isArray(content)) continue
			for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex--) {
				const candidate = content[contentIndex] as { type?: string; content?: unknown; is_error?: boolean }
				if (candidate.type === "tool_result") {
					result = candidate
					break
				}
			}
		}
		if (!result) {
			console.error(
				`[managed-agent-e2e] missing prior tool result role=${role} turn=${turn} history=${JSON.stringify(messages.slice(-4)).slice(0, 4_000)}`,
			)
			throw new Error(`The ${role} scripted turn ${turn} is missing its prior tool result`)
		}
		const serialized = typeof result.content === "string" ? result.content : JSON.stringify(result.content)
		if (
			result.is_error === true ||
			serialized.includes('"status":"error"') ||
			serialized.includes("Command execution was not successful")
		) {
			console.error(
				`[managed-agent-e2e] prior tool failure role=${role} turn=${turn} result=${serialized.slice(0, 4_000)}`,
			)
			throw new Error(`The ${role} scripted turn ${turn} failed: ${serialized.slice(0, 500)}`)
		}
	}

	private async getToolCall(role: ScriptRole, turn: number): Promise<ScriptedToolCall> {
		const scripts: Record<ScriptRole, ScriptedToolCall[]> = {
			root: [
				{
					name: "spawn_agent",
					arguments: {
						task_name: "outer_worker",
						fork_turns: "none",
						objective: OUTER_OBJECTIVE,
						agent_kind: "worker",
						write_scope: [`${FIXTURE_ROOT}/worker`],
						expected_output: ["A quarantined change set containing the nested and outer fixture updates."],
					},
				},
				{
					name: "spawn_agent",
					arguments: {
						task_name: "discard_worker",
						fork_turns: "none",
						objective: DISCARD_OBJECTIVE,
						agent_kind: "worker",
						write_scope: [DISCARD_PATH],
						expected_output: ["A quarantined throwaway change set."],
					},
				},
				{
					name: "wait_agent",
					arguments: {
						timeout_ms: 20_000,
						target: "/root/outer-worker",
						until_terminal: true,
					},
				},
				{
					name: "wait_agent",
					arguments: {
						timeout_ms: 20_000,
						target: "/root/discard-worker",
						until_terminal: true,
					},
				},
				{
					name: "ask_followup_question",
					arguments: {
						question:
							"Pause while the automated acceptance harness reviews both root-owned Worker proposals.",
						follow_up: [{ text: "Both proposals were reviewed; continue.", mode: null }],
					},
				},
				{
					name: "execute_command",
					arguments: {
						command: "vitest run --maxWorkers=2",
						cwd: ROOT_VERIFY_CWD,
						timeout: 30,
					},
				},
				{
					name: "attempt_completion",
					arguments: {
						result: "Nested Worker Apply, root Worker Apply, discard, and verification completed.",
					},
				},
			],
			outer: [
				{
					name: "spawn_agent",
					arguments: {
						task_name: "nested_writer",
						fork_turns: "none",
						objective: NESTED_OBJECTIVE,
						agent_kind: "worker",
						write_scope: [NESTED_PATH],
						expected_output: ["A quarantined nested fixture change."],
					},
				},
				{
					name: "wait_agent",
					arguments: {
						timeout_ms: 20_000,
						target: "/root/outer-worker/nested-writer",
						until_terminal: true,
					},
				},
				{
					name: "execute_command",
					arguments: {
						command: "vitest run --maxWorkers=2",
						cwd: OUTER_VERIFY_CWD,
						timeout: 30,
					},
				},
				{
					name: "write_to_file",
					arguments: {
						path: OUTER_PATH,
						content: stateModuleText("outer_worker", true),
					},
				},
				{
					name: "attempt_completion",
					arguments: {
						result: "Applied and verified the nested proposal, then produced the outer proposal.",
					},
				},
			],
			nested: [
				{
					name: "write_to_file",
					arguments: {
						path: NESTED_PATH,
						content: stateModuleText("nested_writer", true),
					},
				},
				{
					name: "attempt_completion",
					arguments: { result: "Produced the nested fixture proposal.", outcome: "completed" },
				},
			],
			discard: [
				{
					name: "write_to_file",
					arguments: {
						path: DISCARD_PATH,
						content: '{"owner":"discard_worker","verified":true}\n',
					},
				},
				{
					name: "attempt_completion",
					arguments: { result: "Produced the throwaway fixture proposal.", outcome: "completed" },
				},
			],
		}

		const call = scripts[role][turn]
		if (!call) throw new Error(`Unexpected ${role} model turn ${turn + 1}`)
		if (call.name === "execute_command") {
			await waitFor(() => (this.verificationChangeSetsByRole.get(role)?.length ?? 0) > 0, {
				timeout: 60_000,
				interval: 25,
			})
			const changeSetIds = this.verificationChangeSetsByRole.get(role)!
			return {
				...call,
				arguments: {
					...call.arguments,
					verification: { change_set_ids: [...changeSetIds] },
				},
			}
		}
		return call
	}
}

interface ManagedAgentHostProvider {
	getStateToPostToWebview(): Promise<{
		currentTaskId?: string
		liveTasksById?: Record<string, LiveTaskMetadata>
		managedAgentTree?: ManagedAgentTreeProjection
	}>
	getSubagentChangeSetActionCapability(
		parentTaskId: string,
		groupId: string,
		changeSetId: string,
	): Promise<SubagentChangeSetActionCapability>
	applySubagentChangeSet(
		parentTaskId: string,
		groupId: string,
		changeSetId: string,
	): Promise<SubagentChangeSetActionResult>
	discardSubagentChangeSet(
		parentTaskId: string,
		groupId: string,
		changeSetId: string,
	): Promise<SubagentChangeSetActionResult>
	showTaskWithId(taskId: string): Promise<void>
	getLiveTask(taskId: string):
		| {
				taskAsk?: ClineMessage
				isInitialized?: boolean
				isTaskLoopActive?: boolean
				isWaitingForFirstChunk?: boolean
				isStreaming?: boolean
				currentAgentStep?: { stepId: string }
				activeAsk?: { type: string; ts: number }
				askResponse?: string
				messageQueueService?: { isEmpty(): boolean }
				clineMessages?: ClineMessage[]
				approveAsk(): void
		  }
		| undefined
}

type AgentTarget = {
	group: SubagentGroupState
	agent: SubagentGroupState["agents"][number]
}

const getHostProvider = (api: RooCodeAPI): ManagedAgentHostProvider => {
	const provider = (api as unknown as { sidebarProvider?: ManagedAgentHostProvider }).sidebarProvider
	assert.ok(provider, "The extension API did not expose its host provider to the extension-host test")
	return provider
}

const findAgent = (
	groups: ReadonlyMap<string, SubagentGroupState>,
	parentTaskId: string,
	objective: string,
): AgentTarget | undefined => {
	for (const group of groups.values()) {
		if (group.parentTaskId !== parentTaskId) continue
		const agent = group.agents.find((candidate) => candidate.objective === objective)
		if (agent) return { group, agent }
	}
	return undefined
}

const getTaskDiagnostics = (provider: ManagedAgentHostProvider, taskId: string) => {
	const task = provider.getLiveTask(taskId)
	return {
		isInitialized: task?.isInitialized,
		isTaskLoopActive: task?.isTaskLoopActive,
		isWaitingForFirstChunk: task?.isWaitingForFirstChunk,
		isStreaming: task?.isStreaming,
		stepId: task?.currentAgentStep?.stepId,
		taskAsk: task?.taskAsk?.ask,
		activeAsk: task?.activeAsk,
		askResponse: task?.askResponse,
		queueEmpty: task?.messageQueueService?.isEmpty(),
		transcriptTail: task?.clineMessages?.slice(-6).map(({ ask, say, text, partial }) => ({
			message: ask ?? say,
			partial,
			text: text?.slice(0, 500),
		})),
	}
}

const waitForAgent = async (
	provider: ManagedAgentHostProvider,
	groups: ReadonlyMap<string, SubagentGroupState>,
	parentTaskId: string,
	objective: string,
): Promise<AgentTarget> => {
	await waitFor(() => findAgent(groups, parentTaskId, objective) !== undefined, {
		timeout: 60_000,
		interval: 50,
		description: `managed child of ${parentTaskId}: ${objective}`,
		onTimeout: () => getTaskDiagnostics(provider, parentTaskId),
	})
	return findAgent(groups, parentTaskId, objective)!
}

const waitForPendingChangeSet = async (
	groups: ReadonlyMap<string, SubagentGroupState>,
	parentTaskId: string,
	objective: string,
): Promise<Required<Pick<SubagentChangeSetActionResult, "taskId" | "groupId" | "changeSetId">>> => {
	await waitFor(() => findAgent(groups, parentTaskId, objective)?.agent.changeSet?.status === "pending_review", {
		timeout: 90_000,
		interval: 50,
	})
	const target = findAgent(groups, parentTaskId, objective)!
	return {
		taskId: parentTaskId,
		groupId: target.group.groupId,
		changeSetId: target.agent.changeSet!.id,
	}
}

const waitForAvailableCapability = async (
	provider: ManagedAgentHostProvider,
	target: Required<Pick<SubagentChangeSetActionResult, "taskId" | "groupId" | "changeSetId">>,
	action: "apply" | "discard",
): Promise<SubagentChangeSetActionCapability> => {
	let capability: SubagentChangeSetActionCapability | undefined
	await waitFor(
		async () => {
			capability = await provider.getSubagentChangeSetActionCapability(
				target.taskId,
				target.groupId,
				target.changeSetId,
			)
			return capability.actions[action].allowed
		},
		{ timeout: 60_000, interval: 50 },
	)
	return capability!
}

const initializeFixtureRepository = async (workspace: string): Promise<void> => {
	const workerDir = path.join(workspace, FIXTURE_ROOT, "worker")
	await fs.mkdir(workerDir, { recursive: true })
	await Promise.all([
		fs.mkdir(path.dirname(path.join(workspace, OUTER_PATH)), { recursive: true }),
		fs.mkdir(path.dirname(path.join(workspace, NESTED_PATH)), { recursive: true }),
	])
	const baselineState = stateModuleText("baseline", false)
	const baselineDiscard = '{"owner":"baseline","verified":false}\n'
	await Promise.all([
		fs.writeFile(path.join(workspace, OUTER_PATH), baselineState, "utf8"),
		fs.writeFile(path.join(workspace, NESTED_PATH), baselineState, "utf8"),
		fs.writeFile(path.join(workspace, DISCARD_PATH), baselineDiscard, "utf8"),
		fs.writeFile(path.join(workerDir, "vitest.config.mjs"), VITEST_CONFIG, "utf8"),
		fs.writeFile(path.join(workerDir, ".gitignore"), "node_modules/\n", "utf8"),
		fs.writeFile(path.join(workspace, OUTER_TEST_PATH), stateTestText("outer_worker"), "utf8"),
		fs.writeFile(path.join(workspace, NESTED_TEST_PATH), stateTestText("nested_writer"), "utf8"),
		fs.writeFile(path.join(workspace, OUTER_VERIFY_CWD, "vitest.config.mjs"), VITEST_CONFIG, "utf8"),
	])

	await execFile("git", ["init"], { cwd: workspace, windowsHide: true })
	await execFile("git", ["add", "-A"], { cwd: workspace, windowsHide: true })
	await execFile(
		"git",
		[
			"-c",
			"user.name=Alpha E2E",
			"-c",
			"user.email=alpha-e2e@local.invalid",
			"commit",
			"-m",
			"managed-agent acceptance baseline",
		],
		{ cwd: workspace, windowsHide: true },
	)
}

suite("Managed-agent deterministic Extension Host acceptance", function () {
	this.timeout(3 * 60_000)

	test("runs nested Apply, discard, verification, projection, and navigation without manual input", async () => {
		const api = globalThis.api
		const provider = getHostProvider(api)
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace, "ALPHA_E2E_WORKSPACE was not provided by the isolated test runner")
		await initializeFixtureRepository(workspace)
		try {
			await fs.access(REPOSITORY_VITEST_BINARY)
		} catch {
			throw new Error(
				`Managed-agent acceptance requires the existing Vitest binary at ${REPOSITORY_VITEST_BINARY}`,
			)
		}

		const scriptedAI = new ManagedAgentScriptedAI()
		const configuration: RooCodeSettings = {
			apiProvider: "fake-ai",
			fakeAi: scriptedAI,
			currentApiConfigName: "managed-agent-scripted-e2e",
			mode: "code",
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			alwaysAllowFollowupQuestions: false,
			allowedCommands: ["vitest"],
			deniedCommands: [],
			requestDelaySeconds: 0,
			writeDelayMs: 0,
			experiments: { preventFocusDisruption: true },
			commandExecutionTimeout: 30,
			enableCheckpoints: false,
			maxConcurrentTasks: 6,
			maxConcurrentSubagents: 3,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
			subagentRoleTimeoutsMs: { worker: 120_000 },
			subagentMaxInputTokens: 250_000,
			subagentMaxOutputTokens: 16_000,
			subagentRootTokenBudget: null,
			subagentRootCostBudget: null,
		}

		const groups = new Map<string, SubagentGroupState>()
		const spawned = new Set<string>()
		const completed = new Set<string>()
		const followupTasks = new Set<string>()
		const completionPromptTasks = new Set<string>()
		const toolFailures: string[] = []
		const lastGroupStates = new Map<string, string>()
		const onMessage = (event: { taskId: string; action: "created" | "updated"; message: ClineMessage }) => {
			if (event.message.type === "ask") {
				console.log(
					`[managed-agent-e2e] ask task=${event.taskId} kind=${event.message.ask ?? "unknown"} text=${JSON.stringify(event.message.text ?? "")}`,
				)
			}
			if (event.message.say === "subagent_group" && event.message.subagentGroup) {
				const agentState = event.message.subagentGroup.agents
					.map(
						(agent) =>
							`${agent.nickname}:${agent.status}:${agent.changeSet?.status ?? "no-change-set"}:${agent.error ?? "no-error"}`,
					)
					.join(",")
				const groupState = `${event.message.subagentGroup.status}:${agentState}`
				if (lastGroupStates.get(event.message.subagentGroup.groupId) !== groupState) {
					lastGroupStates.set(event.message.subagentGroup.groupId, groupState)
					console.log(
						`[managed-agent-e2e] group task=${event.taskId} id=${event.message.subagentGroup.groupId} status=${event.message.subagentGroup.status} agents=${agentState}`,
					)
				}
				for (const agent of event.message.subagentGroup.agents) {
					scriptedAI.registerTaskRole(agent.taskId, agent.nickname)
				}
				groups.set(event.message.subagentGroup.groupId, structuredClone(event.message.subagentGroup))
			}
			if (event.message.type === "ask" && event.message.ask === "followup") followupTasks.add(event.taskId)
			if (event.message.type === "ask" && event.message.ask === "completion_result") {
				completionPromptTasks.add(event.taskId)
			}
		}
		const onSpawned = (parentTaskId: string, childTaskId: string) => {
			console.log(`[managed-agent-e2e] spawned parent=${parentTaskId} child=${childTaskId}`)
			spawned.add(`${parentTaskId}:${childTaskId}`)
		}
		const onCompleted = (taskId: string) => {
			console.log(`[managed-agent-e2e] completed task=${taskId}`)
			completed.add(taskId)
		}
		const onToolFailed = (taskId: string, tool: string, error: string) => {
			const failure = `task=${taskId} tool=${tool}: ${error}`
			toolFailures.push(failure)
			console.error(`[managed-agent-e2e] tool failure ${failure}`)
		}

		api.on(RooCodeEventName.Message, onMessage)
		api.on(RooCodeEventName.TaskSpawned, onSpawned)
		api.on(RooCodeEventName.TaskCompleted, onCompleted)
		api.on(RooCodeEventName.TaskToolFailed, onToolFailed)

		let rootTaskId: string | undefined
		const previousPath = process.env.PATH
		try {
			process.env.PATH = [REPOSITORY_NODE_BIN, previousPath]
				.filter((entry): entry is string => entry !== undefined && entry.length > 0)
				.join(path.delimiter)
			await api.setConfiguration(configuration)
			rootTaskId = await api.startNewTask({
				configuration,
				text: "Run the deterministic managed-agent acceptance scenario exactly as scripted.",
			})

			const [outerTarget, discardTarget] = await Promise.all([
				waitForAgent(provider, groups, rootTaskId, OUTER_OBJECTIVE),
				waitForAgent(provider, groups, rootTaskId, DISCARD_OBJECTIVE),
			])
			const outerTaskId = outerTarget.agent.taskId
			const discardTaskId = discardTarget.agent.taskId
			const nestedTarget = await waitForAgent(provider, groups, outerTaskId, NESTED_OBJECTIVE)
			const nestedTaskId = nestedTarget.agent.taskId

			await Promise.all(
				[
					`${rootTaskId}:${outerTaskId}`,
					`${rootTaskId}:${discardTaskId}`,
					`${outerTaskId}:${nestedTaskId}`,
				].map((edge) => waitFor(() => spawned.has(edge), { timeout: 30_000, interval: 50 })),
			)

			const nestedChangeSet = await waitForPendingChangeSet(groups, outerTaskId, NESTED_OBJECTIVE)
			await waitForAvailableCapability(provider, nestedChangeSet, "apply")
			const nestedApply = await provider.applySubagentChangeSet(
				nestedChangeSet.taskId,
				nestedChangeSet.groupId,
				nestedChangeSet.changeSetId,
			)
			assert.equal(nestedApply.success, true, nestedApply.message)
			assert.equal(nestedApply.changeSetStatus, "applied")
			scriptedAI.setVerificationChangeSets("outer", [nestedChangeSet.changeSetId])

			const [outerChangeSet, discardChangeSet] = await Promise.all([
				waitForPendingChangeSet(groups, rootTaskId, OUTER_OBJECTIVE),
				waitForPendingChangeSet(groups, rootTaskId, DISCARD_OBJECTIVE),
			])
			await waitForAvailableCapability(provider, discardChangeSet, "discard")
			const discarded = await provider.discardSubagentChangeSet(
				discardChangeSet.taskId,
				discardChangeSet.groupId,
				discardChangeSet.changeSetId,
			)
			assert.equal(discarded.success, true, discarded.message)
			assert.equal(discarded.changeSetStatus, "discarded")

			await waitForAvailableCapability(provider, outerChangeSet, "apply")
			const outerApply = await provider.applySubagentChangeSet(
				outerChangeSet.taskId,
				outerChangeSet.groupId,
				outerChangeSet.changeSetId,
			)
			assert.equal(outerApply.success, true, outerApply.message)
			assert.equal(outerApply.changeSetStatus, "applied")
			scriptedAI.setVerificationChangeSets("root", [outerChangeSet.changeSetId])
			await waitFor(() => followupTasks.has(rootTaskId!), { timeout: 60_000, interval: 50 })

			const stateBeforeResume = await provider.getStateToPostToWebview()
			const projection = managedAgentTreeProjectionSchema.parse(stateBeforeResume.managedAgentTree)
			assert.equal(projection.rootTaskId, rootTaskId)
			assert.equal(projection.nodes.length, 4)
			assert.deepEqual(
				projection.nodes
					.map(({ taskId, parentTaskId, depth }) => ({ taskId, parentTaskId, depth }))
					.sort((left, right) => left.taskId.localeCompare(right.taskId)),
				[
					{ taskId: rootTaskId, parentTaskId: undefined, depth: 0 },
					{ taskId: outerTaskId, parentTaskId: rootTaskId, depth: 1 },
					{ taskId: discardTaskId, parentTaskId: rootTaskId, depth: 1 },
					{ taskId: nestedTaskId, parentTaskId: outerTaskId, depth: 2 },
				].sort((left, right) => left.taskId.localeCompare(right.taskId)),
			)
			assert.equal(projection.capacity.active, 0)
			assert.equal(projection.capacity.queued, 0)
			assert.equal(projection.capacity.terminal, 3)

			const persisted = api.getConfiguration()
			assert.equal(persisted.maxConcurrentSubagents, 3)
			assert.equal(persisted.subagentMaxDepth, 2)
			assert.equal(persisted.subagentDelegationPolicy, "proactive")

			await api.sendMessage(
				"Both root-owned Worker proposals were reviewed; verify the applied files and finish.",
			)
			await waitFor(() => completionPromptTasks.has(rootTaskId!), {
				timeout: 60_000,
				interval: 50,
				description: "root completion prompt after answering its follow-up",
				onTimeout: async () => {
					const state = await provider.getStateToPostToWebview()
					return {
						currentTaskId: state.currentTaskId,
						liveTask: state.liveTasksById?.[rootTaskId!],
						webviewReady: api.isReady(),
						...getTaskDiagnostics(provider, rootTaskId!),
					}
				},
			})
			await waitFor(
				() =>
					completed.has(rootTaskId!) ||
					provider.getLiveTask(rootTaskId!)?.taskAsk?.ask === "completion_result",
				{ timeout: 10_000, interval: 50 },
			)
			if (!completed.has(rootTaskId)) {
				const rootTask = provider.getLiveTask(rootTaskId)
				assert.ok(rootTask, "The root task disappeared before its completion prompt could be accepted")
				rootTask.approveAsk()
			}
			await waitFor(() => completed.has(rootTaskId!), { timeout: 90_000, interval: 50 })
			assert.deepStrictEqual(toolFailures, [], "The scripted scenario emitted tool failures")
			assert.ok(completed.has(outerTaskId), "Outer Worker never reached a terminal completion")
			assert.ok(completed.has(nestedTaskId), "Nested Worker never reached a terminal completion")
			assert.ok(completed.has(discardTaskId), "Discard Worker never reached a terminal completion")

			// Workspace file writes may use host-native CRLF; normalize only EOL before the exact module comparison.
			assert.equal(
				(await fs.readFile(path.join(workspace, OUTER_PATH), "utf8")).replace(/\r\n/g, "\n"),
				stateModuleText("outer_worker", true),
			)
			assert.equal(
				(await fs.readFile(path.join(workspace, NESTED_PATH), "utf8")).replace(/\r\n/g, "\n"),
				stateModuleText("nested_writer", true),
			)
			assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, DISCARD_PATH), "utf8")), {
				owner: "baseline",
				verified: false,
			})

			await provider.showTaskWithId(nestedTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === nestedTaskId, {
				timeout: 30_000,
				interval: 50,
			})
			await provider.showTaskWithId(outerTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === outerTaskId, {
				timeout: 30_000,
				interval: 50,
			})
			await provider.showTaskWithId(rootTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === rootTaskId, {
				timeout: 30_000,
				interval: 50,
			})
		} finally {
			api.off(RooCodeEventName.Message, onMessage)
			api.off(RooCodeEventName.TaskSpawned, onSpawned)
			api.off(RooCodeEventName.TaskCompleted, onCompleted)
			api.off(RooCodeEventName.TaskToolFailed, onToolFailed)
			if (rootTaskId && !completed.has(rootTaskId)) {
				await provider.showTaskWithId(rootTaskId).catch(() => undefined)
				await api.cancelCurrentTask().catch(() => undefined)
			}
			await api.clearCurrentTask().catch(() => undefined)
			scriptedAI.removeFromCache?.()
			if (previousPath === undefined) delete process.env.PATH
			else process.env.PATH = previousPath
		}
	})
})
