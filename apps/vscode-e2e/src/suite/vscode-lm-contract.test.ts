import * as assert from "assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	type AgentLifecycleSnapshot,
	type AlphaCodeSettings,
	type TaskReasoningPreference,
	type TaskReasoningProjection,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor } from "./utils"

type FixtureScenario =
	| "tool-followup"
	| "tool-followup-tail"
	| "cancellation"
	| "error-recovery"
	| "no-choices-recovery"
	| "completion"

interface FixturePart {
	kind: "tool_call" | "tool_result" | "text" | "unknown"
	callId?: string
	name?: string
	value?: string
	content?: FixturePart[]
}

interface FixtureRequest {
	index: number
	scenario: FixtureScenario
	cancelled: boolean
	modelId: string
	configuration?: { reasoningEffort?: string }
	messages: Array<{ role: vscode.LanguageModelChatMessageRole; parts: FixturePart[] }>
	tools: string[]
}

interface VsCodeLmFixtureControl {
	reset(
		scenario: FixtureScenario,
		options?: { holdRequestIndexes?: number[]; holdAfterToolCallRequestIndexes?: number[] },
	): void
	getRequests(): FixtureRequest[]
	getEvents(): Array<{
		type: string
		requestIndex: number
		elapsedMs: number
		cancellationRequested?: boolean
	}>
	releaseRequest(requestIndex: number): void
	releaseToolCallTail(requestIndex: number): void
	releaseAll(): void
}

interface ContractTask {
	apiConfiguration: AlphaCodeSettings
	getReasoningState(): TaskReasoningProjection
	abort?: boolean
	didComplete?: boolean
	isInitialized?: boolean
	isStreaming?: boolean
	isTaskLoopActive?: boolean
	isWaitingForFirstChunk?: boolean
	taskAsk?: { ask?: string }
	clineMessages?: Array<{ ask?: string; say?: string; text?: string; partial?: boolean }>
	approveAsk(): void
	resumeCompletedTaskFollowup(text: string, images?: string[]): Promise<void>
}

interface ContractHostProvider {
	setTaskReasoningPreference(
		taskId: string | undefined,
		preference: TaskReasoningPreference,
	): Promise<TaskReasoningProjection>
	getTaskWithId(taskId: string): Promise<{ historyItem: { reasoningPreference?: TaskReasoningPreference } }>
	getAgentLifecycleSnapshot(taskId: string | undefined): AgentLifecycleSnapshot | undefined
	showTaskWithId(taskId: string): Promise<void>
	getLiveTask(taskId: string): ContractTask | undefined
	getStateToPostToWebview(): Promise<{ currentTaskId?: string; mode?: string }>
}

const FIXTURE_VENDOR = "alpha-e2e"
const FIXTURE_MODEL_ID = "alpha-e2e-model"
const READ_PROOF_FILE = "alpha-e2e-stream-read-proof.txt"
const READ_PROOF = "ALPHA_E2E_EARLY_READ_PROOF"
const READ_COMMAND = `rg --no-config -n ${READ_PROOF} ${READ_PROOF_FILE}`
const COMPLETION_ASKS = new Set(["completion_result", "resume_completed_task"])

const getHostProvider = (): ContractHostProvider => {
	const provider = (globalThis.api as unknown as { sidebarProvider?: ContractHostProvider }).sidebarProvider
	assert.ok(provider, "The extension API did not expose its host provider to the extension-host test")
	return provider
}

const getFixture = async (): Promise<VsCodeLmFixtureControl> => {
	const fixtureExtensionId = process.env.ALPHA_E2E_VSCODE_LM_FIXTURE_ID
	assert.ok(fixtureExtensionId, "ALPHA_E2E_VSCODE_LM_FIXTURE_ID was not provided by the E2E runner")
	const extension = vscode.extensions.getExtension<VsCodeLmFixtureControl>(fixtureExtensionId)
	assert.ok(extension, `VS Code LM fixture extension ${fixtureExtensionId} was not loaded`)
	return extension.isActive ? extension.exports : extension.activate()
}

