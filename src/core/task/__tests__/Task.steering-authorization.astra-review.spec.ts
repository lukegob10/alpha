import type { Anthropic } from "@anthropic-ai/sdk"

import type { CompletionHookPromptProvenance } from "../../agent/CompletionHooks"
import { isExplicitIndependentTaskRequest } from "../../agent/independentTaskAuthorization"
import { extractUserRequestText } from "../../agent/requestWorkClass"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { CreateTaskTool } from "../../tools/CrossTaskOrchestrationTools"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: () => undefined },
}))

type Content = Anthropic.Messages.ContentBlockParam[]
const stopBeforeProvider = new Error("fixture: committed input reached provider boundary")
const admitted = new Error("fixture: passed explicit-request admission; no task was created")
const initialRequest = "Inspect safely in this chat"
const createRequest = "Create a new independent task for the parser review."
const revokeRequest = "Do not create a new task. Stay in this chat."
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

/** Real resume/steer/request persistence, without filesystem, network or task creation effects. */
function harness(retained = false) {
	const saved: ApiMessage[] = [{ role: "user", content: initialRequest, input_origin: "human", ts: 1 }]
	let durableBytes = JSON.stringify(saved)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "steering-authorization-review",
		instanceId: "steering-authorization-review-instance",
		taskKind: "primary",
		abort: false,
		abandoned: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		clineMessages: [],
		apiConversationHistory: retained ? structuredClone(saved) : [],
		userMessageContent: [],
		isTaskLoopActive: false,
		requestPacingWaitCount: 0,
		apiConfiguration: { apiProvider: "openai" },
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => undefined },
		environmentContext: { reset: vi.fn() },
		getTaskMode: vi.fn(async () => "code"),
		getSavedAlphaMessages: vi.fn(async () => [{ ts: 1, type: "say", say: "text", text: "Saved task" }]),
		getSavedApiConversationHistory: vi.fn(async () => JSON.parse(durableBytes) as ApiMessage[]),
		saveApiConversationHistory: vi.fn(async () => {
			durableBytes = JSON.stringify(task.apiConversationHistory)
			return true
		}),
		reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
		mergePendingToolResultsIntoUserContent: vi.fn((content: Content) => content),
		getPendingSpawnedSubagentResults: vi.fn(() => []),
		buildUserContentWithPendingSpawnedSubagentResults: vi.fn((content: Content) => ({
			content,
			pendingResults: [],
		})),
		retryPendingAutomaticResultClaimSettlement: vi.fn(async () => undefined),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		markSpawnedSubagentResultsDelivered: vi.fn(async () => undefined),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		ask: vi.fn<Task["ask"]>().mockResolvedValue({ response: "yesButtonClicked" }),
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw stopBeforeProvider
		}),
		recordToolError: vi.fn(),
		retrySaveApiConversationHistory: vi.fn(async () => false),
		initiateTaskLoop: vi.fn(
			async (
				content: Content,
				onPersisted?: () => Promise<void> | void,
				options?: { inputOrigin?: "human" | "agent" },
			) => task.runAgentRequests(content, false, onPersisted, { inputOrigin: options?.inputOrigin }),
		),
	}) as Task
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit: vi.fn(), release: vi.fn() })
	return { task, readDurable: () => JSON.parse(durableBytes) as ApiMessage[] }
}

function pauseAtBoundary(task: Task, boundary: "preparation" | "pacing" = "preparation") {
	const entered = deferred()
	const release = deferred()
	const wait = async () => {
		entered.resolve()
		await release.promise
	}
	if (boundary === "preparation") {
		vi.mocked(captureEnvironmentDetails).mockImplementationOnce(async () => {
			await wait()
			return { details: "", commit: vi.fn(), release: vi.fn() }
		})
	} else {
		vi.mocked(task["maybeWaitForProviderRateLimit"]).mockImplementationOnce(wait)
	}
	return { entered, release }
}

async function assertCreationAuthority(task: Task, expected: boolean) {
	// Execute the real tool and host authorization. A sentinel stops at the first
	// capacity check, after authorization and before allocating any task or worktree.
	const reachedAdmission = vi.fn(() => {
		throw admitted
	})
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		context: {},
		getMcpHub: () => undefined,
		taskHistoryStoreReady: Promise.resolve(),
		taskSessions: { canCreateTask: reachedAdmission },
	}) as AlphaProvider
	const catalog = await buildNativeToolsArrayWithRestrictions({
		provider,
		cwd: "F:/steering-authorization-fixture",
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: task.apiConfiguration,
		taskKind: "primary",
		crossTaskRole: "root",
		userRequestText: task["getUserRequestTextForCatalog"](),
	})
	expect
		.soft(catalog.tools.some((tool) => tool.type === "function" && tool.function.name === "create_task"))
		.toBe(expected)
	Object.assign(task, { providerRef: { deref: () => provider } })
	const results: string[] = []
	const callbacks: ToolCallbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => undefined),
		pushToolResult: (result) => results.push(String(result)),
		setResultMetadata: vi.fn(),
	}
	await new CreateTaskTool().execute({ objective: "Inspect parser", workspace_mode: "shared" }, task, callbacks)
	expect(callbacks.askApproval).toHaveBeenCalledOnce()
	expect.soft(reachedAdmission.mock.calls.length, JSON.stringify(results)).toBe(expected ? 1 : 0)
	expect.soft(JSON.parse(results[0])).toMatchObject({
		status: "error",
		error: expected ? admitted.message : expect.stringContaining("requires an explicit user request"),
	})
}

