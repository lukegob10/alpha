import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { promisify } from "node:util"

import {
	agentControlStateSchema,
	managedAgentTreeProjectionSchema,
	type AlphaCodeSettings,
	type SubagentGroupState,
	type SubagentSpawnHandle,
} from "@alpha-code/types"

import { inspectTaskLifecycle } from "../scenarios/transactionAssertions"
import { ManagedAgentBudgetAI, type BudgetFixtureMode } from "../scenarios/managedAgentBudgetFixture"
import {
	CANCELLATION_PROCESS_STATE_ENV,
	isProcessAlive,
	readProcessTreeObservation,
	terminateProcessTree,
	writeProcessTreeFixture,
	type ProcessTreeFixture,
	type ProcessTreeObservation,
} from "../scenarios/cancellationFixture"
import { waitFor } from "./utils"

const execFile = promisify(execFileCallback)

interface LiveTask {
	taskId: string
	getTaskLifetimeCancellationSignal(): AbortSignal
	waitForTermination(): Promise<void>
}

interface PreparedGroup {
	group: SubagentGroupState
	requiresExplicitApproval?: boolean
}

interface BudgetProvider {
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

const getProvider = (): BudgetProvider => {
	const provider = (globalThis.api as unknown as { sidebarProvider?: BudgetProvider }).sidebarProvider
	assert.ok(provider, "The extension API did not expose the host provider")
	return provider
}

const readJsonLines = async (filePath: string): Promise<unknown[]> => {
	const contents = await fs.readFile(filePath, "utf8")
	return contents
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown)
}

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
				"managed-agent budget baseline",
			],
			{ cwd: workspace, windowsHide: true },
		)
	}
}

type BudgetAgentKind = "review" | "worker"

