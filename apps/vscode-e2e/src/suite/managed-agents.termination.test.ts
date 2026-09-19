import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	agentControlStateSchema,
	managedAgentTreeProjectionSchema,
	type AlphaCodeSettings,
	type SubagentGroupState,
	type SubagentSpawnHandle,
} from "@alpha-code/types"

import {
	CANCELLATION_PROCESS_STATE_ENV,
	isProcessAlive,
	readProcessTreeObservation,
	terminateProcessTree,
	CancellationStreamAI,
	type ProcessTreeObservation,
} from "../scenarios/cancellationFixture"
import { waitFor } from "./utils"

interface LiveTask {
	taskId: string
	getTaskLifetimeCancellationSignal(): AbortSignal
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface PreparedGroup {
	group: SubagentGroupState
	requiresExplicitApproval?: boolean
}

interface TerminationProvider {
	agentControlStore: { getSnapshot(): unknown }
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<{ managedAgentTree?: unknown }>
	showTaskWithId(taskId: string): Promise<void>
	prepareSubagentGroup(parent: LiveTask, drafts: unknown[]): Promise<PreparedGroup>
	launchPreparedSubagentGroup(
		parent: LiveTask,
		prepared: PreparedGroup,
		signal: AbortSignal,
	): Promise<SubagentSpawnHandle>
}

const provider = (): TerminationProvider => {
	const value = (globalThis.api as unknown as { sidebarProvider?: TerminationProvider }).sidebarProvider
	assert.ok(value, "The extension API did not expose the host provider")
	return value
}

const launchWorker = async (
	backend: TerminationProvider,
	model: CancellationStreamAI,
	parent: LiveTask,
	name: string,
	role: "stream" | "process",
): Promise<SubagentSpawnHandle> => {
	const prepared = await backend.prepareSubagentGroup(parent, [
		{
			task_name: name,
			fork_turns: "none",
			agent_kind: "worker",
			objective: `Hold the ${role} fixture until the owned VS Code window closes.`,
			write_scope: [".alpha-cancellation"],
		},
	])
	assert.notEqual(prepared.requiresExplicitApproval, true)
	const taskId = prepared.group.agents[0]?.taskId
	assert.ok(taskId)
	model.registerRole(taskId, role)
	return backend.launchPreparedSubagentGroup(parent, prepared, parent.getTaskLifetimeCancellationSignal())
}

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
	const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	return value as Record<string, unknown>
}

suite("Managed-agent orderly host termination", function () {
	this.timeout(120_000)

	test("closes the owned window after external stream/process readiness, then verifies reload state", async function () {
		const phase = process.env.ALPHA_E2E_TERMINATION_PHASE
		if (!phase) {
			this.skip()
			return
		}
		assert.ok(phase === "prepare" || phase === "recover")
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		if (phase === "prepare") await prepareTermination()
		else await recoverTermination()
	})
})

async function prepareTermination(): Promise<void> {
	const streamUrl = process.env.ALPHA_E2E_TERMINATION_STREAM_URL
	const processCommand = process.env.ALPHA_E2E_TERMINATION_PROCESS_COMMAND
	const processStatePath = process.env.ALPHA_E2E_TERMINATION_PROCESS_STATE
	const readyPath = process.env.ALPHA_E2E_TERMINATION_READY_PATH
	const runId = process.env.ALPHA_E2E_RUN_ID
	assert.ok(streamUrl && processCommand && processStatePath && readyPath && runId)
	const api = globalThis.api
	const backend = provider()
	const previousConfiguration = api.getConfiguration()
	const previousProcessStatePath = process.env[CANCELLATION_PROCESS_STATE_ENV]
	const model = new CancellationStreamAI(streamUrl, processCommand)
	const configuration: AlphaCodeSettings = {
		...previousConfiguration,
		apiProvider: "fake-ai",
		fakeAi: model,
		mode: "code",
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
		maxConcurrentTasks: 3,
		maxConcurrentSubagents: 2,
		subagentDelegationPolicy: "proactive",
		subagentMaxDepth: 2,
		subagentRoleTimeoutsMs: { worker: 120_000 },
		subagentMaxInputTokens: 250_000,
		subagentMaxOutputTokens: 16_000,
		subagentRootTokenBudget: null,
		subagentRootCostBudget: null,
		commandExecutionTimeout: 30,
	}
	let ready = false
	let processObservation: ProcessTreeObservation = {}
	try {
		process.env[CANCELLATION_PROCESS_STATE_ENV] = processStatePath
		await api.setConfiguration(configuration)
		const rootId = await api.startNewTask({
			configuration,
			text: "Hold the root while the orderly host termination fixtures start.",
		})
		model.registerRole(rootId, "root")
		await waitFor(() => model.entered.has(rootId), { description: "termination root provider request" })
		const root = backend.getLiveTask(rootId)
		assert.ok(root)
		const [streamWorker, processWorker] = await Promise.all([
			launchWorker(backend, model, root, "termination_stream_worker", "stream"),
			launchWorker(backend, model, root, "termination_process_worker", "process"),
		])
		await waitFor(() => model.entered.has(streamWorker.taskId), { description: "termination stream Worker" })
		await waitFor(() => model.observations.get(streamWorker.taskId)?.fetchStartedWithSignal === true, {
			description: "termination stream request with signal",
		})
		await waitFor(() => model.entered.has(processWorker.taskId), { description: "termination process Worker" })
		await waitFor(
			async () => {
				processObservation = await readProcessTreeObservation(processStatePath)
				return (
					typeof processObservation.commandPid === "number" &&
					typeof processObservation.descendantActualPid === "number" &&
					processObservation.descendantReadyAt !== undefined &&
					isProcessAlive(processObservation.commandPid) &&
					isProcessAlive(processObservation.descendantActualPid)
				)
			},
			{ description: "termination process tree readiness" },
		)
		const originalTasks = [
			root,
			backend.getLiveTask(streamWorker.taskId),
			backend.getLiveTask(processWorker.taskId),
		]
		assert.ok(originalTasks.every((task): task is LiveTask => task !== undefined))
		for (const task of originalTasks) await task.flushApiConversationHistoryPersistence()
		await fs.writeFile(
			readyPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					phase: "prepare",
					runId,
					hostVersion: vscode.version,
					extensionHostPid: process.pid,
					extensionHostParentPid: process.ppid,
					rootTaskId: rootId,
					workerIds: [streamWorker.taskId, processWorker.taskId],
					providerFetchStartedWithSignal:
						model.observations.get(streamWorker.taskId)?.fetchStartedWithSignal === true,
					streamResponseStarted: model.entered.has(streamWorker.taskId),
					processTreeAlive:
						isProcessAlive(processObservation.commandPid) &&
						isProcessAlive(processObservation.descendantActualPid),
					processObservation,
				},
				null,
				2,
			),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		)
		await writeCaptureTaskIds(runId, [rootId, streamWorker.taskId, processWorker.taskId])
		ready = true
		// The campaign owns the external observer. Closing this window exercises
		// normal host deactivation while leaving the stream/process alive until it
		// has observed cancellation; no fixture cleanup runs on the success path.
		await vscode.commands.executeCommand("workbench.action.closeWindow")
	} finally {
		if (previousProcessStatePath === undefined) delete process.env[CANCELLATION_PROCESS_STATE_ENV]
		else process.env[CANCELLATION_PROCESS_STATE_ENV] = previousProcessStatePath
		if (!ready) {
			model.dispose()
			await terminateProcessTree(processObservation)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(previousConfiguration).catch(() => undefined)
		}
	}
}

