import * as assert from "assert"
import * as vscode from "vscode"

import { RooCodeEventName, type RooCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor } from "./utils"

type FixtureScenario = "tool-followup" | "cancellation" | "error-recovery" | "completion"

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
	messages: Array<{ role: vscode.LanguageModelChatMessageRole; parts: FixturePart[] }>
	tools: string[]
}

interface VsCodeLmFixtureControl {
	reset(scenario: FixtureScenario, options?: { holdRequestIndexes?: number[] }): void
	getRequests(): FixtureRequest[]
	getEvents(): Array<{
		type: string
		requestIndex: number
		elapsedMs: number
		cancellationRequested?: boolean
	}>
	releaseRequest(requestIndex: number): void
	releaseAll(): void
}

interface ContractTask {
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
	getLiveTask(taskId: string): ContractTask | undefined
	getStateToPostToWebview(): Promise<{ currentTaskId?: string; mode?: string }>
}

const FIXTURE_VENDOR = "alpha-e2e"
const FIXTURE_MODEL_ID = "alpha-e2e-model"
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

const createConfiguration = (): RooCodeSettings => ({
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

const getTaskDiagnostics = async (provider: ContractHostProvider, fixture: VsCodeLmFixtureControl, taskId: string) => {
	const task = provider.getLiveTask(taskId)
	const state = await provider.getStateToPostToWebview()
	return {
		taskId,
		currentTaskId: state.currentTaskId,
		mode: state.mode,
		requestCount: fixture.getRequests().length,
		requests: fixture.getRequests().map(({ index, scenario, cancelled }) => ({ index, scenario, cancelled })),
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

suite("Alpha VS Code LM 1.122.1 contract", function () {
	setDefaultSuiteTimeout(this)

	let fixture: VsCodeLmFixtureControl

	suiteSetup(async () => {
		assert.equal(vscode.version, "1.122.1", "The VS Code LM contract must run on the exact supported host")
		fixture = await getFixture()
	})

	teardown(async () => {
		fixture.releaseAll()
		await globalThis.api.clearCurrentTask().catch(() => undefined)
	})

	test("characterizes VS Code 1.122.1 late cancellation at the direct LM boundary", async () => {
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
				[vscode.LanguageModelChatMessage.User("Characterize late cancellation on VS Code 1.122.1.")],
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
				"VS Code 1.122.1 unexpectedly forwarded cancellation after sendRequest returned; update this exact-host characterization",
			)
			assert.equal(
				fixture.getEvents().some(({ type }) => type === "provider-token-cancelled"),
				false,
				"The direct fixture provider observed a late cancellation token on VS Code 1.122.1",
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

	test("carries tool call and result through VS Code LM, then resumes a completed task with the follow-up", async () => {
		const provider = getHostProvider()
		fixture.reset("tool-followup", { holdRequestIndexes: [1] })
		let completedCount = 0
		const onTaskCompleted = () => completedCount++
		globalThis.api.on(RooCodeEventName.TaskCompleted, onTaskCompleted)

		try {
			const taskId = await globalThis.api.startNewTask({
				configuration: createConfiguration(),
				text: "List this workspace, complete, then accept a same-task evaluation follow-up.",
			})
			const initialTask = provider.getLiveTask(taskId)
			assert.ok(initialTask, "The VS Code LM task was not registered with the extension host")

			await waitForRequestCount(provider, fixture, taskId, 1)
			await waitForRequestCount(provider, fixture, taskId, 2)
			const [firstRequest, secondRequest] = fixture.getRequests()
			assert.ok(firstRequest, "The initial VS Code LM request was not recorded")
			assert.ok(secondRequest, "The tool-result VS Code LM request was not recorded")
			assert.ok(firstRequest.tools.includes("list_files"), "Alpha did not offer list_files through VS Code LM")
			assert.ok(
				firstRequest.tools.includes("attempt_completion"),
				"Alpha did not offer attempt_completion through VS Code LM",
			)

			const callMessageIndex = secondRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_call" && part.callId === "alpha-e2e-list-files-1"),
			)
			const resultMessageIndex = secondRequest.messages.findIndex((message) =>
				message.parts.some((part) => part.kind === "tool_result" && part.callId === "alpha-e2e-list-files-1"),
			)
			assert.ok(callMessageIndex >= 0, "The second VS Code LM request omitted the assistant tool call")
			assert.ok(resultMessageIndex > callMessageIndex, "The tool result did not follow its tool call")
			assert.equal(secondRequest.messages[callMessageIndex]!.role, vscode.LanguageModelChatMessageRole.Assistant)
			assert.equal(secondRequest.messages[resultMessageIndex]!.role, vscode.LanguageModelChatMessageRole.User)

			await sleep(150)
			assert.equal(fixture.getRequests().length, 2, "A held response unexpectedly triggered another API request")
			fixture.releaseRequest(1)
			await acceptCompletionBoundary(provider, fixture, taskId, () => completedCount, 1)

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
		} finally {
			globalThis.api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
		}
	})

	test("settles Alpha cancellation across VS Code 1.122.1's late-token boundary and starts a healthy recovery task", async () => {
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
				"VS Code 1.122.1 should retain the provider token after its startup RPC returns",
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
			globalThis.api.on(RooCodeEventName.TaskCompleted, onRecoveryCompleted)
			try {
				const recoveryTaskId = await globalThis.api.startNewTask({
					configuration: createConfiguration(),
					text: "Complete after the cancelled VS Code LM request.",
				})
				await waitForRequestCount(provider, fixture, recoveryTaskId, 1)
				await acceptCompletionBoundary(provider, fixture, recoveryTaskId, () => recoveryCompleted, 1)
				assert.notEqual(recoveryTaskId, cancelledTaskId)
			} finally {
				globalThis.api.off(RooCodeEventName.TaskCompleted, onRecoveryCompleted)
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
		globalThis.api.on(RooCodeEventName.TaskCompleted, onTaskCompleted)

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
			globalThis.api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
		}
	})
})