const runBudgetCase = async (options: {
	mode: BudgetFixtureMode
	roleTimeoutMs: number
	maxOutputTokens: number
	rootTokenBudget: number | null
	expectedStatus: "timed_out" | "cancelled"
	expectedStopReason: "timeout" | "output_token_limit" | "root_token_budget"
	caseName: string
	agentKind?: BudgetAgentKind
	childCount?: number
}): Promise<void> => {
	const api = globalThis.api
	const provider = getProvider()
	const previousConfiguration = api.getConfiguration()
	const workspace = options.agentKind === "worker" ? process.env.ALPHA_E2E_WORKSPACE : undefined
	let processFixture: ProcessTreeFixture | undefined
	let processObservation: ProcessTreeObservation = {}
	const previousProcessStatePath = process.env[CANCELLATION_PROCESS_STATE_ENV]
	if (options.agentKind === "worker") {
		assert.ok(workspace, "The budget Worker fixture requires ALPHA_E2E_WORKSPACE")
		processFixture = await writeProcessTreeFixture(workspace)
		await ensureGitRepository(workspace)
		process.env[CANCELLATION_PROCESS_STATE_ENV] = processFixture.statePath
	}
	const model = new ManagedAgentBudgetAI(processFixture?.command)
	const childCount = options.childCount ?? 1
	assert.ok(childCount >= 1 && childCount <= 2)
	const agentKind = options.agentKind ?? "review"
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
		mcpEnabled: false,
		requestDelaySeconds: 0,
		writeDelayMs: 0,
		enableCheckpoints: false,
		maxConcurrentTasks: childCount + 1,
		maxConcurrentSubagents: childCount,
		subagentDelegationPolicy: "proactive",
		subagentMaxDepth: 1,
		subagentRoleTimeoutsMs: {
			explore: options.roleTimeoutMs,
			review: options.roleTimeoutMs,
			worker: options.roleTimeoutMs,
		},
		subagentMaxInputTokens: 64,
		subagentMaxOutputTokens: options.maxOutputTokens,
		subagentRootTokenBudget: options.rootTokenBudget,
		subagentRootCostBudget: null,
		allowedCommands: ["node"],
		deniedCommands: [],
	}
	let rootTask: LiveTask | undefined
	const childIds: string[] = []
	const childTasks: LiveTask[] = []
	try {
		await api.setConfiguration(configuration)
		const rootTaskId = await api.startNewTask({
			configuration,
			text: `Hold the root for the local ${options.caseName} budget fixture.`,
		})
		model.registerRole(rootTaskId, "hold")
		await waitFor(() => model.entered.has(rootTaskId), { description: `${options.caseName} root request` })
		rootTask = provider.getLiveTask(rootTaskId)
		assert.ok(rootTask)
		for (let index = 0; index < childCount; index += 1) {
			const safeCaseName = options.caseName.replaceAll("-", "_")
			const prepared = await provider.prepareSubagentGroup(rootTask, [
				{
					task_name: `${safeCaseName}_child_${index + 1}`,
					fork_turns: "none",
					agent_kind: agentKind,
					objective: `Exercise the local ${options.caseName} budget boundary.`,
					...(agentKind === "worker" ? { write_scope: [".alpha-cancellation"] } : {}),
				},
			])
			assert.notEqual(prepared.requiresExplicitApproval, true)
			const childId = prepared.group.agents[0]?.taskId
			assert.ok(childId)
			model.registerRole(childId, options.mode)
			const handle = await provider.launchPreparedSubagentGroup(
				rootTask,
				prepared,
				rootTask.getTaskLifetimeCancellationSignal(),
			)
			assert.equal(handle.taskId, childId)
			childIds.push(childId)
		}
		await waitFor(() => childIds.every((childId) => model.entered.has(childId)), {
			description: `${options.caseName} child request`,
		})
		await waitFor(() => childIds.every((childId) => provider.getLiveTask(childId) !== undefined), {
			description: `${options.caseName} live child registration`,
		})
		for (const childId of childIds) {
			const childTask = provider.getLiveTask(childId)
			assert.ok(childTask)
			childTasks.push(childTask)
		}
		// Usage-producing fixtures are held until the suite has captured every
		// original LiveTask reference. This prevents an immediate budget stop from
		// racing provider.getLiveTask and rehydrating a resumable task.
		for (const childId of childIds) model.releaseUsage(childId)
		if (options.mode === "output") {
			// The host settles provider usage when the response stream closes. Wait
			// until the child has yielded its usage chunk, then release its stream
			// so the output limit is enforced at the completion boundary.
			await waitFor(() => childIds.every((childId) => model.observations.get(childId)?.usageEmitted === true), {
				description: `${options.caseName} usage chunks`,
			})
			for (const childId of childIds) model.releaseCompletion(childId)
		}
		if (processFixture) {
			await waitFor(
				async () => {
					processObservation = await readProcessTreeObservation(processFixture!.statePath)
					return (
						typeof processObservation.commandPid === "number" &&
						typeof processObservation.descendantActualPid === "number" &&
						processObservation.descendantReadyAt !== undefined &&
						isProcessAlive(processObservation.commandPid) &&
						isProcessAlive(processObservation.descendantActualPid)
					)
				},
				{ description: `${options.caseName} Worker process fixture` },
			)
		}
		await waitFor(
			() =>
				childIds.every((childId) => {
					const state = agentControlStateSchema.parse(provider.agentControlStore.getSnapshot())
					return state.agents.find((agent) => agent.taskId === childId)?.status === options.expectedStatus
				}),
			{ timeout: 60_000, description: `${options.caseName} child budget stop` },
		)
		for (const childTask of childTasks) await childTask.waitForTermination()
		if (processFixture) {
			await waitFor(
				async () => {
					processObservation = await readProcessTreeObservation(processFixture!.statePath)
					return (
						!isProcessAlive(processObservation.commandPid) &&
						!isProcessAlive(processObservation.descendantActualPid)
					)
				},
				{ description: `${options.caseName} Worker process cleanup` },
			)
		}

		const state = agentControlStateSchema.parse(provider.agentControlStore.getSnapshot())
		const records = childIds.map((childId) => {
			const record = state.agents.find((agent) => agent.taskId === childId)
			assert.ok(record)
			assert.equal(record.status, options.expectedStatus)
			assert.equal(record.terminalResult?.stopReason, options.expectedStopReason)
			assert.equal(record.terminalResult?.status, options.expectedStatus)
			assert.equal(model.observations.get(childId)?.signalProvided, true)
			assert.equal(model.observations.get(childId)?.usageEmitted, options.mode !== "hold")
			const usage = record.terminalResult?.usage
			assert.ok(usage)
			assert.equal(usage.cost ?? 0, 0)
			assert.equal(Number.isFinite(usage.durationMs), true)
			if (options.mode !== "hold") {
				assert.equal(usage.inputTokens, 2)
				assert.equal(usage.outputTokens, 8)
			}
			return record
		})
		for (const childId of childIds) {
			const resultEvents = state.mailbox.filter(
				(event) => event.kind === "result" && event.senderTaskId === childId,
			)
			assert.equal(resultEvents.length, 1, `${options.caseName} child must publish one terminal result`)
			const childHistory = await provider.getTaskWithId(childId)
			const lifecycle = inspectTaskLifecycle(
				await readJsonLines(path.join(childHistory.taskDirPath, "agent_lifecycle_events.jsonl")),
				childId,
			)
			assert.deepEqual(lifecycle.errors, [])
			assert.equal(lifecycle.cancelledTurns, 1)
			assert.equal(lifecycle.completedTurns, 0)
		}

		// The root is cancelled only after the child result is durable. This also
		// verifies that a budget stop releases the root's child capacity.
		const rootBeforeCancel = rootTask
		if (!rootBeforeCancel.getTaskLifetimeCancellationSignal().aborted) await api.cancelCurrentTask()
		await rootBeforeCancel.waitForTermination()
		const projection = managedAgentTreeProjectionSchema.parse(
			(await provider.getStateToPostToWebview()).managedAgentTree,
		)
		assert.equal(projection.capacity.active, 0)
		assert.equal(projection.capacity.queued, 0)
		assert.equal(projection.capacity.terminal, childCount)

		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifacts)
		await fs.writeFile(
			path.join(artifacts, `managed-agent-budget-${options.caseName}.json`),
			JSON.stringify(
				{
					schemaVersion: 1,
					scenarioId: `managed-agent-budget-${options.caseName}`,
					hostVersion: vscode.version,
					mode: options.mode,
					status: options.expectedStatus,
					stopReason: options.expectedStopReason,
					usageSource: "scripted-local-fixture",
					billingEvidence: "none",
					actualCostClaim: false,
					children: records.map((record) => ({
						taskId: record.taskId,
						status: record.status,
						stopReason: record.terminalResult?.stopReason,
						usage: record.terminalResult?.usage,
						terminalResultCount: state.mailbox.filter(
							(event) => event.kind === "result" && event.senderTaskId === record.taskId,
						).length,
					})),
					processTreeDead: processFixture
						? !isProcessAlive(processObservation.commandPid) &&
							!isProcessAlive(processObservation.descendantActualPid)
						: undefined,
					capacity: projection.capacity,
				},
				null,
				2,
			),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		)
	} finally {
		if (rootTask) {
			const root = rootTask
			if (!root.getTaskLifetimeCancellationSignal().aborted) await api.cancelCurrentTask().catch(() => undefined)
			await root.waitForTermination().catch(() => undefined)
		}
		if (processFixture) await terminateProcessTree(processObservation)
		model.dispose()
		await api.clearCurrentTask().catch(() => undefined)
		await api.setConfiguration(previousConfiguration).catch(() => undefined)
		if (previousProcessStatePath === undefined) delete process.env[CANCELLATION_PROCESS_STATE_ENV]
		else process.env[CANCELLATION_PROCESS_STATE_ENV] = previousProcessStatePath
	}
}

suite("Managed-agent budget Extension Host acceptance", function () {
	this.timeout(180_000)

	test("stops role timeout, child output exhaustion, and root token exhaustion", async function () {
		if (process.env.ALPHA_E2E_BUDGET_RUN !== "1") {
			this.skip()
			return
		}
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		await runBudgetCase({
			caseName: "role-timeout",
			mode: "process",
			roleTimeoutMs: 10_000,
			maxOutputTokens: 64,
			rootTokenBudget: null,
			expectedStatus: "timed_out",
			expectedStopReason: "timeout",
			agentKind: "worker",
		})
		await runBudgetCase({
			caseName: "child-output",
			mode: "output",
			roleTimeoutMs: 60_000,
			maxOutputTokens: 1,
			rootTokenBudget: null,
			expectedStatus: "cancelled",
			expectedStopReason: "output_token_limit",
		})
		await runBudgetCase({
			caseName: "root-token",
			mode: "root",
			roleTimeoutMs: 60_000,
			maxOutputTokens: 64,
			rootTokenBudget: 15,
			expectedStatus: "cancelled",
			expectedStopReason: "root_token_budget",
			childCount: 2,
		})
	})
})
