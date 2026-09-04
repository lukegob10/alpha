import { customToolRegistry } from "@alpha-code/core"
import { parametersSchema as z } from "@alpha-code/types"
import { describe, expect, it, afterEach, vi } from "vitest"

import { getNativeTools } from "../../prompts/tools/native-tools"
import {
	capturedSurface,
	fixtureDescriptor,
	fixtureRegistry,
	functionSchema,
	imageResults,
	makeExecutionHost,
	registerCustomTool,
	runToolCalls,
	toolResults,
} from "./nor30-tool-fixtures"
import { ToolRegistry } from "../ToolRegistry"
import type { ToolDescriptor } from "../ToolRegistry"

const cleanups: Array<() => void> = []
const mcpToolNames = ["mcp--nor30-server--nor30-tool", "mcp__nor30-server__nor30-tool"]

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup()
	vi.restoreAllMocks()
})

describe("NOR-30 captured tool execution: custom and MCP tools", () => {
	it("executes a registered custom tool through the captured surface and preserves the task lane mode", async () => {
		const execute = vi.fn(async (args: { value: string }, context: { mode: string; task: unknown }) => {
			return `custom:${args.value}:${context.mode}`
		})
		const definition = {
			name: "nor30_custom_tool",
			description: "NOR-30 custom tool fixture",
			parameters: z.object({ value: z.string() }),
			execute,
		}
		const registered = registerCustomTool(definition)
		cleanups.push(registered.cleanup)
		const registry = new ToolRegistry({ nativeTools: [registered.schema], includeCustomTools: true })
		const surface = capturedSurface(registry, { schemas: [registered.schema] })
		const harness = makeExecutionHost({ taskMode: "ask" })

		const outcome = await runToolCalls(
			harness,
			surface,
			[{ id: "custom-1", name: definition.name, arguments: { value: "hello" } }],
			{ experiments: { customTools: true } },
		)

		expect(surface.resolve(definition.name)?.name).toBe(definition.name)
		expect(execute).toHaveBeenCalledWith({ value: "hello" }, { mode: "ask", task: harness.task })
		expect(outcome.results[0]).toMatchObject({ callId: "custom-1", name: definition.name, status: "success" })
		expect(outcome.results[0].content).toBe("custom:hello:ask")
		expect(harness.host.recordToolUsage).toHaveBeenCalledWith(definition.name)
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({ tool_use_id: "custom-1", content: "custom:hello:ask" })
	})

	it("turns a custom leaf failure into one structured error result", async () => {
		const execute = vi.fn().mockRejectedValue(new Error("custom leaf failed"))
		const definition = {
			name: "nor30_failing_custom_tool",
			description: "NOR-30 failing custom tool fixture",
			execute,
		}
		const registered = registerCustomTool(definition)
		cleanups.push(registered.cleanup)
		const registry = new ToolRegistry({ nativeTools: [registered.schema], includeCustomTools: true })
		const surface = capturedSurface(registry, { schemas: [registered.schema] })
		const harness = makeExecutionHost()

		const outcome = await runToolCalls(
			harness,
			surface,
			[{ id: "custom-error-1", name: definition.name, arguments: {} }],
			{ experiments: { customTools: true } },
		)

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("custom leaf failed")
		expect(execute).toHaveBeenCalledOnce()
		expect(harness.host.recordToolUsage).toHaveBeenCalledOnce()
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0].is_error).toBe(true)
	})

	it("fails closed when the custom tool experiment is disabled", async () => {
		const execute = vi.fn().mockResolvedValue("must not execute")
		const definition = {
			name: "nor30_gated_custom_tool",
			description: "NOR-30 gated custom tool fixture",
			execute,
		}
		const registered = registerCustomTool(definition)
		cleanups.push(registered.cleanup)
		const registry = new ToolRegistry({ nativeTools: [registered.schema], includeCustomTools: true })
		const surface = capturedSurface(registry, { schemas: [registered.schema] })
		const harness = makeExecutionHost()
		const hasSpy = vi.spyOn(customToolRegistry, "has")

		const outcome = await runToolCalls(
			harness,
			surface,
			[{ id: "custom-disabled-1", name: definition.name, arguments: {} }],
			{ experiments: { customTools: false } },
		)

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("Unknown tool")
		expect(execute).not.toHaveBeenCalled()
		expect(harness.host.recordToolUsage).not.toHaveBeenCalled()
		expect(hasSpy).not.toHaveBeenCalled()
		expect(toolResults(harness)).toHaveLength(1)
	})

	it("normalizes production aliases at the surface policy boundary", async () => {
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry, {
			schemas,
			disabledTools: ["search_and_replace"],
		})
		const harness = makeExecutionHost()

		expect(surface.registry.resolve("search_and_replace")?.name).toBe("edit")
		expect(surface.policy.disabledTools).toContain("edit")
		expect(surface.isCallable("search_and_replace")).toBe(false)

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "alias-disabled-1",
				name: "search_and_replace",
				arguments: { path: "fixture.txt", old_string: "old", new_string: "new" },
			},
		])

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("not allowed")
		expect(harness.host.recordToolUsage).not.toHaveBeenCalled()
		expect(toolResults(harness)).toHaveLength(1)
	})

	it("records the legacy MCP leaf through the real registry and scheduler", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "mcp result" }] })
		const postMessageToWebview = vi.fn()
		const mcpHub = {
			getAllServers: () => [{ name: "nor30-server", tools: [{ name: "nor30_tool" }] }],
			callTool,
		}
		const provider = { getMcpHub: () => mcpHub, postMessageToWebview }
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost({ provider })

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "mcp-1",
				name: "use_mcp_tool",
				arguments: {
					server_name: "nor30-server",
					tool_name: "nor30_tool",
					arguments: { value: "hello" },
				},
			},
		])

		expect(outcome.results[0]).toMatchObject({ callId: "mcp-1", name: "use_mcp_tool", status: "success" })
		expect(outcome.results[0].content).toBe("mcp result")
		expect(callTool).toHaveBeenCalledWith("nor30-server", "nor30_tool", { value: "hello" })
		expect(harness.host.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
		expect(toolResults(harness)).toHaveLength(1)
	})

	it.each(mcpToolNames)("dispatches %s through default validation with typed arguments", async (name) => {
		const callTool = vi.fn().mockResolvedValue({
			content: [
				{ type: "text", text: "dynamic MCP result" },
				{ type: "image", mimeType: "image/png", data: "mcp-image-one" },
				{ type: "image", mimeType: "image/jpeg", data: "mcp-image-two" },
			],
		})
		const mcpHub = {
			getAllServers: () => [{ name: "nor30-server", tools: [{ name: "nor30-tool" }] }],
			callTool,
		}
		const provider = { getMcpHub: () => mcpHub, postMessageToWebview: vi.fn() }
		const schema = functionSchema("mcp--nor30-server--nor30-tool")
		const registry = new ToolRegistry({ nativeTools: [], mcpTools: [schema] })
		const surface = capturedSurface(registry, { schemas: [schema] })
		const approvalImages = ["data:image/gif;base64,approval-image"]
		const harness = makeExecutionHost({
			provider,
			approval: { response: "yesButtonClicked", text: "approved dynamic call", images: approvalImages },
		})
		const argumentsValue = { value: "typed value", count: 2 }

		const outcome = await runToolCalls(harness, surface, [
			{ id: `dynamic-${name}`, name, arguments: argumentsValue },
		])

		expect(surface.registry.resolve(name)?.name).toBe("mcp--nor30-server--nor30-tool")
		expect(outcome.results[0]).toMatchObject({
			callId: `dynamic-${name}`,
			name,
			status: "success",
		})
		expect(outcome.results[0].content).toEqual(
			expect.arrayContaining([
				{ type: "text", text: expect.stringContaining("approved dynamic call") },
				{ type: "text", text: "dynamic MCP result" },
			]),
		)
		expect(callTool).toHaveBeenCalledOnce()
		expect(callTool).toHaveBeenCalledWith("nor30-server", "nor30-tool", argumentsValue)
		expect(harness.host.recordToolUsage).toHaveBeenCalledWith(name)
		expect(harness.host.say).toHaveBeenCalledWith("user_feedback", "approved dynamic call", approvalImages)
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({
			tool_use_id: `dynamic-${name}`,
			content: expect.stringContaining("dynamic MCP result"),
		})
		expect(imageResults(harness).map((item) => item.source)).toEqual([
			{ type: "base64", media_type: "image/gif", data: "approval-image" },
			{ type: "base64", media_type: "image/png", data: "mcp-image-one" },
			{ type: "base64", media_type: "image/jpeg", data: "mcp-image-two" },
		])
		expect(harness.userMessageContent.slice(0, 4).map((item) => item.type)).toEqual([
			"tool_result",
			"image",
			"image",
			"image",
		])
	})

	it.each(mcpToolNames)("rejects approval-denied %s without invoking its leaf", async (name) => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "must not run" }] })
		const mcpHub = {
			getAllServers: () => [{ name: "nor30-server", tools: [{ name: "nor30-tool" }] }],
			callTool,
		}
		const provider = { getMcpHub: () => mcpHub, postMessageToWebview: vi.fn() }
		const schema = functionSchema("mcp--nor30-server--nor30-tool")
		const registry = new ToolRegistry({ nativeTools: [], mcpTools: [schema] })
		const surface = capturedSurface(registry, { schemas: [schema] })
		const harness = makeExecutionHost({ provider, approval: { response: "noButtonClicked" } })

		const outcome = await runToolCalls(harness, surface, [
			{ id: `mcp-denied-${name}`, name, arguments: { value: "blocked" } },
		])

		expect(outcome.results[0]).toMatchObject({
			callId: `mcp-denied-${name}`,
			name,
			status: "denied",
		})
		expect(callTool).not.toHaveBeenCalled()
		expect(outcome.approvalRequestCount).toBe(1)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({
			tool_use_id: `mcp-denied-${name}`,
			is_error: true,
		})
	})

	it("rejects an approval-denied legacy MCP call without invoking its leaf", async () => {
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "must not run" }] })
		const mcpHub = {
			getAllServers: () => [{ name: "nor30-server", tools: [{ name: "nor30_tool" }] }],
			callTool,
		}
		const provider = { getMcpHub: () => mcpHub, postMessageToWebview: vi.fn() }
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost({ provider, approval: { response: "noButtonClicked" } })

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "mcp-denied-1",
				name: "use_mcp_tool",
				arguments: { server_name: "nor30-server", tool_name: "nor30_tool", arguments: {} },
			},
		])

		expect(outcome.results[0].status).toBe("denied")
		expect(callTool).not.toHaveBeenCalled()
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0].is_error).toBe(true)
	})
})

