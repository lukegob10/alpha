import type { Anthropic } from "@anthropic-ai/sdk"
import type { McpToolCallResponse } from "@alpha-code/types"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import type { AgentResponse } from "../../agent/AgentResponse"
import type { ToolResponse } from "../../../shared/tools"
import { ToolRegistry, type ToolDescriptor } from "../ToolRegistry"
import { TOOL_OUTPUT_TRUNCATION_SUFFIX } from "../BaseTool"
import i18next from "../../../i18n"
import toolTranslations from "../../../i18n/locales/en/tools.json"

beforeAll(() => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
})

const toolName = "mcp--media-server--inspect"
const callId = "media-call-1"
const audioPlaceholder = "<audio content omitted because you do not support audio input>"
const imagePlaceholder = "<image content omitted because you do not support image input>"
const image = (data: string): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
})
const text = (value: string): Anthropic.TextBlockParam => ({ type: "text", text: value })

function modelResponse(): AgentResponse {
	const call = { type: "tool_call" as const, id: callId, name: toolName, arguments: {} }
	return { items: [call], text: "", reasoning: "", toolCalls: [call] }
}

function textOf(content: ToolResponse): string {
	return typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
}

function fixture(
	result: McpToolCallResponse,
	options: { supportsImages?: boolean; deferResultCommit?: boolean; maxOutputChars?: number } = {},
) {
	const history: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam> = []
	const callTool = vi.fn(
		(_server: string, _tool: string, _args?: Record<string, unknown>, _source?: string, _signal?: AbortSignal) =>
			Promise.resolve(result),
	)
	const postMessageToWebview = vi.fn(async (_message: { type: string; text?: string }) => {})
	const say = vi.fn(async () => {})
	const task = {
		taskId: "mcp-media-test",
		abort: false,
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		consecutiveMistakeCount: 0,
		lastMessageTs: 1,
		api: { getModel: () => ({ info: { supportsImages: options.supportsImages ?? true } }) },
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		say,
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		userMessageContent: history,
		providerRef: {
			deref: () => ({
				getMcpHub: () => ({
					getAllServers: () => [{ name: "media-server", tools: [{ name: "inspect" }] }],
					callTool,
				}),
				postMessageToWebview,
			}),
		},
		pushToolResultToUserContent(result: Anthropic.ToolResultBlockParam) {
			if (history.some((part) => part.type === "tool_result" && part.tool_use_id === result.tool_use_id))
				return false
			history.push(result)
			return true
		},
	} as unknown as Task
	const schema: ToolDescriptor["schema"] = {
		type: "function",
		function: { name: toolName, description: "Inspect media", parameters: { type: "object", properties: {} } },
	}
	const registry = new ToolRegistry({
		nativeTools: [],
		mcpTools: [schema],
		supportsImages: options.supportsImages ?? true,
	})
	const controller = new AbortController()
	const scheduler = new ToolScheduler({
		task,
		registry,
		mode: "code",
		policy:
			options.maxOutputChars === undefined
				? undefined
				: createToolPolicySnapshot({
						visibleTools: [toolName],
						outputLimits: { [toolName]: options.maxOutputChars },
					}),
		validateCall: () => {},
		signal: controller.signal,
		preserveAbortedResults: true,
		deferResultCommit: options.deferResultCommit,
	})
	return { task, registry, scheduler, controller, history, callTool, say, postMessageToWebview }
}

function receipt(history: ReturnType<typeof fixture>["history"]): Anthropic.ToolResultBlockParam {
	expect(history.filter((part) => part.type === "tool_result")).toHaveLength(1)
	const result = history.find((part): part is Anthropic.ToolResultBlockParam => part.type === "tool_result")
	if (!result) throw new Error("Missing MCP tool result")
	expect(result.tool_use_id).toBe(callId)
	return result
}