async function recoverTermination(): Promise<void> {
	const readyPath = process.env.ALPHA_E2E_TERMINATION_READY_PATH
	const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
	const runId = process.env.ALPHA_E2E_RUN_ID
	assert.ok(readyPath && artifactsDir && runId)
	const ready = await readJson(readyPath)
	assert.equal(ready.phase, "prepare")
	assert.equal(typeof ready.rootTaskId, "string")
	assert.ok(Array.isArray(ready.workerIds) && ready.workerIds.every((id) => typeof id === "string"))
	const rootTaskId = ready.rootTaskId as string
	const workerIds = ready.workerIds as string[]
	await writeCaptureTaskIds(runId, [rootTaskId, ...workerIds])
	const backend = provider()
	await waitFor(
		() => {
			const state = agentControlStateSchema.parse(backend.agentControlStore.getSnapshot())
			return [rootTaskId, ...workerIds].every(
				(taskId) => state.agents.find((agent) => agent.taskId === taskId)?.status === "interrupted",
			)
		},
		{ description: "termination tasks to recover as interrupted" },
	)
	const state = agentControlStateSchema.parse(backend.agentControlStore.getSnapshot())
	for (const taskId of [rootTaskId, ...workerIds]) {
		const record = state.agents.find((agent) => agent.taskId === taskId)
		assert.ok(record)
		assert.equal(record.status, "interrupted")
	}
	const terminalResults = state.mailbox.filter(
		(event) => event.kind === "result" && workerIds.includes(event.senderTaskId ?? ""),
	)
	for (const workerId of workerIds) {
		const results = terminalResults.filter((event) => event.senderTaskId === workerId)
		assert.equal(results.length, 1)
		assert.equal(results[0]?.recipientTaskId, rootTaskId)
	}
	// A newly opened window has no selected task; select the recovered root before
	// asking the UI adapter for its root-scoped capacity projection.
	await backend.showTaskWithId(rootTaskId)
	const projection = managedAgentTreeProjectionSchema.parse(
		(await backend.getStateToPostToWebview()).managedAgentTree,
	)
	assert.equal(projection.capacity.active, 0)
	assert.equal(projection.capacity.queued, 0)
	assert.equal(projection.capacity.terminal, workerIds.length)
	const rootHistory = await backend.getTaskWithId(rootTaskId)
	const storageRoot = path.dirname(path.dirname(rootHistory.taskDirPath))
	let orphanWorktrees: string[] = []
	try {
		orphanWorktrees = await fs.readdir(path.join(storageRoot, "subagent-worktrees"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	assert.deepEqual(orphanWorktrees, [])
	await fs.writeFile(
		path.join(artifactsDir, "managed-agent-termination-recover.json"),
		JSON.stringify(
			{
				schemaVersion: 1,
				phase: "recover",
				runId,
				hostVersion: vscode.version,
				extensionHostPid: process.pid,
				extensionHostParentPid: process.ppid,
				rootTaskId,
				workerIds,
				statuses: [rootTaskId, ...workerIds].map(
					(taskId) => state.agents.find((agent) => agent.taskId === taskId)?.status,
				),
				terminalResultCount: terminalResults.length,
				capacityReleased: projection.capacity.active === 0 && projection.capacity.queued === 0,
				orphanWorktrees,
			},
			null,
			2,
		),
		{ encoding: "utf8", flag: "wx", mode: 0o600 },
	)
}

async function writeCaptureTaskIds(runId: string, taskIds: string[]): Promise<void> {
	const resultPath = process.env.ALPHA_E2E_SCENARIO_RESULT_PATH
	assert.ok(resultPath)
	await fs.writeFile(resultPath, JSON.stringify({ runId, taskIds }), { flag: "wx", mode: 0o600 })
}
