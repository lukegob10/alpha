import * as vscode from "vscode"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import * as assert from "assert"
import { execFile as execFileCallback } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

import {
	managedAgentTreeProjectionSchema,
	AlphaCodeEventName,
	type AlphaMessage,
	type LiveTaskMetadata,
	type ManagedAgentTreeProjection,
	type AlphaCodeAPI,
	type AlphaCodeSettings,
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
const INTERRUPT_OBJECTIVE = "Hold one wait_agent call so the root can interrupt this Worker."
const STEERING_MESSAGE = "Before applying your proposal, include the exact owner name outer_worker."
const INTERRUPT_PATH = "/root/interrupt-worker"

type ScriptRole = "root" | "outer" | "nested" | "discard" | "interrupt"

type ScriptChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; arguments: string }
	| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }

type ScriptedToolCall = {
	name: string
	arguments: Record<string, unknown>
}

class ManagedAgentScriptedAI {
	readonly id = `managed-agent-e2e-${Date.now()}`
	observedMailboxClaims = 0
	observedSteeringMessage = false
	observedInterruptResult = false
	observedCompletionGateRecovery = false
	heldReviewTaskId?: string
	heldInterruptCall = false
	removeFromCache?: () => void
	private readonly turnsByTask = new Map<string, number>()
	private readonly requestCountsByTask = new Map<string, number>()
	private readonly previousCallsByTask = new Map<string, ScriptedToolCall>()
	private readonly waitRetriesByTask = new Map<string, number>()
	private readonly rolesByTask = new Map<string, ScriptRole>()
	private readonly verificationChangeSetsByRole = new Map<ScriptRole, string[]>()
	private rootVerificationIssued = false
	private releaseDiscardGate?: () => void
	private releaseReviewGate?: () => void
	private releaseInterruptGate?: () => void
	private readonly discardGate = process.env.ALPHA_UI_ACCEPTANCE_NONCE
		? new Promise<void>((resolve) => {
				this.releaseDiscardGate = resolve
			})
		: undefined
	private readonly reviewGate = new Promise<void>((resolve) => {
		this.releaseReviewGate = resolve
	})
	private readonly interruptGate = new Promise<void>((resolve) => {
		this.releaseInterruptGate = resolve
	})
	heldDiscardTaskId?: string

	releaseDiscard(): void {
		this.releaseDiscardGate?.()
	}

	releaseReview(): void {
		this.releaseReviewGate?.()
	}

	releaseInterrupt(): void {
		this.releaseInterruptGate?.()
	}

