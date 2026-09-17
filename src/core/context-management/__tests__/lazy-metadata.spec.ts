import type Anthropic from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import * as condense from "../../condense"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { manageContext, type ContextManagementOptions } from "../index"

const tools: NonNullable<ApiHandlerCreateMessageMetadata["tools"]> = [
	{ type: "function", function: { name: "read_file", parameters: { type: "object" } } },
]

function fixture() {
	const messages: ApiMessage[] = [
		{ role: "user", content: "One" },
		{ role: "assistant", content: "Two" },
		{ role: "user", content: "Three" },
		{ role: "assistant", content: "Four" },
		{ role: "user", content: "Five" },
	]
	const countTokens = vi.fn(async (_content: Anthropic.Messages.ContentBlockParam[]) => 10)
	const createMessage = vi.fn<ApiHandler["createMessage"]>()
	const apiHandler: ApiHandler = {
		createMessage,
		countTokens,
		getModel: () => ({
			id: "lazy-metadata-fixture",
			info: { contextWindow: 1000, maxTokens: 100, supportsPromptCache: false },
		}),
	}
	const prepareTools = vi.fn(async () => ({ tools, tool_choice: "auto" as const, parallelToolCalls: true }))
	const options: ContextManagementOptions = {
		messages,
		totalTokens: 100,
		contextWindow: 1000,
		maxTokens: 100,
		apiHandler,
		autoCondenseContext: true,
		autoCondenseContextPercent: 50,
		systemPrompt: "System",
		taskId: "lazy-metadata-task",
		profileThresholds: {},
		currentProfileId: "default",
		prepareTools,
	}
	return { options, messages, countTokens, createMessage, prepareTools }
}

