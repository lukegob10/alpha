import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { promisify } from "node:util"

import {
	agentControlStateSchema,
	managedAgentTreeProjectionSchema,
	AlphaCodeEventName,
	type AlphaCodeSettings,
	type SubagentGroupState,
	type SubagentSpawnHandle,
} from "@alpha-code/types"

import {
	isProcessAlive,
	readProcessTreeObservation,
	startNonCooperativeHttpStream,
	terminateProcessTree,
	writeProcessTreeFixture,
	CancellationStreamAI,
	CANCELLATION_PROCESS_STATE_ENV,
	type ProcessTreeObservation,
} from "../scenarios/cancellationFixture"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
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

interface CancellationProvider {
	agentControlStore: { getSnapshot(): unknown }
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<{ managedAgentTree?: unknown }>
	prepareSubagentGroup(parent: LiveTask, drafts: unknown[]): Promise<PreparedGroup>
	launchPreparedSubagentGroup(
		parent: LiveTask,
		prepared: PreparedGroup,
		signal: AbortSignal,
	): Promise<SubagentSpawnHandle>
}

const getProvider = (): CancellationProvider => {
	const provider = (globalThis.api as unknown as { sidebarProvider?: CancellationProvider }).sidebarProvider
	assert.ok(provider, "The extension API did not expose the host provider")
	return provider
}

const execFile = promisify(execFileCallback)

const ensureGitRepository = async (workspace: string): Promise<void> => {
	try {
		await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace, windowsHide: true })
	} catch {
		await execFile("git", ["init"], { cwd: workspace, windowsHide: true })
	}
	await execFile("git", ["add", "-f", "--", ".alpha-cancellation"], { cwd: workspace, windowsHide: true })
	const { stdout } = await execFile("git", ["diff", "--cached", "--name-only"], {
		cwd: workspace,
		windowsHide: true,
	})
	if (stdout.trim().length > 0) {
		await execFile(
			"git",
			[
				"-c",
				"user.name=Alpha E2E",
				"-c",
				"user.email=alpha-e2e@local.invalid",
				"commit",
				"-m",
				"managed-agent cancellation baseline",
			],
			{ cwd: workspace, windowsHide: true },
		)
	}
}

const readJsonLines = async (filePath: string): Promise<unknown[]> => {
	const contents = await fs.readFile(filePath, "utf8")
	return contents
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown)
}

const launchWorker = async (
	provider: CancellationProvider,
	model: CancellationStreamAI,
	parent: LiveTask,
	name: string,
	role: "stream" | "process",
): Promise<SubagentSpawnHandle> => {
	const prepared = await provider.prepareSubagentGroup(parent, [
		{
			task_name: name,
			fork_turns: "none",
			agent_kind: "worker",
			objective: `Hold the ${role} cancellation fixture until the root is cancelled.`,
			write_scope: [".alpha-cancellation"],
		},
	])
	assert.notEqual(prepared.requiresExplicitApproval, true, "The fixture must use proactive child approval")
	const taskId = prepared.group.agents[0]?.taskId
	assert.ok(taskId, `Prepared ${role} worker did not receive a task id`)
	model.registerRole(taskId, role)
	return provider.launchPreparedSubagentGroup(parent, prepared, parent.getTaskLifetimeCancellationSignal())
}