const createConfiguration = (): AlphaCodeSettings => ({
	...globalThis.api.getConfiguration(),
	apiProvider: "vscode-lm",
	vsCodeLmModelSelector: {
		vendor: FIXTURE_VENDOR,
		family: FIXTURE_VENDOR,
		id: FIXTURE_MODEL_ID,
		version: "1.0.0",
	},
	vsCodeLmContextSize: 128_000,
	mode: "code",
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: true,
	requestDelaySeconds: 0,
	writeDelayMs: 0,
	enableCheckpoints: false,
})

const createCommandReadConfiguration = (): AlphaCodeSettings => ({
	...createConfiguration(),
	alwaysAllowExecute: true,
	allowedCommands: [READ_COMMAND],
})

const createReadProofFile = async (): Promise<() => Promise<void>> => {
	const workspace = vscode.workspace.workspaceFolders?.[0]
	assert.ok(workspace, "The VS Code LM contract test has no workspace folder")
	const filePath = path.join(workspace.uri.fsPath, READ_PROOF_FILE)
	await fs.writeFile(filePath, `${READ_PROOF}\n`, { encoding: "utf8", flag: "wx" })
	return async () => fs.rm(filePath, { force: true })
}

const getToolResultText = (request: FixtureRequest, callId: string): string => {
	const result = request.messages
		.flatMap((message) => message.parts)
		.find((part) => part.kind === "tool_result" && part.callId === callId)
	return result?.content?.map((part) => part.value ?? "").join("\n") ?? ""
}

const getTaskDiagnostics = async (provider: ContractHostProvider, fixture: VsCodeLmFixtureControl, taskId: string) => {
	const task = provider.getLiveTask(taskId)
	const state = await provider.getStateToPostToWebview()
	return {
		taskId,
		currentTaskId: state.currentTaskId,
		mode: state.mode,
		requestCount: fixture.getRequests().length,
		requests: fixture.getRequests().map(({ index, scenario, cancelled, tools, messages }) => ({
			index,
			scenario,
			cancelled,
			tools,
			toolResults: messages.flatMap((message) =>
				message.parts
					.filter((part) => part.kind === "tool_result")
					.map((part) => ({
						callId: part.callId,
						content: part.content
							?.map((item) => item.value ?? "")
							.join("\\n")
							.slice(0, 500),
					})),
			),
		})),
		fixtureEvents: fixture.getEvents(),
		isInitialized: task?.isInitialized,
		isTaskLoopActive: task?.isTaskLoopActive,
		isWaitingForFirstChunk: task?.isWaitingForFirstChunk,
		isStreaming: task?.isStreaming,
		didComplete: task?.didComplete,
		abort: task?.abort,
		taskAsk: task?.taskAsk?.ask,
		transcriptTail: task?.clineMessages?.slice(-6).map(({ ask, say, text, partial }) => ({
			message: ask ?? say,
			partial,
			text: text?.slice(0, 500),
		})),
	}
}

const waitForRequestCount = async (
	provider: ContractHostProvider,
	fixture: VsCodeLmFixtureControl,
	taskId: string,
	count: number,
) =>
	waitFor(() => fixture.getRequests().length >= count, {
		timeout: 30_000,
		interval: 25,
		description: `VS Code LM fixture request ${count}`,
		onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
	})

const acceptCompletionBoundary = async (
	provider: ContractHostProvider,
	fixture: VsCodeLmFixtureControl,
	taskId: string,
	completedCount: () => number,
	expectedCompletedCount: number,
) => {
	await waitFor(
		() =>
			completedCount() >= expectedCompletedCount ||
			COMPLETION_ASKS.has(provider.getLiveTask(taskId)?.taskAsk?.ask ?? ""),
		{
			timeout: 30_000,
			interval: 25,
			description: `task ${taskId} completion boundary ${expectedCompletedCount}`,
			onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
		},
	)
	if (completedCount() < expectedCompletedCount) {
		const task = provider.getLiveTask(taskId)
		assert.ok(task, `Task ${taskId} disappeared before completion could be accepted`)
		task.approveAsk()
	}
	await waitFor(() => completedCount() >= expectedCompletedCount, {
		timeout: 30_000,
		interval: 25,
		description: `task ${taskId} to publish completion ${expectedCompletedCount}`,
		onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
	})
}