describe("context management tool metadata admission", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		vi.spyOn(condense, "summarizeConversation").mockImplementation(async ({ messages }) => ({
			messages,
			summary: "Summary",
			cost: 0,
			newContextTokens: 100,
		}))
	})

	afterEach(() => vi.restoreAllMocks())

	it("does not prepare tools below the authoritative threshold", async () => {
		const { options, messages, prepareTools, countTokens } = fixture()
		const result = await manageContext(options)
		expect(result.messages).toBe(messages)
		expect(result.prevContextTokens).toBe(110)
		expect(countTokens).toHaveBeenCalledOnce()
		expect(prepareTools).not.toHaveBeenCalled()
		expect(condense.summarizeConversation).not.toHaveBeenCalled()
	})

	it.each<{ totalTokens: number; profileThresholds: Record<string, number> }>([
		{ totalTokens: 490, profileThresholds: {} },
		{ totalTokens: 240, profileThresholds: { default: 25 } },
		{ totalTokens: 490, profileThresholds: { default: -1 } },
	])("prepares once at an exact global or profile threshold: %j", async (threshold) => {
		const { options, prepareTools } = fixture()
		await manageContext({ ...options, ...threshold })
		expect(prepareTools).toHaveBeenCalledOnce()
		expect(condense.summarizeConversation).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: expect.objectContaining({ tools }) }),
		)
	})

	it("includes prepared schemas in truncation counts with automatic condensation disabled", async () => {
		const { options, prepareTools, countTokens } = fixture()
		const result = await manageContext({ ...options, totalTokens: 801, autoCondenseContext: false })
		expect(prepareTools).toHaveBeenCalledOnce()
		expect(condense.summarizeConversation).not.toHaveBeenCalled()
		expect(result.messagesRemoved).toBeGreaterThan(0)
		expect(countTokens.mock.calls.some(([blocks]) => JSON.stringify(blocks).includes("read_file"))).toBe(true)
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -100])(
		"rejects invalid total %s without preparing tools",
		async (totalTokens) => {
			const { options, prepareTools, createMessage } = fixture()
			const result = await manageContext({ ...options, totalTokens })
			expect(result.status).toBe("no_progress")
			expect(prepareTools).not.toHaveBeenCalled()
			expect(condense.summarizeConversation).not.toHaveBeenCalled()
			expect(createMessage).not.toHaveBeenCalled()
		},
	)

	it("rejects invalid provider counts without preparing tools", async () => {
		const { options, prepareTools, countTokens } = fixture()
		countTokens.mockResolvedValue(Number.NaN)
		expect((await manageContext(options)).status).toBe("no_progress")
		expect(prepareTools).not.toHaveBeenCalled()
	})

	it("prepares forced recovery before its first full-input count even below the threshold", async () => {
		const { options, prepareTools, countTokens } = fixture()
		await manageContext({ ...options, forceCompaction: true })
		expect(prepareTools).toHaveBeenCalledOnce()
		expect(prepareTools.mock.invocationCallOrder[0]).toBeLessThan(countTokens.mock.invocationCallOrder[0])
		expect(JSON.stringify(countTokens.mock.calls[0][0])).toContain("read_file")
	})

	it("reuses prepared metadata when summarization falls back to truncation", async () => {
		const { options, prepareTools, countTokens } = fixture()
		vi.mocked(condense.summarizeConversation).mockResolvedValue({
			messages: options.messages,
			summary: "",
			cost: 0,
			error: "Summary unavailable",
		})
		const result = await manageContext({ ...options, totalTokens: 801 })
		expect(result.messagesRemoved).toBeGreaterThan(0)
		expect(prepareTools).toHaveBeenCalledOnce()
		expect(countTokens.mock.calls.some(([blocks]) => JSON.stringify(blocks).includes("read_file"))).toBe(true)
	})

	it("preserves eager cancellation authority and stops after cancellation during preparation", async () => {
		const { options, prepareTools, createMessage } = fixture()
		const controller = new AbortController()
		const reason = new Error("Cancelled during preparation")
		prepareTools.mockImplementation(async () => {
			controller.abort(reason)
			return { tools, tool_choice: "auto", parallelToolCalls: true }
		})
		await expect(
			manageContext({
				...options,
				totalTokens: 801,
				metadata: { taskId: options.taskId, signal: controller.signal },
			}),
		).rejects.toBe(reason)
		expect(condense.summarizeConversation).not.toHaveBeenCalled()
		expect(createMessage).not.toHaveBeenCalled()
	})

	it("propagates preparation failure without dispatching or falling back", async () => {
		const { options, prepareTools, createMessage, countTokens } = fixture()
		const reason = new Error("Catalog unavailable")
		prepareTools.mockRejectedValue(reason)
		await expect(manageContext({ ...options, totalTokens: 801 })).rejects.toBe(reason)
		expect(condense.summarizeConversation).not.toHaveBeenCalled()
		expect(createMessage).not.toHaveBeenCalled()
		expect(countTokens).toHaveBeenCalledOnce()
	})

	it("does not let prepared tools replace eager request authority", async () => {
		const { options } = fixture()
		const controller = new AbortController()
		const metadata = {
			taskId: "eager-task",
			mode: "code",
			signal: controller.signal,
			deadline: Date.now() + 60_000,
		}
		await manageContext({
			...options,
			totalTokens: 801,
			metadata,
			prepareTools: async () => ({
				tools,
				taskId: "replacement-task",
				mode: "replacement-mode",
				signal: new AbortController().signal,
				deadline: 0,
			}),
		})
		expect(condense.summarizeConversation).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: { ...metadata, tools } }),
		)
		expect(metadata).not.toHaveProperty("tools")
	})

	it("does not prepare or count when eager cancellation already applies", async () => {
		const { options, prepareTools, countTokens } = fixture()
		const controller = new AbortController()
		const reason = new Error("Already cancelled")
		controller.abort(reason)
		await expect(
			manageContext({
				...options,
				forceCompaction: true,
				metadata: { taskId: options.taskId, signal: controller.signal },
			}),
		).rejects.toBe(reason)
		expect(prepareTools).not.toHaveBeenCalled()
		expect(countTokens).not.toHaveBeenCalled()
	})
})
