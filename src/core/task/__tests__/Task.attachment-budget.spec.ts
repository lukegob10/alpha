import type { Anthropic } from "@anthropic-ai/sdk"
import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { parseMentions } from "../../mentions/index"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { DEFAULT_TOOL_OUTPUT_LIMIT } from "../../agent/ToolPolicy"

vi.mock("../../mentions/index", () => ({ parseMentions: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(),
}))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureConversationMessage: vi.fn() } } }))
vi.mock("../../../services/code-index/manager", () => ({ CodeIndexManager: { getInstance: () => undefined } }))

type Content = Anthropic.Messages.ContentBlockParam[]
const stopBeforeProvider = new Error("fixture: prepared input reached the provider boundary")
function fixture() {
	let durableBytes = "[]"
	let providerBoundary: ApiMessage[] | undefined
	const save = vi.fn(async () => {
		durableBytes = JSON.stringify(task.apiConversationHistory)
		return true
	})
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "attachment-batch",
		instanceId: "attachment-batch-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		abandoned: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		clineMessages: [],
		apiConversationHistory: [],
		userMessageContent: [],
		isTaskLoopActive: false,
		requestPacingWaitCount: 0,
		apiConfiguration: { apiProvider: "openai" },
		messageQueueService: new MessageQueueService(),
		providerRef: { deref: () => undefined },
		environmentContext: { reset: vi.fn() },
		getTaskMode: vi.fn(async () => "code"),
		saveApiConversationHistory: save,
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
				providerBoundary = structuredClone(task.apiConversationHistory)
				throw stopBeforeProvider
			}
		}),
		recordToolError: vi.fn(),
		retrySaveApiConversationHistory: vi.fn(async () => false),
	}) as Task
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit: vi.fn(), release: vi.fn() })
	vi.mocked(parseMentions).mockImplementation(async (text) => ({
		text,
		contentBlocks: [
			{
				type: "file",
				path: text.includes("preceding") ? "preceding.txt" : "current.txt",
				content: (text.includes("preceding") ? "PRECEDING_EXCERPT:" : "CURRENT_EXCERPT:") + "x".repeat(20_000),
			},
		],
	}))
	return { task, save, durable: () => JSON.parse(durableBytes) as ApiMessage[], boundary: () => providerBoundary }
}
const textContent = (messages: ApiMessage[]) =>
	messages.flatMap((message) =>
		typeof message.content === "string"
			? [message.content]
			: message.content.filter((block) => block.type === "text").map((block) => block.text),
	)

describe("Task attachment admission across one prepared request", () => {
	beforeEach(() => vi.resetAllMocks())
	it("bounds preceding and current generated excerpts before persistence and provider dispatch", async () => {
		const { task, durable, boundary, save } = fixture()
		Reflect.set(task, "pendingSteerMessage", { text: "Read @/current.txt", images: [], inputOrigin: "human" })
		await expect(
			task.runAgentRequests(
				[{ type: "text", text: "<user_message>Read @/preceding.txt</user_message>" }],
				false,
				undefined,
				{ inputOrigin: "human" },
			),
		).rejects.toBe(stopBeforeProvider)
		const saved = durable()
		expect(save).toHaveBeenCalledOnce()
		expect(boundary()).toEqual(saved)
		const text = textContent(saved)
		expect(text.some((part) => part.includes("Read @/preceding.txt"))).toBe(true)
		expect(text.some((part) => part.includes("Read @/current.txt"))).toBe(true)
		const generated = text.filter(
			(part) =>
				part.startsWith("PRECEDING_EXCERPT:") ||
				part.startsWith("CURRENT_EXCERPT:") ||
				part.includes("Attachment excerpts omitted"),
		)
		expect(generated.reduce((sum, part) => sum + part.length, 0)).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_LIMIT)
		expect(generated.some((part) => part.startsWith("PRECEDING_EXCERPT:"))).toBe(true)
		expect(generated.some((part) => part.startsWith("CURRENT_EXCERPT:"))).toBe(false)
		expect(generated.filter((part) => part.includes("Attachment excerpts omitted"))).toHaveLength(1)
		expect(JSON.stringify(saved)).not.toContain("deferredAttachmentParts")
	})
	it("cancels before batch finalization without saving partial prepared messages", async () => {
		const { task, durable, boundary, save } = fixture()
		const reason = new DOMException("Attachment batch cancelled", "AbortError")
		vi.mocked(parseMentions).mockImplementation(async (text) => {
			if (text.includes("current")) Reflect.get(task, "taskCancellationController").abort(reason)
			return { text, contentBlocks: [{ type: "file", content: "x".repeat(20_000) }] }
		})
		Reflect.set(task, "pendingSteerMessage", { text: "Read @/current.txt", images: [], inputOrigin: "human" })
		await expect(
			task.runAgentRequests(
				[{ type: "text", text: "<user_message>Read @/preceding.txt</user_message>" }],
				false,
				undefined,
				{ inputOrigin: "human" },
			),
		).rejects.toBe(reason)
		expect(save).not.toHaveBeenCalled()
		expect(durable()).toEqual([])
		expect(boundary()).toBeUndefined()
	})
})