describe("NOR-30 scheduler lifecycle and error receipts", () => {
	it("emits one ordered lifecycle and tool result receipt for a leaf that reports twice", async () => {
		const leaf = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			callbacks.pushToolResult("first")
			callbacks.pushToolResult("duplicate")
		})
		const registry = fixtureRegistry(fixtureDescriptor("nor30_once", leaf))
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()
		const events: Array<{ type: string; callId?: string }> = []

		const outcome = await runToolCalls(harness, surface, [{ id: "once-1", name: "nor30_once" }], {
			validateCall: () => {},
			onEvent: (event) => {
				events.push({
					type: event.type,
					...(typeof event === "object" && "callId" in event ? { callId: event.callId } : {}),
				})
			},
		})

		expect(outcome.status).toBe("completed")
		expect(leaf).toHaveBeenCalledOnce()
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0].content).toBe("first")
		expect(events.map((event) => event.type)).toEqual([
			"tool_batch_started",
			"progress",
			"tool_result",
			"tool_batch_finished",
		])
		expect(events.filter((event) => event.type === "tool_result")).toEqual([
			{ type: "tool_result", callId: "once-1" },
		])
	})

	it("rejects a blocking barrier mixed with another call before either leaf runs", async () => {
		const read = vi.fn()
		const complete = vi.fn()
		const registry = fixtureRegistry(
			fixtureDescriptor("nor30_read", async () => void read()),
			fixtureDescriptor("nor30_complete", async () => void complete(), {
				concurrency: "barrier",
				controlFlow: true,
			}),
		)
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()

		const outcome = await runToolCalls(
			harness,
			surface,
			[
				{ id: "barrier-read", name: "nor30_read" },
				{ id: "barrier-complete", name: "nor30_complete" },
			],
			{ validateCall: () => {} },
		)

		expect(read).not.toHaveBeenCalled()
		expect(complete).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(outcome.results[1].content).toContain("must be called by itself")
		expect(toolResults(harness).map((result) => result.tool_use_id)).toEqual(["barrier-read", "barrier-complete"])
	})
})