afterEach(() => vi.restoreAllMocks())

describe("steering keeps human authorization ordered and separate from synthetic content", () => {
	it.each([
		{ request: createRequest, authorized: true },
		{ request: revokeRequest, authorized: false },
	])(
		"control: an unsteered human request has the expected authority ($authorized)",
		async ({ request, authorized }) => {
			const { task, readDurable } = harness()
			await expect(task["resumeTaskFromHistory"](request)).rejects.toBe(stopBeforeProvider)
			expect(extractUserRequestText(readDurable())).toBe(request)
			expect(task["getUserRequestTextForCatalog"]()).toBe(request)
			await assertCreationAuthority(task, authorized)
		},
	)

	it.each([
		{ retained: false, boundary: "preparation" as const },
		{ retained: true, boundary: "preparation" as const },
		{ retained: false, boundary: "pacing" as const },
	])(
		"uses the fresh steering revocation during resume (retained=$retained, $boundary)",
		async ({ retained, boundary }) => {
			const { task, readDurable } = harness(retained)
			const { entered, release } = pauseAtBoundary(task, boundary)
			const running = task["resumeTaskFromHistory"](createRequest, undefined, undefined, {
				reuseRetainedHistory: retained,
			})
			const outcome = expect(running).rejects.toBe(stopBeforeProvider)
			await entered.promise
			await task.steerUserMessageDurably(revokeRequest, [], "human-revocation")
			release.resolve()
			await outcome

			expect(task.apiConversationHistory).toEqual(readDurable())
			expect.soft(extractUserRequestText(readDurable())).toBe(revokeRequest)
			expect.soft(task["getUserRequestTextForCatalog"]()).toBe(revokeRequest)
			expect.soft(isExplicitIndependentTaskRequest(extractUserRequestText(readDurable()))).toBe(false)
			await assertCreationAuthority(task, false)
		},
	)

	it("retains a fresh human grant after earlier human input", async () => {
		const { task, readDurable } = harness()
		const { entered, release } = pauseAtBoundary(task)
		const running = task["resumeTaskFromHistory"](initialRequest)
		const outcome = expect(running).rejects.toBe(stopBeforeProvider)
		await entered.promise
		await task.steerUserMessage(createRequest)
		release.resolve()
		await outcome

		expect.soft(extractUserRequestText(readDurable())).toBe(createRequest)
		await assertCreationAuthority(task, true)
	})

	it.each(["agent", "hook"] as const)("control: unsteered %s guidance cannot grant authority", async (origin) => {
		const { task, readDurable } = harness(true)
		const hookPrompt: CompletionHookPromptProvenance | undefined =
			origin === "hook"
				? { event: "Stop", fragments: [{ hook_run_id: "hook-1", text: createRequest }] }
				: undefined
		await expect(
			task.runAgentRequests([{ type: "text", text: createRequest }], false, undefined, {
				inputOrigin: "agent",
				hookPrompt,
			}),
		).rejects.toBe(stopBeforeProvider)
		expect(extractUserRequestText(readDurable())).toBe(initialRequest)
		await assertCreationAuthority(task, false)
	})

	it.each([
		{ origin: "agent", boundary: "preparation" as const },
		{ origin: "hook", boundary: "preparation" as const },
		{ origin: "agent", boundary: "pacing" as const },
		{ origin: "hook", boundary: "pacing" as const },
	])(
		"image-only human steering does not promote earlier $origin guidance at $boundary",
		async ({ origin, boundary }) => {
			const { task, readDurable } = harness(true)
			const hookPrompt: CompletionHookPromptProvenance | undefined =
				origin === "hook"
					? { event: "Stop", fragments: [{ hook_run_id: "hook-1", text: createRequest }] }
					: undefined
			const { entered, release } = pauseAtBoundary(task, boundary)
			const running = task.runAgentRequests([{ type: "text", text: createRequest }], false, undefined, {
				inputOrigin: "agent",
				hookPrompt,
			})
			const outcome = expect(running).rejects.toBe(stopBeforeProvider)
			await entered.promise
			await task.steerUserMessageDurably("", [image], "human-image")
			release.resolve()
			await outcome

			expect(task.apiConversationHistory).toEqual(readDurable())
			expect.soft(isExplicitIndependentTaskRequest(extractUserRequestText(readDurable()))).toBe(false)
			expect.soft(isExplicitIndependentTaskRequest(task["getUserRequestTextForCatalog"]())).toBe(false)
			await assertCreationAuthority(task, false)
		},
	)
})