suite("Managed-agent cancellation Extension Host acceptance", function () {
	this.timeout(120_000)

	test("cancels a held provider stream and command process tree with one terminal per task", async function () {
		if (process.env.ALPHA_E2E_CANCELLATION_RUN !== "1") {
			this.skip()
			return
		}
		assert.equal(vscode.version, "1.122.1")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace, "ALPHA_E2E_WORKSPACE was not provided")
		assert.ok(artifacts, "ALPHA_E2E_ARTIFACTS_DIR was not provided")

		const api = globalThis.api
		const provider = getProvider()
		const previousConfiguration = api.getConfiguration()
		const stream = await startNonCooperativeHttpStream()
		const processFixture = await writeProcessTreeFixture(workspace)
		await ensureGitRepository(workspace)
		const model = new CancellationStreamAI(stream.url, processFixture.command)
		const configuration: AlphaCodeSettings = {
			...api.getConfiguration(),
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
		const abortedCounts = new Map<string, number>()
		const completedCounts = new Map<string, number>()
		const onAborted = (taskId: string) => abortedCounts.set(taskId, (abortedCounts.get(taskId) ?? 0) + 1)
		const onCompleted = (taskId: string) => completedCounts.set(taskId, (completedCounts.get(taskId) ?? 0) + 1)
		api.on(AlphaCodeEventName.TaskAborted, onAborted)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)

		let workerIds: string[] = []
		let processObservation: ProcessTreeObservation = {}
		const previousProcessStatePath = process.env[CANCELLATION_PROCESS_STATE_ENV]
		try {
			process.env[CANCELLATION_PROCESS_STATE_ENV] = processFixture.statePath
			await api.setConfiguration(configuration)
			const rootId = await api.startNewTask({
				configuration,
				text: "Hold the root task while the cancellation acceptance fixture starts its managed workers.",
			})
			model.registerRole(rootId, "root")
			await waitFor(() => model.entered.has(rootId), {
				description: "root provider request to hold",
			})
			const root = provider.getLiveTask(rootId)
			assert.ok(root, "The root task disappeared before child launch")
			const [streamWorker, processWorker] = await Promise.all([
				launchWorker(provider, model, root, "stream_worker", "stream"),
				launchWorker(provider, model, root, "process_worker", "process"),
			])
			workerIds = [streamWorker.taskId, processWorker.taskId]

			await waitFor(() => model.entered.has(streamWorker.taskId), {
				description: "stream Worker to receive the first response chunk",
			})
			await waitFor(
				() =>
					stream.observation.responseStarted &&
					model.observations.get(streamWorker.taskId)?.fetchStartedWithSignal === true,
				{ description: "non-cooperative HTTP response to open" },
			)
			await waitFor(
				async () => {
					processObservation = await readProcessTreeObservation(processFixture.statePath)
					return (
						typeof processObservation.commandPid === "number" &&
						typeof processObservation.descendantActualPid === "number" &&
						processObservation.descendantReadyAt !== undefined
					)
				},
				{ description: "command Worker to create its grandchild" },
			)
			assert.equal(isProcessAlive(processObservation.commandPid), true)
			assert.equal(isProcessAlive(processObservation.descendantActualPid), true)
			// launchPreparedSubagentGroup returns after admission, before its live Task
			// is necessarily registered. Capture the original instances only after each
			// child has crossed its observable start barrier and before cancellation.
			const liveTasksBeforeCancellation = [
				root,
				provider.getLiveTask(streamWorker.taskId),
				provider.getLiveTask(processWorker.taskId),
			]
			assert.ok(liveTasksBeforeCancellation.every((task): task is LiveTask => task !== undefined))

			// This is the observation boundary. Every assertion below is made after
			// cancellation and before fixture teardown, so cleanup cannot create it.
			await api.cancelCurrentTask()
			for (const task of liveTasksBeforeCancellation) await task.waitForTermination()
			await waitFor(() => model.observations.get(streamWorker.taskId)?.abortObserved === true, {
				description: "provider AbortSignal to fire",
			})
			await waitFor(() => model.observations.get(streamWorker.taskId)?.streamReadAborted === true, {
				description: "provider HTTP reader to observe abort",
			})
			await waitFor(() => stream.observation.clientClosed, {
				description: "HTTP server to observe a client close",
			})
			await waitFor(
				() =>
					!isProcessAlive(processObservation.commandPid) &&
					!isProcessAlive(processObservation.descendantActualPid),
				{ description: "command Worker process tree to die" },
			)

			for (const taskId of [rootId, ...workerIds]) {
				assert.equal(abortedCounts.get(taskId), 1, `Task ${taskId} must emit exactly one abort event`)
				assert.equal(completedCounts.get(taskId) ?? 0, 0, `Cancelled task ${taskId} must not complete`)
				const task = await provider.getTaskWithId(taskId)
				const lifecycle = inspectTaskLifecycle(
					await readJsonLines(path.join(task.taskDirPath, "agent_lifecycle_events.jsonl")),
					taskId,
				)
				assert.deepEqual(lifecycle.errors, [], `Task ${taskId} lifecycle journal is malformed`)
				assert.equal(lifecycle.cancelledTurns, 1, `Task ${taskId} must have one cancelled turn`)
				assert.equal(lifecycle.completedTurns, 0, `Task ${taskId} must have no completed turn`)
				if (taskId === processWorker.taskId) {
					const history = JSON.parse(
						await fs.readFile(path.join(task.taskDirPath, "api_conversation_history.json"), "utf8"),
					)
					const transactions = inspectToolTransactions(history)
					assert.deepEqual(transactions.errors, [])
					assert.equal(transactions.callCount, 1)
					assert.equal(transactions.resultCount, 1)
				}
			}

			const control = agentControlStateSchema.parse(provider.agentControlStore.getSnapshot())
			const records = control.agents.filter((agent) => workerIds.includes(agent.taskId))
			assert.equal(records.length, workerIds.length)
			assert.ok(records.every((agent) => ["cancelled", "interrupted"].includes(agent.status)))
			const terminalResults = control.mailbox.filter(
				(event) =>
					event.kind === "result" &&
					event.senderTaskId !== undefined &&
					workerIds.includes(event.senderTaskId),
			)
			for (const taskId of workerIds)
				assert.equal(
					terminalResults.filter((event) => event.senderTaskId === taskId).length,
					1,
					`Worker ${taskId} must publish one terminal result`,
				)
			const projected = managedAgentTreeProjectionSchema.parse(
				(await provider.getStateToPostToWebview()).managedAgentTree,
			)
			assert.equal(projected.capacity.active, 0)
			assert.equal(projected.capacity.queued, 0)
			assert.equal(projected.capacity.terminal, workerIds.length)

			await fs.writeFile(
				path.join(artifacts, "managed-agent-cancellation.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						scenarioId: "managed-agent-cancellation",
						hostVersion: vscode.version,
						extensionHostPid: process.pid,
						rootTaskId: rootId,
						workerIds,
						providerAbortObserved: model.observations.get(streamWorker.taskId)?.abortObserved === true,
						providerFetchStartedWithSignal:
							model.observations.get(streamWorker.taskId)?.fetchStartedWithSignal === true,
						streamClientClosed: stream.observation.clientClosed,
						processTreeDead:
							!isProcessAlive(processObservation.commandPid) &&
							!isProcessAlive(processObservation.descendantActualPid),
						terminalResults: terminalResults.length,
						capacity: projected.capacity,
					},
					null,
					2,
				),
				{ encoding: "utf8", flag: "wx", mode: 0o600 },
			)
		} finally {
			api.off(AlphaCodeEventName.TaskAborted, onAborted)
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await terminateProcessTree(processObservation)
			model.dispose()
			await stream.close()
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(previousConfiguration).catch(() => undefined)
			if (previousProcessStatePath === undefined) delete process.env[CANCELLATION_PROCESS_STATE_ENV]
			else process.env[CANCELLATION_PROCESS_STATE_ENV] = previousProcessStatePath
		}
	})
})
