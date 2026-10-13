import type { Anthropic } from "@anthropic-ai/sdk"

import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { Task } from "../Task"

vi.mock("../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))

type Content = Anthropic.Messages.ContentBlockParam[]
const stopBeforeProvider = new Error("fixture: committed resumed input reached the provider boundary")

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

function savedToolHistory(missingResult: boolean): ApiMessage[] {
	return [
		{ role: "user", content: "Inspect safely in this chat", input_origin: "human", ts: 1 },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "read-one", name: "read_file", input: { path: "one.ts" } },
				...(missingResult
					? [{ type: "tool_use" as const, id: "read-two", name: "read_file", input: { path: "two.ts" } }]
					: []),
			],
			encrypted_content: "opaque-provider-state",
			ts: 2,
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-one", content: "COMMITTED_RESULT", is_error: false }],
			input_origin: "agent",
			ts: 3,
		},
	]
}

/** Real resume/steer/request persistence, with JSON standing in for the atomic transcript file. */
function harness(saved: ApiMessage[], retained: boolean) {
	let durableBytes = JSON.stringify(saved)
	const commits: ApiMessage[][] = []
	let historyAtProviderBoundary: ApiMessage[] | undefined
	const save = vi.fn(async () => {
		durableBytes = JSON.stringify(task.apiConversationHistory)
		commits.push(JSON.parse(durableBytes) as ApiMessage[])
		return true
	})
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "resume-steering-commit",
		instanceId: "resume-steering-commit-instance",
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
		saveApiConversationHistory: save,
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
			if (type === "api_req_started") {
				historyAtProviderBoundary = structuredClone(task.apiConversationHistory)
				throw stopBeforeProvider
			}
		}),
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
	return {
		task,
		save,
		commits,
		readDurable: () => JSON.parse(durableBytes) as ApiMessage[],
		readProviderBoundary: () => historyAtProviderBoundary,
	}
}

afterEach(() => vi.restoreAllMocks())

describe("resumed history remains committed when steering interrupts input preparation", () => {
	it.each([
		{ retained: false, missingResult: false },
		{ retained: true, missingResult: false },
		{ retained: false, missingResult: true },
		{ retained: true, missingResult: true },
	])("preserves the saved input (retained=$retained, repair=$missingResult)", async ({ retained, missingResult }) => {
		const saved = savedToolHistory(missingResult)
		const { task, save, commits, readDurable, readProviderBoundary } = harness(saved, retained)
		const enteredCapture = deferred()
		const releaseCapture = deferred()
		vi.mocked(captureEnvironmentDetails).mockImplementationOnce(async () => {
			enteredCapture.resolve()
			await releaseCapture.promise
			return { details: "", commit: vi.fn(), release: vi.fn() }
		})
		const resume = task["resumeTaskFromHistory"]("Continue the saved task", undefined, undefined, {
			reuseRetainedHistory: retained,
		})
		const outcome = expect(resume).rejects.toBe(stopBeforeProvider)
		await enteredCapture.promise
		expect(save).not.toHaveBeenCalled()
		expect(task.canAcceptSteerMessage()).toBe(true)
		await task.steerUserMessage("Also inspect the new guidance")
		releaseCapture.resolve()
		await outcome

		const committed = readDurable()
		expect(commits).toHaveLength(1)
		expect(committed).toHaveLength(5)
		expect(commits[0]).toEqual(committed)
		expect(readProviderBoundary()).toEqual(committed)
		expect(committed.slice(0, 2)).toEqual(saved.slice(0, 2))
		expect(committed[2]).toMatchObject({
			...saved[2],
			content: expect.arrayContaining(saved[2].content as Content),
		})
		expect(committed.slice(3).map(({ role, input_origin, content }) => ({ role, input_origin, content }))).toEqual([
			{
				role: "user",
				input_origin: "human",
				content: [{ type: "text", text: "<user_message>\nContinue the saved task\n</user_message>" }],
			},
			{
				role: "user",
				input_origin: "human",
				content: [{ type: "text", text: "<user_message>\nAlso inspect the new guidance\n</user_message>" }],
			},
		])
		if (missingResult) {
			expect(committed[2].content).toContainEqual(
				expect.objectContaining({ type: "tool_result", tool_use_id: "read-two", is_error: true }),
			)
		}

		// The repair and ordered input records were already saved together before resume unwound.
		expect.soft(task.apiConversationHistory).toEqual(committed)
		await task["saveApiConversationHistory"]()
		expect.soft(readDurable()).toEqual(committed)
	})
})
