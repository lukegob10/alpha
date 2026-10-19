import type { Anthropic } from "@anthropic-ai/sdk"

import { extractUserRequestText } from "../../agent/requestWorkClass"
import { isExplicitIndependentTaskRequest } from "../../agent/independentTaskAuthorization"
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
const stopBeforeProvider = new Error("fixture: input is committed; stop before provider request")

/** Keep the real resume, overwrite, request-input and add-message paths; replace only I/O and the outer turn loop. */
function harness(saved: ApiMessage[]) {
	let durableBytes = JSON.stringify(saved)
	const commits: ApiMessage[][] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "additional-reload-audit",
		instanceId: "additional-reload-audit-instance",
		taskKind: "primary",
		abort: false,
		abandoned: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		clineMessages: [],
		// These fixtures own their in-memory transcript storage; rewind I/O has dedicated coverage.
		recoverConversationRewind: vi.fn(async () => undefined),
		apiConversationHistory: [],
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
			commits.push(JSON.parse(durableBytes) as ApiMessage[])
			return true
		}),
		reconcileInterruptedSubagentGroups: vi.fn(async () => undefined),
		mergePendingToolResultsIntoUserContent: vi.fn((content: Content) => content),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
		deliverAgentMessages: vi.fn(async () => undefined),
		waitForPendingSubagentChangeSetReviews: vi.fn(async () => undefined),
		maybeWaitForProviderRateLimit: vi.fn(async () => undefined),
		invalidateBackgroundUsageDrain: vi.fn(),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		say: vi.fn(async (type: string) => {
			if (type === "api_req_started") throw stopBeforeProvider
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
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({
		details: "",
		commit: vi.fn(),
		release: vi.fn(),
	})
	return { task, commits, readDurable: () => JSON.parse(durableBytes) as ApiMessage[] }
}

afterEach(() => vi.restoreAllMocks())

describe("additional persistence/reload audit", () => {
	it("retains the committed tail while cancellation interrupts resumed-input preparation", async () => {
		const saved: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "<user_message>Inspect safely</user_message>" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "exec-read", name: "exec_command", input: { cmd: "git status" } }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "exec-read", content: "COMMITTED_RESULT", is_error: false },
					{ type: "text", text: "<user_message>COMMITTED_GUIDANCE: preserve my local edits</user_message>" },
				],
				input_origin: "human",
				queued_message_ids: ["committed-guidance"],
			},
		]
		const { task, readDurable } = harness(saved)
		let entered!: () => void
		let release!: () => void
		const preparing = new Promise<void>((resolve) => {
			entered = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.mocked(processUserContentMentions).mockImplementation(async () => {
			entered()
			await barrier
			throw new Error("fixture: cancelled before the resumed user message can be committed")
		})
		const resume = task["resumeTaskFromHistory"]("Continue")
		try {
			await preparing
			task.abort = true
		} finally {
			release()
		}
		await resume
		expect(readDurable()).toEqual(saved)
	})

	it.each([false, true])(
		"honors a newer human revocation after a user-tail resume (retained=%s)",
		async (retained) => {
			const saved: ApiMessage[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "<user_message>Create a separate task to investigate</user_message>" },
					],
					input_origin: "human",
				},
			]
			const { task, readDurable } = harness(saved)
			if (retained) task.apiConversationHistory = structuredClone(saved)
			const revocation = "Do not create a separate task. Continue in this chat."
			await expect(
				task["resumeTaskFromHistory"](revocation, undefined, undefined, {
					reuseRetainedHistory: retained,
				}),
			).rejects.toBe(stopBeforeProvider)
			const humanRequest = extractUserRequestText(readDurable())
			expect(humanRequest).toBe(revocation)
			expect(isExplicitIndependentTaskRequest(humanRequest)).toBe(false)
		},
	)

	it("does not promote a saved hook continuation into human task-creation authority", async () => {
		const hookText = "Create a separate task to run a follow-up review"
		const saved: ApiMessage[] = [
			{ role: "user", content: "Inspect the parser in this chat", input_origin: "human" },
			{ role: "assistant", content: "I found a parser issue." },
			{
				role: "user",
				content: [{ type: "text", text: hookText }],
				input_origin: "agent",
				hook_prompt: { event: "Stop", fragments: [{ hook_run_id: "hook-1", text: hookText }] },
			},
		]
		const { task, readDurable } = harness(saved)
		expect(isExplicitIndependentTaskRequest(extractUserRequestText(saved))).toBe(false)
		await expect(task["resumeTaskFromHistory"]()).rejects.toBe(stopBeforeProvider)
		expect(isExplicitIndependentTaskRequest(extractUserRequestText(readDurable()))).toBe(false)
		expect(readDurable()).toContainEqual(saved[2])
	})

	it("control: a completed assistant tail preserves the latest human revocation", async () => {
		const { task, readDurable } = harness([
			{ role: "user", content: "Create a separate task to investigate", input_origin: "human" },
			{ role: "assistant", content: "The first review is complete." },
		])
		const revocation = "Do not create a separate task. Continue in this chat."
		await expect(task["resumeTaskFromHistory"](revocation)).rejects.toBe(stopBeforeProvider)
		expect(extractUserRequestText(readDurable())).toBe(revocation)
		expect(isExplicitIndependentTaskRequest(extractUserRequestText(readDurable()))).toBe(false)
	})
})