suite("Alpha VS Code LM 1.125.0 contract", function () {
	setDefaultSuiteTimeout(this)

	let fixture: VsCodeLmFixtureControl

	suiteSetup(async () => {
		assert.equal(vscode.version, "1.125.0", "The VS Code LM contract must run on the exact supported host")
		fixture = await getFixture()
	})

	teardown(async () => {
		fixture.releaseAll()
		await globalThis.api.clearCurrentTask().catch(() => undefined)
	})

	test("persists independent reasoning and omits unverified LM effort without changing model or profile", async () => {
		const provider = getHostProvider()
		fixture.reset("completion", { holdRequestIndexes: [0] })
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
		try {
			const taskId = await globalThis.api.startNewTask({
				configuration: createConfiguration(),
				text: "Complete this reasoning contract fixture.",
			})
			await waitForRequestCount(provider, fixture, taskId, 1)
			const task = provider.getLiveTask(taskId)!
			const profile = structuredClone(task.apiConfiguration)
			const requested = { kind: "effort", effort: "high" } as const
			const state = await provider.setTaskReasoningPreference(taskId, requested)
			assert.deepStrictEqual(state.requested, requested)
			assert.equal(state.capabilities.kind, "unavailable")
			assert.notDeepStrictEqual(state.effective, requested)
			assert.deepStrictEqual(task.apiConfiguration, profile)
			assert.equal(fixture.getRequests().length, 1, "Selecting reasoning must not restart the request")
			assert.equal(fixture.getRequests()[0]!.modelId, FIXTURE_MODEL_ID)
			assert.equal(fixture.getRequests()[0]!.configuration?.reasoningEffort, undefined)
			fixture.releaseAll()
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)
			assert.deepStrictEqual((await provider.getTaskWithId(taskId)).historyItem.reasoningPreference, requested)
			await globalThis.api.clearCurrentTask()
			await provider.showTaskWithId(taskId)
			assert.deepStrictEqual(provider.getLiveTask(taskId)?.getReasoningState().requested, requested)
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
			await provider.setTaskReasoningPreference(undefined, { kind: "default" })
		}
	})

	test("characterizes VS Code 1.125.0 late cancellation at the direct LM boundary", async () => {
		fixture.reset("cancellation")
		const [model] = await vscode.lm.selectChatModels({
			vendor: FIXTURE_VENDOR,
			family: FIXTURE_VENDOR,
			id: FIXTURE_MODEL_ID,
			version: "1.0.0",
		})
		assert.ok(model, "The direct VS Code LM fixture model was not selectable")
		const cancellation = new vscode.CancellationTokenSource()
		let responseIterator: AsyncIterator<unknown> | undefined

		try {
			const response = await model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Characterize late cancellation on VS Code 1.125.0.")],
				{ justification: "Alpha exact-host cancellation contract test" },
				cancellation.token,
			)
			responseIterator = response.stream[Symbol.asyncIterator]()
			const pendingRead = responseIterator.next().catch((error) => error)
			await waitFor(() => fixture.getRequests().length === 1, {
				timeout: 10_000,
				interval: 25,
				description: "the direct VS Code LM fixture request",
				onTimeout: () => ({ events: fixture.getEvents() }),
			})

			cancellation.cancel()
			await sleep(250)
			assert.equal(
				fixture.getRequests()[0]?.cancelled,
				false,
				"VS Code 1.125.0 unexpectedly forwarded cancellation after sendRequest returned; update this exact-host characterization",
			)
			assert.equal(
				fixture.getEvents().some(({ type }) => type === "provider-token-cancelled"),
				false,
				"The direct fixture provider observed a late cancellation token on VS Code 1.125.0",
			)

			fixture.releaseRequest(0)
			await waitFor(() => fixture.getEvents().some(({ type }) => type === "provider-request-returned"), {
				timeout: 10_000,
				interval: 25,
				description: "the direct fixture request to return after release",
				onTimeout: () => ({ events: fixture.getEvents() }),
			})
			await pendingRead
		} finally {
			fixture.releaseAll()
			await responseIterator?.return?.()
			cancellation.dispose()
		}
	})

	test("recovers no-choices without Continue while tool auto-approval is disabled", async () => {
		const provider = getHostProvider()
		fixture.reset("no-choices-recovery")
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
		try {
			const taskId = await globalThis.api.startNewTask({
				configuration: { ...createConfiguration(), autoApprovalEnabled: false },
				text: "Recover this empty response and finish the same task.",
			})
			await waitForRequestCount(provider, fixture, taskId, 2)
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)
			assert.equal(fixture.getRequests().length, 2)
			assert.ok(!provider.getLiveTask(taskId)?.clineMessages?.some(({ ask }) => ask === "api_req_failed"))
			assert.deepStrictEqual(fixture.getRequests()[1]!.messages, fixture.getRequests()[0]!.messages)
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
		}
	})

	test("carries tool call and result through VS Code LM, then resumes a completed task with the follow-up", async () => {
		const provider = getHostProvider()
		const cleanupReadProof = await createReadProofFile()
		fixture.reset("tool-followup", { holdRequestIndexes: [1] })
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onTaskCompleted)

		try {
			const taskId = await globalThis.api.startNewTask({
				configuration: createCommandReadConfiguration(),
				text: "Search this workspace for the read proof, complete, then accept a same-task follow-up.",
			})
			const initialTask = provider.getLiveTask(taskId)
			assert.ok(initialTask, "The VS Code LM task was not registered with the extension host")

			await waitForRequestCount(provider, fixture, taskId, 1)
			await waitForRequestCount(provider, fixture, taskId, 2)
			const [firstRequest, secondRequest] = fixture.getRequests()
			assert.ok(firstRequest, "The initial VS Code LM request was not recorded")
			assert.ok(secondRequest, "The tool-result VS Code LM request was not recorded")
			assert.ok(
				firstRequest.tools.includes("exec_command"),
				"Alpha did not offer exec_command through VS Code LM",
			)
			assert.ok(
				!firstRequest.tools.includes("attempt_completion"),
				"Alpha exposed the retired attempt_completion tool through VS Code LM",
			)

			const callMessageIndex = secondRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_call" && part.callId === "alpha-e2e-command-read-1"),
			)
			const resultMessageIndex = secondRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_result" && part.callId === "alpha-e2e-command-read-1"),
			)
			assert.ok(callMessageIndex >= 0, "The second VS Code LM request omitted the assistant exec_command call")
			assert.ok(resultMessageIndex > callMessageIndex, "The tool result did not follow its tool call")
			assert.equal(secondRequest.messages[callMessageIndex]!.role, vscode.LanguageModelChatMessageRole.Assistant)
			assert.equal(secondRequest.messages[resultMessageIndex]!.role, vscode.LanguageModelChatMessageRole.User)
			assert.ok(
				getToolResultText(secondRequest, "alpha-e2e-command-read-1").includes(READ_PROOF),
				`The VS Code LM tool result omitted content read from the workspace fixture: ${JSON.stringify(
					getToolResultText(secondRequest, "alpha-e2e-command-read-1"),
				)}`,
			)

			await sleep(150)
			assert.equal(fixture.getRequests().length, 2, "A held response unexpectedly triggered another API request")
			fixture.releaseRequest(1)
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)
			assert.ok(
				initialTask.clineMessages?.some(
					(message) =>
						(message.say === "text" || message.say === "completion_result") &&
						!message.partial &&
						message.text === "The VS Code LM contract turn completed.",
				),
				"Ordinary assistant text was not retained as the completed VS Code LM answer",
			)

			await initialTask.resumeCompletedTaskFollowup("Evaluate the completed answer and keep this exact task ID.")
			await waitForRequestCount(provider, fixture, taskId, 3)
			assert.deepStrictEqual(globalThis.api.getCurrentTaskStack(), [taskId])
			assert.strictEqual(
				provider.getLiveTask(taskId),
				initialTask,
				"The completed follow-up replaced the live task instead of resuming it",
			)
			const followupRequest = fixture.getRequests()[2]
			assert.ok(followupRequest, "The same-task follow-up VS Code LM request was not recorded")
			assert.ok(
				followupRequest.messages.some((message) =>
					message.parts.some(
						(part) =>
							part.kind === "text" &&
							part.value?.includes("Evaluate the completed answer and keep this exact task ID."),
					),
				),
				"The same-task follow-up text never crossed the VS Code LM boundary",
			)
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 2)
			assert.ok(
				initialTask.clineMessages?.some(
					(message) =>
						(message.say === "text" || message.say === "completion_result") &&
						!message.partial &&
						message.text === "The same-task follow-up completed through VS Code LM.",
				),
				"Ordinary assistant text from the same-task follow-up was not retained",
			)
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
			await cleanupReadProof()
		}
	})

	test("starts an audited exec_command read while the VS Code LM response tail is held", async () => {
		const provider = getHostProvider()
		const callId = "alpha-e2e-command-read-1"
		const cleanupReadProof = await createReadProofFile()
		fixture.reset("tool-followup-tail", { holdAfterToolCallRequestIndexes: [0] })
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onTaskCompleted)

		try {
			const taskStartedAt = Date.now()
			const taskId = await globalThis.api.startNewTask({
				configuration: createCommandReadConfiguration(),
				text: "Search this workspace for the read proof and report what you found.",
			})
			await waitForRequestCount(provider, fixture, taskId, 1)
			await waitFor(() => fixture.getEvents().some((event) => event.type === "provider-tool-call-reported"), {
				timeout: 10_000,
				interval: 25,
				description: "the fixture to report its complete exec_command item",
				onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
			})
			const toolCallReportedAt = fixture
				.getEvents()
				.find((event) => event.requestIndex === 0 && event.type === "provider-tool-call-reported")?.elapsedMs
			assert.ok(toolCallReportedAt !== undefined, "The fixture did not timestamp its completed exec_command item")
			await waitFor(
				() => provider.getAgentLifecycleSnapshot(taskId)?.effectStartedToolCallIds.includes(callId) ?? false,
				{
					timeout: 10_000,
					interval: 25,
					description: "the isolated exec_command effect to start before provider completion",
					onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
				},
			)
			const effectObservedAtMs = Date.now() - taskStartedAt
			await waitFor(
				() =>
					provider
						.getLiveTask(taskId)
						?.clineMessages?.some(
							({ say, text }) => say === "command_output" && text?.includes(READ_PROOF) === true,
						) ?? false,
				{
					timeout: 10_000,
					interval: 25,
					description: "the isolated rg read to return the workspace proof before provider completion",
					onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
				},
			)

			const heldEvents = fixture.getEvents()
			assert.ok(
				!heldEvents.some(
					(event) =>
						event.requestIndex === 0 &&
						(event.type === "provider-tail-released" || event.type === "provider-request-returned"),
				),
				"The provider response tail returned before the read effect began",
			)
			console.info(
				JSON.stringify({
					metric: "held-tail audited exec_command read",
					providerToolCallReportedAtMs: toolCallReportedAt,
					effectObservedAtMs,
					observedOverlapAfterToolCallMs: Math.max(0, effectObservedAtMs - toolCallReportedAt),
					tailReleasedBeforeEffect: false,
				}),
			)
			assert.deepStrictEqual(
				provider.getAgentLifecycleSnapshot(taskId)?.effectStartedToolCallIds.filter((id) => id === callId),
				[callId],
				"The read effect should start once while the tail remains held",
			)
			assert.equal(
				fixture.getRequests().length,
				1,
				"A tool-result request must wait for the assistant response boundary",
			)

			fixture.releaseToolCallTail(0)
			await waitForRequestCount(provider, fixture, taskId, 2)
			const toolResultRequest = fixture.getRequests()[1]
			assert.ok(toolResultRequest, "The follow-up request containing the read result was not recorded")
			const callMessageIndex = toolResultRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_call" && part.callId === callId),
			)
			const resultMessageIndex = toolResultRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_result" && part.callId === callId),
			)
			assert.ok(callMessageIndex >= 0, "The assistant tool call was not persisted before the result")
			assert.ok(resultMessageIndex > callMessageIndex, "The tool result did not follow its assistant tool call")
			assert.equal(
				toolResultRequest.messages[callMessageIndex]!.role,
				vscode.LanguageModelChatMessageRole.Assistant,
			)
			assert.equal(toolResultRequest.messages[resultMessageIndex]!.role, vscode.LanguageModelChatMessageRole.User)
			const resultPart = toolResultRequest.messages[resultMessageIndex]!.parts.find(
				(part) => part.kind === "tool_result" && part.callId === callId,
			)
			assert.ok(resultPart?.content?.some((part) => part.kind === "text" && Boolean(part.value)))
			assert.ok(
				getToolResultText(toolResultRequest, callId).includes(READ_PROOF),
				"The persisted exec_command result omitted content read from the workspace fixture",
			)

			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)
			const settled = provider.getAgentLifecycleSnapshot(taskId)
			assert.deepStrictEqual(
				settled?.effectStartedToolCallIds.filter((id) => id === callId),
				[callId],
			)
			assert.deepStrictEqual(
				settled?.terminalToolCallIds.filter((id) => id === callId),
				[callId],
			)
		} finally {
			fixture.releaseToolCallTail(0)
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
			await cleanupReadProof()
		}
	})

	test("settles Alpha cancellation across VS Code 1.125.0's late-token boundary and starts a healthy recovery task", async () => {
		const provider = getHostProvider()
		fixture.reset("cancellation")

		try {
			const cancelledTaskId = await globalThis.api.startNewTask({
				configuration: createConfiguration(),
				text: "Hold this VS Code LM response until cancellation.",
			})
			await waitForRequestCount(provider, fixture, cancelledTaskId, 1)
			let cancelSettled = false
			const cancelPromise = globalThis.api.cancelCurrentTask().finally(() => {
				cancelSettled = true
			})
			await waitFor(() => cancelSettled, {
				timeout: 10_000,
				interval: 25,
				description: "cancelCurrentTask to settle",
				onTimeout: () => getTaskDiagnostics(provider, fixture, cancelledTaskId),
			})
			await cancelPromise
			assert.equal(
				fixture.getRequests()[0]?.cancelled,
				false,
				"VS Code 1.125.0 should retain the provider token after its startup RPC returns",
			)
			await waitFor(() => provider.getLiveTask(cancelledTaskId)?.taskAsk?.ask === "resume_task", {
				timeout: 10_000,
				interval: 25,
				description: "the cancelled task to expose its resumable boundary",
				onTimeout: () => getTaskDiagnostics(provider, fixture, cancelledTaskId),
			})
			fixture.releaseRequest(0)
			await waitFor(() => fixture.getEvents().some(({ type }) => type === "provider-request-returned"), {
				timeout: 10_000,
				interval: 25,
				description: "the cancelled task fixture request to return after release",
				onTimeout: () => getTaskDiagnostics(provider, fixture, cancelledTaskId),
			})
			await globalThis.api.clearCurrentTask().catch(() => undefined)

			fixture.reset("completion")
			let recoveryCompleted = 0
			const onRecoveryCompleted = () => recoveryCompleted++
			globalThis.api.on(AlphaCodeEventName.TaskCompleted, onRecoveryCompleted)
			try {
				const recoveryTaskId = await globalThis.api.startNewTask({
					configuration: createConfiguration(),
					text: "Complete after the cancelled VS Code LM request.",
				})
				await waitForRequestCount(provider, fixture, recoveryTaskId, 1)
				await acceptCompletionBoundary(provider, fixture, recoveryTaskId, () => recoveryCompleted, 1)
				assert.notEqual(recoveryTaskId, cancelledTaskId)
			} finally {
				globalThis.api.off(AlphaCodeEventName.TaskCompleted, onRecoveryCompleted)
			}
		} finally {
			fixture.releaseAll()
		}
	})

	test("recovers from a VS Code LM provider error without losing the task", async () => {
		const provider = getHostProvider()
		fixture.reset("error-recovery")
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onTaskCompleted)

		try {
			const taskId = await globalThis.api.startNewTask({
				configuration: createConfiguration(),
				text: "Retry this deterministic VS Code LM provider failure.",
			})
			const initialTask = provider.getLiveTask(taskId)
			await waitForRequestCount(provider, fixture, taskId, 1)
			await waitFor(
				() =>
					provider.getLiveTask(taskId)?.clineMessages?.some(({ say }) => say === "api_req_retry_delayed") ===
					true,
				{
					timeout: 30_000,
					interval: 25,
					description: "the automatic provider-error retry boundary",
					onTimeout: () => getTaskDiagnostics(provider, fixture, taskId),
				},
			)
			await waitForRequestCount(provider, fixture, taskId, 2)
			assert.strictEqual(provider.getLiveTask(taskId), initialTask)
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, onTaskCompleted)
		}
	})
})