describe("MCP media result projection", () => {
	it("preserves text/image/text/image through immediate MCP history", async () => {
		const execution = fixture({
			content: [
				{ type: "text", text: "First caption" },
				{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" },
				{ type: "text", text: "Second caption" },
				{ type: "image", mimeType: "image/png", data: "data:image/png;base64,c2Vjb25k" },
			],
		})
		const expected = [text("First caption"), image("Zmlyc3Q="), text("Second caption"), image("c2Vjb25k")]

		const outcome = await execution.scheduler.run(modelResponse())
		expect(execution.callTool).toHaveBeenCalledOnce()
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId, name: toolName, status: "success" })
		expect(outcome.results[0].content).toEqual(expected)
		expect(receipt(execution.history)).toMatchObject({ is_error: false, content: expected })
		expect(execution.history).toHaveLength(1)
	})

	it("rejects deferred MCP media before approval, dispatch, or publication", async () => {
		const execution = fixture(
			{
				content: [
					{ type: "text", text: "Never dispatched" },
					{ type: "image", mimeType: "image/png", data: "bmV2ZXI=" },
				],
			},
			{ deferResultCommit: true },
		)

		await expect(execution.scheduler.run(modelResponse())).rejects.toThrow(
			"Deferred tool results require an audited, approval-free read call.",
		)
		await execution.scheduler.commitDeferredResults()
		await execution.scheduler.commitDeferredResults()
		expect(execution.task.ask).not.toHaveBeenCalled()
		expect(execution.task.recordToolUsage).not.toHaveBeenCalled()
		expect(execution.callTool).not.toHaveBeenCalled()
		expect(execution.say).not.toHaveBeenCalled()
		expect(execution.postMessageToWebview).not.toHaveBeenCalled()
		expect(execution.history).toEqual([])
	})

	it("uses captured image support without reading a changed live provider", async () => {
		const execution = fixture({ content: [{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" }] })
		const getModel = vi.fn(() => {
			throw new Error("The captured MCP media contract must not read the mutable provider")
		})
		Object.assign(execution.task, { api: { getModel } })

		const outcome = await execution.scheduler.run(modelResponse())

		expect(outcome.results[0]).toMatchObject({ status: "success", content: [image("Zmlyc3Q=")] })
		expect(getModel).not.toHaveBeenCalled()
		expect(receipt(execution.history).content).toEqual([image("Zmlyc3Q=")])
	})

	it("returns an explicit bounded audio-only placeholder without copying its payload", async () => {
		const audio = "A".repeat(100_000)
		const execution = fixture({ content: [{ type: "audio", mimeType: "audio/wav", data: audio }] })

		const outcome = await execution.scheduler.run(modelResponse())
		expect(outcome.results[0].status).toBe("success")
		expect(textOf(outcome.results[0].content)).toBe(audioPlaceholder)
		expect(JSON.stringify(outcome.results[0].content)).not.toContain(audio)
		expect(JSON.stringify(outcome.results[0].content).length).toBeLessThan(256)
		expect(receipt(execution.history).is_error).toBe(false)
		expect(JSON.stringify(execution.history)).toContain(audioPlaceholder)
		expect(JSON.stringify(execution.history)).not.toContain("(No response)")
	})

	it("retains unsupported-media positions between captions for a text-only model", async () => {
		const execution = fixture(
			{
				content: [
					{ type: "text", text: "Before image" },
					{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
					{ type: "text", text: "Between media" },
					{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
					{ type: "text", text: "After audio" },
				],
			},
			{ supportsImages: false },
		)

		const outcome = await execution.scheduler.run(modelResponse())
		const output = textOf(outcome.results[0].content)
		const markers = ["Before image", imagePlaceholder, "Between media", audioPlaceholder, "After audio"]
		const positions = markers.map((marker) => output.indexOf(marker))
		expect(positions.every((position) => position >= 0)).toBe(true)
		expect(positions).toEqual([...positions].sort((a, b) => a - b))
		expect(JSON.stringify(execution.history)).not.toContain('"type":"image"')
		expect(receipt(execution.history).is_error).toBe(false)
	})

	it("preserves error status and structured details beside ordered media", async () => {
		const structuredContent = { code: "PARTIAL", message: "Second render is unavailable" }
		const execution = fixture({
			isError: true,
			structuredContent,
			content: [
				{ type: "text", text: "First caption" },
				{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" },
				{ type: "text", text: "After first image" },
			],
		})

		const outcome = await execution.scheduler.run(modelResponse())
		expect(outcome.results[0]).toMatchObject({ callId, status: "error" })
		const content = outcome.results[0].content
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error("MCP media was flattened")
		const imagePosition = content.findIndex((part) => part.type === "image")
		expect(textOf(content.slice(0, imagePosition))).toContain("First caption")
		expect(textOf(content.slice(imagePosition + 1))).toContain("After first image")
		expect(textOf(content.slice(imagePosition + 1))).toContain(JSON.stringify(structuredContent, null, 2))
		expect(receipt(execution.history)).toMatchObject({ is_error: true, content })
		expect(execution.task.didToolFailInCurrentTurn).toBe(true)
	})

	it("keeps image positions when the scheduler truncates long intervening text", async () => {
		const execution = fixture(
			{
				content: [
					{ type: "text", text: "First caption" },
					{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" },
					{ type: "text", text: "Between images. ".repeat(100) },
					{ type: "image", mimeType: "image/png", data: "c2Vjb25k" },
				],
			},
			{ maxOutputChars: 160 },
		)

		const outcome = await execution.scheduler.run(modelResponse())
		const content = outcome.results[0].content
		expect(outcome.results[0]).toMatchObject({ status: "success", truncated: true })
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error("MCP media was flattened")
		expect(content.map((part) => part.type)).toEqual(["text", "image", "text", "image"])
		expect(textOf(content)).toContain("[Tool output truncated by harness]")
		expect(textOf(content).length).toBeLessThanOrEqual(160)
		expect(receipt(execution.history).content).toEqual(content)
	})

	it("includes text-block separators in the exact output budget while retaining image order", async () => {
		const execution = fixture(
			{
				content: [
					{ type: "text", text: "A".repeat(80) },
					{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" },
					{ type: "text", text: "B".repeat(80) },
					{ type: "image", mimeType: "image/png", data: "c2Vjb25k" },
				],
			},
			{ maxOutputChars: 160 },
		)

		const outcome = await execution.scheduler.run(modelResponse())
		const content = outcome.results[0].content

		expect(outcome.results[0].truncated).toBe(true)
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error("MCP media was flattened")
		expect(content.map((part) => part.type)).toEqual(["text", "image", "text", "image"])
		expect(textOf(content).length).toBeLessThanOrEqual(160)
		expect(textOf(content)).toContain("[Tool output truncated by harness]")
		expect(content.filter((part) => part.type === "image")).toEqual([image("Zmlyc3Q="), image("c2Vjb25k")])
	})

	it("keeps an astral cutoff valid while preserving source content and image order", async () => {
		const prefixLimit = 160 - TOOL_OUTPUT_TRUNCATION_SUFFIX.length - "First".length - 1
		const source: McpToolCallResponse = {
			content: [
				{ type: "text", text: "First" },
				{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" },
				{ type: "text", text: `${"A".repeat(prefixLimit - 1)}😀${"tail".repeat(100)}` },
				{ type: "image", mimeType: "image/png", data: "c2Vjb25k" },
			],
		}
		const before = structuredClone(source)
		const execution = fixture(source, { maxOutputChars: 160 })

		const outcome = await execution.scheduler.run(modelResponse())
		const content = outcome.results[0].content
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error("MCP media was flattened")
		const output = textOf(content)

		expect(outcome.results[0].truncated).toBe(true)
		expect(output.length).toBeLessThanOrEqual(160)
		expect(output).toBe(Buffer.from(output, "utf8").toString("utf8"))
		expect(content.map((part) => part.type)).toEqual(["text", "image", "text", "image"])
		expect(source).toEqual(before)
	})

	it("commits one cancelled immediate MCP receipt and rejects late media", async () => {
		const result: McpToolCallResponse = {
			content: [
				{ type: "text", text: "Late caption" },
				{ type: "image", mimeType: "image/png", data: "bGF0ZQ==" },
			],
		}
		const execution = fixture(result)
		let dispatchStarted!: () => void
		const started = new Promise<void>((resolve) => {
			dispatchStarted = resolve
		})
		let resolveRequest!: (value: McpToolCallResponse) => void
		const request = new Promise<McpToolCallResponse>((resolve) => {
			resolveRequest = resolve
		})
		execution.callTool.mockImplementation(() => {
			dispatchStarted()
			return request
		})
		const running = execution.scheduler.run(modelResponse())

		await started
		execution.controller.abort(new Error("cancelled during MCP media request"))
		resolveRequest(result)
		const outcome = await running
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId, status: "cancelled" })
		expect(receipt(execution.history).is_error).toBe(true)
		expect(execution.history).toHaveLength(1)
		expect(JSON.stringify(execution.history)).not.toContain("Late caption")
		expect(JSON.stringify(execution.history)).not.toContain('"type":"image"')
		expect(execution.callTool).toHaveBeenCalledOnce()
	})
})
