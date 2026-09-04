import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import { getToolBatchIsolationError, ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"

const barriers = [
	"new_task",
	"delegate_task",
	"attempt_completion",
	"switch_mode",
	"ask_followup_question",
	"wait_agent",
]

function toolCall(id: string, name: string, args: unknown = {}): AgentToolCall {
	return { type: "tool_call", id, name, arguments: args }
}

function createHost() {
	const results: Anthropic.ToolResultBlockParam[] = []
	const host: ToolExecutionHost = {
		taskId: "barrier-contract",
		userMessageContent: results,
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		say: vi.fn().mockResolvedValue(undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent: (result) => {
			if (results.some((existing) => existing.tool_use_id === result.tool_use_id)) return false
			results.push(result)
			return true
		},
	}
	return { host, results }
}

function createRegistry() {
	return new ToolRegistry({
		mcpTools: [
			{
				type: "function",
				function: {
					name: "mcp--docs--lookup",
					description: "Fixture MCP lookup",
					parameters: { type: "object", properties: {} },
				},
			},
		],
	})
}

describe("captured tool barrier isolation", () => {
	it.each(
		barriers.flatMap((barrier) =>
			["before", "after"].flatMap((position) =>
				["list_agents", "mcp__docs__lookup"].map((other) => ({ barrier, position, other })),
			),
		),
	)("rejects $barrier $position $other before every effect", async ({ barrier, position, other }) => {
		const { host, results } = createHost()
		const surface = createTaskToolSurface({ registry: createRegistry(), mode: "code" })
		const barrierCall = toolCall("barrier", barrier)
		const otherCall = toolCall("other", other)
		const calls = position === "before" ? [barrierCall, otherCall] : [otherCall, barrierCall]
		const response = createAgentResponse([
			{ type: "text", text: "Before the tools." },
			...calls,
			{ type: "text", text: "After the tools." },
		])
		const beforeEffect = vi.fn(() => {
			throw new Error("An invalid batch must never reach an effect")
		})
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
			beforeEffect,
		}).run(response)

		expect(
			getToolBatchIsolationError(
				surface.registry,
				calls.map((call) => call.name),
			),
		).toContain(barrier)
		expect(beforeEffect).not.toHaveBeenCalled()
		expect(host.ask).not.toHaveBeenCalled()
		expect(host.recordToolUsage).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(results.map((result) => result.tool_use_id)).toEqual(calls.map((call) => call.id))
		expect(
			results.every(
				(result) => result.is_error && String(result.content).includes("No tools from this turn were executed"),
			),
		).toBe(true)
		expect(response.toolCalls).toEqual(calls)
		expect(response.text).toBe("Before the tools.After the tools.")
	})

	it("keeps text outside the batch decision and accepts empty, singleton, and ordinary tool sequences", () => {
		const registry = createRegistry()
		expect(getToolBatchIsolationError(registry, [])).toBeUndefined()
		for (const barrier of barriers) expect(getToolBatchIsolationError(registry, [barrier])).toBeUndefined()
		expect(getToolBatchIsolationError(registry, ["list_agents", "mcp--docs--lookup"])).toBeUndefined()
	})

	it("rejects all calls even when a barrier is disabled or has malformed arguments", async () => {
		const { host, results } = createHost()
		const surface = createTaskToolSurface({ registry: createRegistry(), disabledTools: ["wait_agent"] })
		const beforeEffect = vi.fn(() => {
			throw new Error("must not execute")
		})
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
			beforeEffect,
		}).run([
			toolCall("first", "list_agents"),
			toolCall("wait", "wait_agent", null),
			toolCall("last", "mcp--docs--lookup"),
		])

		expect(beforeEffect).not.toHaveBeenCalled()
		expect(
			outcome.results.every(
				(result) => result.status === "error" && String(result.content).includes("must be called by itself"),
			),
		).toBe(true)
		expect(results.map((result) => result.tool_use_id)).toEqual(["first", "wait", "last"])
	})

	it("derives custom and MCP alias barriers from registry metadata", async () => {
		const { host, results } = createHost()
		const registry = createRegistry()
		const execute = vi.fn(async () => {})
		registry.register({
			name: "mcp--session--finish",
			aliases: ["finish_session"],
			schema: {
				type: "function",
				function: { name: "mcp--session--finish", parameters: { type: "object", properties: {} } },
			},
			capabilities: {
				concurrency: "barrier",
				sideEffects: "external",
				controlFlow: true,
				requiresApproval: true,
			},
			execute,
		})
		const surface = createTaskToolSurface({ registry })
		expect(getToolBatchIsolationError(surface.registry, ["list_agents", "finish_session"])).toContain(
			"finish_session",
		)
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run([toolCall("first", "list_agents"), toolCall("finish", "mcp__session__finish")])
		expect(execute).not.toHaveBeenCalled()
		expect(host.recordToolUsage).not.toHaveBeenCalled()
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(results.map((result) => result.tool_use_id)).toEqual(["first", "finish"])
	})

	it("rejects multiple barriers without dropping any valid call ID", async () => {
		const { host, results } = createHost()
		const registry = createRegistry()
		const outcome = await new ToolScheduler({ executionHost: host, registry, mode: "code" }).run([
			toolCall("read", "list_agents"),
			toolCall("delegate", "new_task"),
			toolCall("complete", "attempt_completion"),
		])
		expect(outcome.results).toHaveLength(3)
		expect(host.recordToolUsage).not.toHaveBeenCalled()
		expect(results.map((result) => result.tool_use_id)).toEqual(["read", "delegate", "complete"])
	})

	it("keeps staged barrier errors consistent when cancellation wins before scheduling", async () => {
		const { host, results } = createHost()
		const registry = createRegistry()
		const calls = [toolCall("read", "list_agents"), toolCall("wait", "wait_agent")]
		const controller = new AbortController()
		controller.abort()
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			signal: controller.signal,
			preserveAbortedResults: true,
		}).run(calls)
		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(results.map((result) => result.tool_use_id)).toEqual(["read", "wait"])
		expect(results.every((result) => result.is_error)).toBe(true)
		expect(host.recordToolUsage).not.toHaveBeenCalled()
	})
})