	registerTaskRole(taskId: string, nickname: string): void {
		const rolesByNickname: Record<string, ScriptRole> = {
			outer_worker: "outer",
			nested_writer: "nested",
			discard_worker: "discard",
			interrupt_worker: "interrupt",
		}
		const role = rolesByNickname[nickname]
		if (!role) throw new Error(`Unexpected managed-agent nickname ${nickname}`)
		this.rolesByTask.set(taskId, role)
		this.taskIdsByRole.set(role, taskId)
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
		let turn = this.turnsByTask.get(taskId) ?? 0
		const priorResult = this.assertPriorToolSucceeded(role, turn, messages)
		const previousCall = this.previousCallsByTask.get(taskId)
		const completionBlocked =
			role === "outer" &&
			previousCall?.name === "assistant_text" &&
			JSON.stringify(messages.slice(-2)).includes("immediate-parent terminal result")
		if (completionBlocked) this.observedCompletionGateRecovery = true
		const commandSession =
			previousCall?.name === "exec_command" || previousCall?.name === "write_stdin"
				? priorResult?.match(/Process running with session ID\s+(\d+)/)?.[1]
				: undefined
		if (commandSession) turn -= 1
		if (role === "root" && previousCall?.name === "list_agents") {
			const listed = JSON.parse(priorResult ?? "null") as { agents?: Array<{ taskName?: string }> }
			const taskNames = new Set((listed.agents ?? []).map(({ taskName }) => taskName))
			for (const taskName of ["discard_worker", "interrupt_worker", "outer_worker"])
				assert.ok(taskNames.has(taskName), `list_agents omitted ${taskName}`)
		}
		if (role === "root" && previousCall?.name === "send_message") {
			const delivery = JSON.parse(priorResult ?? "null") as { delivery?: unknown; taskId?: unknown }
			assert.ok(["delivered", "queued"].includes(String(delivery?.delivery)))
			assert.equal(delivery.taskId, this.taskIdsByRole.get("outer"))
		}
		if (role === "root" && previousCall?.name === "interrupt_agent") {
			const interrupt = JSON.parse(priorResult ?? "null") as { previous_status?: unknown }
			assert.ok(["pending", "running"].includes(String(interrupt?.previous_status)))
			this.observedInterruptResult = true
		}
		const waitResult: unknown = previousCall?.name === "wait_agent" ? JSON.parse(priorResult ?? "null") : undefined
		if (waitResult && typeof waitResult === "object" && "claimId" in waitResult) {
			this.observedMailboxClaims++
			const summary = waitResult as { eventCount?: unknown; updatedAgents?: unknown; events?: unknown }
			assert.equal("events" in summary, false, "wait_agent must not return raw mailbox entries")
			assert.ok(typeof summary.eventCount === "number" && summary.eventCount > 0 && summary.eventCount <= 16)
			assert.ok(Array.isArray(summary.updatedAgents) && summary.updatedAgents.length <= 16)
			const latestContent = (messages.at(-1) as { content?: unknown } | undefined)?.content
			assert.ok(Array.isArray(latestContent), "wait notifications must reach the next model input")
			const notifications = latestContent.flatMap((block: { type?: string; text?: string }) => {
				if (block.type !== "text" || typeof block.text !== "string") return []
				try {
					const value = JSON.parse(block.text) as {
						source?: string
						eventId?: string
						sequence?: number
						senderPath?: string
						kind?: string
						payload?: { taskId?: string }
					}
					return value.source === "managed_agent_notification" ? [value] : []
				} catch {
					return []
				}
			})
			assert.equal(notifications.length, summary.eventCount)
			assert.ok(
				notifications.every(
					(entry: { eventId?: string; senderPath?: string }) => entry.eventId && entry.senderPath,
				),
			)
			assert.deepEqual(
				notifications.map((entry: { sequence?: number }) => entry.sequence),
				[...notifications]
					.map((entry: { sequence?: number }) => entry.sequence)
					.sort((left, right) => (left ?? 0) - (right ?? 0)),
			)
			if (role === "root") {
				for (const notification of notifications) {
					const value = notification as { kind?: string; payload?: { taskId?: unknown } }
					if (value.kind === "result" && typeof value.payload?.taskId === "string") {
						this.terminalTaskIds.add(value.payload.taskId)
					}
				}
			}
		}
		if (waitResult && typeof waitResult === "object" && "timedOut" in waitResult && waitResult.timedOut === true) {
			// Handler success means the bounded wait finished, not that the child
			// finished. Stay on this script step until its terminal result is consumed.
			const retries = (this.waitRetriesByTask.get(taskId) ?? 0) + 1
			assert.ok(retries <= 3, `The ${role} scripted wait exhausted four bounded attempts`)
			this.waitRetriesByTask.set(taskId, retries)
			if (role !== "root" || turn < 6) turn -= 1
		} else {
			this.waitRetriesByTask.delete(taskId)
		}
		console.log(`[managed-agent-e2e] model task=${taskId} role=${role} turn=${turn}`)
		this.turnsByTask.set(taskId, turn + 1)
		const call: ScriptedToolCall = commandSession
			? {
					name: "write_stdin",
					arguments: { session_id: Number(commandSession), chars: "", yield_time_ms: 30_000 },
				}
			: completionBlocked
				? { name: "wait_agent", arguments: { timeout_ms: 60_000 } }
				: role === "outer" && turn >= 6
					? {
							name: "assistant_text",
							arguments: {
								result: "Applied and verified the nested proposal, then produced the outer proposal.",
							},
						}
					: await this.getToolCall(role, turn)
		if (role === "outer" && call.name === "apply_patch") {
			assert.ok(
				JSON.stringify(messages).includes(STEERING_MESSAGE),
				"send_message must reach the Worker model input",
			)
			this.observedSteeringMessage = true
		}
		if (role === "discard" && call.name === "assistant_text" && this.discardGate) {
			this.heldDiscardTaskId = taskId
			await this.discardGate
		}
		if (role === "root" && call.name === "exec_command") {
			this.heldReviewTaskId = taskId
			await this.reviewGate
		}
		if (role === "root" && call.name === "interrupt_agent") {
			this.heldInterruptCall = true
			await this.interruptGate
		}
		this.previousCallsByTask.set(taskId, call)
		const requestIndex = this.requestCountsByTask.get(taskId) ?? 0
		this.requestCountsByTask.set(taskId, requestIndex + 1)

		if (call.name === "assistant_text") {
			assert.equal(typeof call.arguments.result, "string")
			yield { type: "text", text: String(call.arguments.result) }
		} else {
			yield {
				type: "tool_call",
				id: `managed-agent-e2e-${taskId}-${requestIndex}`,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			}
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

	private readonly taskIdsByRole = new Map<ScriptRole, string>()
	private readonly terminalTaskIds = new Set<string>()

	private assertPriorToolSucceeded(role: ScriptRole, turn: number, messages: unknown[]): string | undefined {
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
			serialized.includes("Command execution was not successful") ||
			/\b(?:Process exited with code|Exit code:)\s*[1-9]\d*/i.test(serialized) ||
			/"exit_code"\s*:\s*[1-9]\d*/.test(serialized)
		) {
			console.error(
				`[managed-agent-e2e] prior tool failure role=${role} turn=${turn} result=${serialized.slice(0, 4_000)}`,
			)
			throw new Error(`The ${role} scripted turn ${turn} failed: ${serialized.slice(0, 500)}`)
		}
		return serialized
	}

	private async getToolCall(role: ScriptRole, turn: number): Promise<ScriptedToolCall> {
		const scripts: Record<ScriptRole, ScriptedToolCall[]> = {
			root: [
				{
					name: "spawn_agent",
					arguments: {
						task_name: "outer_worker",
						message: OUTER_OBJECTIVE,
						fork_turns: "none",
						agent_type: "worker",
					},
				},
				{
					name: "send_message",
					arguments: {
						target: "outer_worker",
						message: STEERING_MESSAGE,
					},
				},
				{
					name: "spawn_agent",
					arguments: {
						task_name: "discard_worker",
						message: DISCARD_OBJECTIVE,
						fork_turns: "none",
						agent_type: "worker",
					},
				},
				{
					name: "spawn_agent",
					arguments: {
						task_name: "interrupt_worker",
						message: INTERRUPT_OBJECTIVE,
						fork_turns: "none",
						agent_type: "worker",
					},
				},
				{
					name: "list_agents",
					arguments: {},
				},
				{
					name: "interrupt_agent",
					arguments: {
						target: INTERRUPT_PATH,
					},
				},
			],
			outer: [
				{
					name: "spawn_agent",
					arguments: {
						task_name: "nested_writer",
						message: NESTED_OBJECTIVE,
						fork_turns: "none",
						agent_type: "worker",
					},
				},
				{
					name: "wait_agent",
					arguments: {
						timeout_ms: 60_000,
					},
				},
				{
					name: "exec_command",
					arguments: {
						cmd: "vitest run --maxWorkers=2",
						workdir: OUTER_VERIFY_CWD,
						yield_time_ms: 30_000,
					},
				},
				{
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Update File: ${OUTER_PATH}\n@@\n-export default {"owner":"baseline","verified":false}\n+export default {"owner":"outer_worker","verified":true}\n*** End Patch`,
					},
				},
				{
					name: "exec_command",
					arguments: {
						cmd: "vitest run --maxWorkers=2",
						workdir: ROOT_VERIFY_CWD,
						yield_time_ms: 30_000,
					},
				},
				{
					name: "assistant_text",
					arguments: {
						result: "Applied and verified the nested proposal, then produced the outer proposal.",
					},
				},
			],
			nested: [
				{
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Update File: ${NESTED_PATH}\n@@\n-export default {"owner":"baseline","verified":false}\n+export default {"owner":"nested_writer","verified":true}\n*** End Patch`,
					},
				},
				{
					name: "assistant_text",
					arguments: { result: "Produced the nested fixture proposal." },
				},
			],
			discard: [
				{
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Update File: ${DISCARD_PATH}\n@@\n-{"owner":"baseline","verified":false}\n+{"owner":"discard_worker","verified":true}\n*** End Patch`,
					},
				},
				{
					name: "assistant_text",
					arguments: { result: "Produced the throwaway fixture proposal." },
				},
			],
			interrupt: [
				{ name: "wait_agent", arguments: { timeout_ms: 60_000 } },
				{ name: "assistant_text", arguments: { result: "The interrupted Worker resumed and finished." } },
			],
		}

		let call = scripts[role][turn]
		if (role === "root" && turn >= 6) {
			const requiredIds = ["outer", "discard", "interrupt"]
				.map((requiredRole) => this.taskIdsByRole.get(requiredRole as ScriptRole))
				.filter((id): id is string => id !== undefined)
			if (requiredIds.length === 3 && requiredIds.every((id) => this.terminalTaskIds.has(id))) {
				if (this.rootVerificationIssued) {
					call = {
						name: "assistant_text",
						arguments: {
							result: "Reviewed the child proposals, applied the outer change, and verified the result.",
						},
					}
				} else {
					call = {
						name: "exec_command",
						arguments: {
							cmd: "vitest run --maxWorkers=2",
							workdir: ROOT_VERIFY_CWD,
							yield_time_ms: 30_000,
						},
					}
					this.rootVerificationIssued = true
				}
			} else {
				call = { name: "wait_agent", arguments: { timeout_ms: 20_000 } }
			}
		}
		if (!call) throw new Error(`Unexpected ${role} model turn ${turn + 1}`)
		if (call.name === "exec_command") {
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
	postStateToWebview(): Promise<void>
	getTaskWithId(taskId: string): Promise<{
		apiConversationHistory: Array<{
			role: string
			content: string | Array<{ type: string; name?: string; text?: string }>
		}>
	}>
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
				taskAsk?: AlphaMessage
				isInitialized?: boolean
				isTaskLoopActive?: boolean
				isWaitingForFirstChunk?: boolean
				isStreaming?: boolean
				currentAgentStep?: { stepId: string }
				activeAsk?: { type: string; ts: number }
				askResponse?: string
				messageQueueService?: { isEmpty(): boolean }
				clineMessages?: AlphaMessage[]
				approveAsk(): void
				getCommandExecutionEvidence(): Array<{
					command?: string
					status: string
					verificationChangeSetIds?: string[]
				}>
		  }
		| undefined
}

type AgentTarget = {
	group: SubagentGroupState
	agent: SubagentGroupState["agents"][number]
}

const getHostProvider = (api: AlphaCodeAPI): ManagedAgentHostProvider => {
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
	this.timeout((process.env.ALPHA_UI_ACCEPTANCE_NONCE ? 6 : 3) * 60_000)

	test("runs nested Apply, discard, verification, projection, and navigation without manual input", async () => {
		const api = globalThis.api
		const renderedUi = !!process.env.ALPHA_UI_ACCEPTANCE_NONCE
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
		const configuration: AlphaCodeSettings = {
			apiProvider: "fake-ai",
			fakeAi: scriptedAI,
			currentApiConfigName: "managed-agent-scripted-e2e",
			mode: "code",
			approvalMode: "ask",
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
			maxConcurrentSubagents: 4,
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
		const completionCounts = new Map<string, number>()
		const completionPromptTasks = new Set<string>()
		const toolFailures: string[] = []
		const lastGroupStates = new Map<string, string>()
		const onMessage = (event: { taskId: string; action: "created" | "updated"; message: AlphaMessage }) => {
			if (event.message.type === "ask" && (event.message.ask === "tool" || event.message.ask === "command")) {
				queueMicrotask(() => provider.getLiveTask(event.taskId)?.approveAsk())
			}
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
			completionCounts.set(taskId, (completionCounts.get(taskId) ?? 0) + 1)
		}
		const onToolFailed = (taskId: string, tool: string, error: string) => {
			const failure = `task=${taskId} tool=${tool}: ${error}`
			toolFailures.push(failure)
			console.error(`[managed-agent-e2e] tool failure ${failure}`)
		}

		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskSpawned, onSpawned)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		api.on(AlphaCodeEventName.TaskToolFailed, onToolFailed)

		let rootTaskId: string | undefined
		const previousPath = process.env.PATH
		try {
			process.env.PATH = [REPOSITORY_NODE_BIN, previousPath]
				.filter((entry): entry is string => entry !== undefined && entry.length > 0)
				.join(path.delimiter)
			await api.setConfiguration(configuration)
			if (renderedUi) {
				await provider.postStateToWebview()
				await vscode.commands.executeCommand("alpha.settingsButtonClicked")
				await uiFixtureBarrier("settings-edit", { version: vscode.version })
				await provider.postStateToWebview()
				await provider.postStateToWebview()
				await uiFixtureBarrier("settings-refresh-discard")
				assert.equal(api.getConfiguration().maxConcurrentSubagents, 4)
			}

			rootTaskId = await api.startNewTask({
				configuration,
				text: "Run the deterministic managed-agent acceptance scenario exactly as scripted.",
			})

			const [outerTarget, discardTarget] = await Promise.all([
				waitForAgent(provider, groups, rootTaskId, OUTER_OBJECTIVE),
				waitForAgent(provider, groups, rootTaskId, DISCARD_OBJECTIVE),
			])
			const interruptTarget = await waitForAgent(provider, groups, rootTaskId, INTERRUPT_OBJECTIVE)
			const outerTaskId = outerTarget.agent.taskId
			const discardTaskId = discardTarget.agent.taskId
			const interruptTaskId = interruptTarget.agent.taskId
			const nestedTarget = await waitForAgent(provider, groups, outerTaskId, NESTED_OBJECTIVE)
			const nestedTaskId = nestedTarget.agent.taskId

			await Promise.all(
				[
					`${rootTaskId}:${outerTaskId}`,
					`${rootTaskId}:${discardTaskId}`,
					`${rootTaskId}:${interruptTaskId}`,
					`${outerTaskId}:${nestedTaskId}`,
				].map((edge) => waitFor(() => spawned.has(edge), { timeout: 30_000, interval: 50 })),
			)
			await waitFor(() => scriptedAI.heldInterruptCall, {
				timeout: 60_000,
				interval: 50,
				description: "model-visible interrupt_agent call barrier",
			})
			await waitFor(
				async () => {
					try {
						const history = await provider.getTaskWithId(interruptTaskId)
						return history.apiConversationHistory.some(
							(message) =>
								Array.isArray(message.content) &&
								message.content.some(
									(block) => block.type === "tool_use" && block.name === "wait_agent",
								),
						)
					} catch (error) {
						// Spawn publication can precede the child's first durable history write.
						// Treat only that known admission window as retryable; preserve every
						// other persistence failure for the acceptance gate to report.
						if (error instanceof Error && error.message === "Task not found") return false
						throw error
					}
				},
				{ timeout: 60_000, interval: 50, description: "interrupt Worker blocked in wait_agent" },
			)
			scriptedAI.releaseInterrupt()

			const nestedChangeSet = await waitForPendingChangeSet(groups, outerTaskId, NESTED_OBJECTIVE)
			if (renderedUi) {
				await waitFor(() => scriptedAI.heldDiscardTaskId === discardTaskId, { timeout: 30000 })
				const heldSibling = provider.getLiveTask(discardTaskId)
				assert.ok(heldSibling)
				await provider.showTaskWithId(rootTaskId)
				await provider.postStateToWebview()
				for (const [stage, expectedTaskId] of [
					["live-navigate-nested", nestedTaskId],
					["live-navigate-outer", outerTaskId],
					["live-navigate-root", rootTaskId],
				] as const) {
					await uiFixtureBarrier(stage, {
						nickname: nestedTarget.agent.nickname,
						siblingTaskId: discardTaskId,
					})
					await waitFor(
						async () => (await provider.getStateToPostToWebview()).currentTaskId === expectedTaskId,
						{ timeout: 10000 },
					)
					assert.strictEqual(provider.getLiveTask(discardTaskId), heldSibling)
					const live = (await provider.getStateToPostToWebview()).liveTasksById?.[discardTaskId]
					assert.equal(live?.id, discardTaskId)
					assert.equal(live?.status, "running")
					assert.equal(completed.has(discardTaskId), false)
				}
				scriptedAI.releaseDiscard()
			}
			await waitForAvailableCapability(provider, nestedChangeSet, "apply")
			if (renderedUi) {
				await provider.showTaskWithId(outerTaskId)
				await provider.postStateToWebview()
				await uiFixtureBarrier("nested-apply", { nickname: nestedTarget.agent.nickname })
				await waitFor(
					() => findAgent(groups, outerTaskId, NESTED_OBJECTIVE)?.agent.changeSet?.status === "applied",
					{ timeout: 10000 },
				)
			} else {
				const nestedApply = await provider.applySubagentChangeSet(
					nestedChangeSet.taskId,
					nestedChangeSet.groupId,
					nestedChangeSet.changeSetId,
				)
				assert.equal(nestedApply.success, true, nestedApply.message)
				assert.equal(nestedApply.changeSetStatus, "applied")
			}
			scriptedAI.setVerificationChangeSets("outer", [nestedChangeSet.changeSetId])
			// The inherited vitest rule must approve verification without a harness response.

			const [outerChangeSet, discardChangeSet] = await Promise.all([
				waitForPendingChangeSet(groups, rootTaskId, OUTER_OBJECTIVE),
				waitForPendingChangeSet(groups, rootTaskId, DISCARD_OBJECTIVE),
			])
			await waitForAvailableCapability(provider, discardChangeSet, "discard")
			if (renderedUi) {
				await provider.showTaskWithId(rootTaskId)
				await provider.postStateToWebview()
				await uiFixtureBarrier("discard-discard", { nickname: discardTarget.agent.nickname })
				await waitFor(
					() => findAgent(groups, rootTaskId!, DISCARD_OBJECTIVE)?.agent.changeSet?.status === "discarded",
					{ timeout: 10000 },
				)
			} else {
				const discarded = await provider.discardSubagentChangeSet(
					discardChangeSet.taskId,
					discardChangeSet.groupId,
					discardChangeSet.changeSetId,
				)
				assert.equal(discarded.success, true, discarded.message)
				assert.equal(discarded.changeSetStatus, "discarded")
			}

			await waitForAvailableCapability(provider, outerChangeSet, "apply")
			if (renderedUi) {
				await provider.showTaskWithId(rootTaskId)
				await provider.postStateToWebview()
				await uiFixtureBarrier("outer-apply", { nickname: outerTarget.agent.nickname })
				await waitFor(
					() => findAgent(groups, rootTaskId!, OUTER_OBJECTIVE)?.agent.changeSet?.status === "applied",
					{ timeout: 10000 },
				)
			} else {
				const outerApply = await provider.applySubagentChangeSet(
					outerChangeSet.taskId,
					outerChangeSet.groupId,
					outerChangeSet.changeSetId,
				)
				assert.equal(outerApply.success, true, outerApply.message)
				assert.equal(outerApply.changeSetStatus, "applied")
			}
			scriptedAI.setVerificationChangeSets("root", [outerChangeSet.changeSetId])
			await waitFor(() => scriptedAI.heldReviewTaskId === rootTaskId, {
				timeout: 60_000,
				interval: 50,
				description: "root review gate before verification",
			})
			assert.equal(
				scriptedAI.observedSteeringMessage,
				true,
				"The outer Worker must receive its send_message input",
			)
			assert.equal(
				scriptedAI.observedInterruptResult,
				true,
				"interrupt_agent must return the child's prior status",
			)
			assert.ok(scriptedAI.observedMailboxClaims > 0, "wait_agent must claim and deliver mailbox updates")
			scriptedAI.releaseReview()

			const stateBeforeResume = await provider.getStateToPostToWebview()
			const projection = managedAgentTreeProjectionSchema.parse(stateBeforeResume.managedAgentTree)
			assert.equal(projection.rootTaskId, rootTaskId)
			assert.equal(projection.nodes.length, 5)
			assert.deepEqual(
				projection.nodes
					.map(({ taskId, parentTaskId, depth }) => ({ taskId, parentTaskId, depth }))
					.sort((left, right) => left.taskId.localeCompare(right.taskId)),
				[
					{ taskId: rootTaskId, parentTaskId: undefined, depth: 0 },
					{ taskId: outerTaskId, parentTaskId: rootTaskId, depth: 1 },
					{ taskId: discardTaskId, parentTaskId: rootTaskId, depth: 1 },
					{ taskId: interruptTaskId, parentTaskId: rootTaskId, depth: 1 },
					{ taskId: nestedTaskId, parentTaskId: outerTaskId, depth: 2 },
				].sort((left, right) => left.taskId.localeCompare(right.taskId)),
			)
			assert.equal(projection.capacity.active, 0)
			assert.equal(projection.capacity.queued, 0)
			assert.equal(projection.capacity.terminal, 4)

			const persisted = api.getConfiguration()
			assert.equal(persisted.maxConcurrentSubagents, 4)
			assert.equal(persisted.subagentMaxDepth, 2)
			assert.equal(persisted.subagentDelegationPolicy, "proactive")

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
			assert.ok(scriptedAI.observedMailboxClaims > 0, "The scenario never delivered a mailbox claim")
			assert.equal(scriptedAI.observedSteeringMessage, true)
			assert.equal(scriptedAI.observedInterruptResult, true)
			assert.equal(
				completed.has(interruptTaskId),
				false,
				"An interrupted Worker must not be reported as completed",
			)
			assert.equal(findAgent(groups, rootTaskId!, INTERRUPT_OBJECTIVE)?.agent.status, "interrupted")
			const rootCommandEvidence = provider.getLiveTask(rootTaskId!)?.getCommandExecutionEvidence() ?? []
			assert.ok(
				rootCommandEvidence.some(
					(evidence) =>
						evidence.status === "succeeded" &&
						evidence.command?.includes("vitest run --maxWorkers=2") &&
						evidence.verificationChangeSetIds?.includes(outerChangeSet.changeSetId),
				),
				"The current exec_command action must succeed and verify the applied root change set",
			)
			const rootHistory = (await provider.getTaskWithId(rootTaskId!)).apiConversationHistory
			const rootToolNames = rootHistory.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.flatMap((block) => (block.type === "tool_use" && block.name ? [block.name] : []))
					: [],
			)
			for (const name of [
				"spawn_agent",
				"send_message",
				"list_agents",
				"interrupt_agent",
				"wait_agent",
				"exec_command",
			])
				assert.ok(rootToolNames.includes(name), `The host transcript did not record ${name}`)
			assert.ok(completed.has(outerTaskId), "Outer Worker never reached a terminal completion")
			assert.ok(completed.has(nestedTaskId), "Nested Worker never reached a terminal completion")
			assert.ok(completed.has(discardTaskId), "Discard Worker never reached a terminal completion")
			for (const [taskId, expectedReport] of [
				[outerTaskId, "Applied and verified the nested proposal, then produced the outer proposal."],
				[nestedTaskId, "Produced the nested fixture proposal."],
				[discardTaskId, "Produced the throwaway fixture proposal."],
			] as const) {
				assert.equal(completionCounts.get(taskId), 1, "Child completion must be published once")
				assert.equal(completionPromptTasks.has(taskId), false, "Child review belongs to the parent")
				const { apiConversationHistory } = await provider.getTaskWithId(taskId)
				const expectedAnswerCount = taskId === outerTaskId && scriptedAI.observedCompletionGateRecovery ? 2 : 1
				assert.equal(
					apiConversationHistory.filter(
						(message) =>
							message.role === "assistant" &&
							Array.isArray(message.content) &&
							message.content.some((block) => block.type === "text" && block.text === expectedReport),
					).length,
					expectedAnswerCount,
					"The accepted child answer and any rejected completion candidate must survive transcript persistence",
				)
				if (taskId === outerTaskId && scriptedAI.observedCompletionGateRecovery) {
					assert.ok(
						apiConversationHistory.some(
							(message) =>
								message.role === "user" &&
								JSON.stringify(message.content).includes("terminal result remains unconsumed"),
						),
						"The rejected completion must remain visible to the model before it waits and retries",
					)
				}
			}

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

			if (renderedUi) await uiFixtureBarrier("navigate-nested", { nickname: nestedTarget.agent.nickname })
			else await provider.showTaskWithId(nestedTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === nestedTaskId, {
				timeout: 30_000,
				interval: 50,
			})
			if (renderedUi) await uiFixtureBarrier("navigate-outer")
			else await provider.showTaskWithId(outerTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === outerTaskId, {
				timeout: 30_000,
				interval: 50,
			})
			if (renderedUi) await uiFixtureBarrier("navigate-root")
			else await provider.showTaskWithId(rootTaskId)
			await waitFor(async () => (await provider.getStateToPostToWebview()).currentTaskId === rootTaskId, {
				timeout: 30_000,
				interval: 50,
			})
			if (renderedUi) {
				const finalTree = managedAgentTreeProjectionSchema.parse(
					(await provider.getStateToPostToWebview()).managedAgentTree,
				)
				assert.equal(finalTree.nodes.length, 5)
				assert.equal(finalTree.capacity.terminal, 4)
				await uiFixtureBarrier("complete")
			}
		} finally {
			scriptedAI.releaseDiscard()
			scriptedAI.releaseReview()
			scriptedAI.releaseInterrupt()
			api.off(AlphaCodeEventName.Message, onMessage)
			api.off(AlphaCodeEventName.TaskSpawned, onSpawned)
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			api.off(AlphaCodeEventName.TaskToolFailed, onToolFailed)
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
