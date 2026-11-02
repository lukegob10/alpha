import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import type { McpServer, McpToolCallResponse } from "@alpha-code/types"
import { expandHookMcpInput, runLifecycleHookMcp, type LifecycleHookMcpHub } from "../LifecycleHookMcp"
import type { LifecycleHookRequest } from "../CompletionHooks"
import type { CompletionHookMcp } from "../LifecycleHookConfig"
import { MAX_HOOK_OUTPUT_BYTES } from "../HookOutput"
import { MAX_HOOK_TIMEOUT_MS } from "../LifecycleHookConfig"
import type { McpElicitationOwner } from "../../../services/mcp/elicitation"

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

const event: LifecycleHookRequest = {
	hook_event_name: "PreToolUse",
	session_id: "session",
	turn_id: "turn",
	cwd: process.cwd(),
	model: "fixture",
	permission_mode: "ask",
	transcript_path: null,
	tool_name: "Bash",
	tool_use_id: "call",
	tool_input: { command: "pnpm test", count: 3, enabled: true, values: ["a", "b"], optional: null },
}
const hook: CompletionHookMcp = { type: "mcp_tool", server: "scanner", tool: "scan" }
const server: McpServer = {
	name: "scanner",
	config: "{}",
	status: "connected",
	source: "global",
	tools: [{ name: "scan" }],
}

function fixture(result: McpToolCallResponse = { content: [] }) {
	const callTool = vi.fn<LifecycleHookMcpHub["callTool"]>(async () => result)
	const getServers = vi.fn(() => [structuredClone(server)])
	return { hub: { getServers, callTool }, callTool, getServers }
}

afterEach(() => vi.useRealTimers())

describe("MCP hook input templates", () => {
	it("recursively expands whole JSON values and embedded strings without evaluating code", () => {
		const result = expandHookMcpInput(
			{
				command: "${tool_input.command}",
				count: "${tool_input.count}",
				enabled: "${tool_input.enabled}",
				values: "${tool_input.values}",
				optional: "${tool_input.optional}",
				message: "Run ${tool_input.command} ${tool_input.count} ${tool_input.values}",
				nested: [{ command: "${tool_input.command}" }],
				literal: "$(echo secret) ${not closed",
			},
			event,
		)
		expect(result).toEqual({
			command: "pnpm test",
			count: 3,
			enabled: true,
			values: ["a", "b"],
			optional: null,
			message: 'Run pnpm test 3 ["a","b"]',
			nested: [{ command: "pnpm test" }],
			literal: "$(echo secret) ${not closed",
		})
		const values = result.values as string[]
		values.push("new")
		expect(event.tool_input.values).toEqual(["a", "b"])
	})

	it.each(["missing", "tool_input.missing", "__proto__.secret", "tool_input.values.0"])(
		"rejects unavailable or inherited placeholder %s",
		(key) => expect(() => expandHookMcpInput({ value: `\${${key}}` }, event)).toThrow("not found"),
	)

	it("bounds recursive templates and rejects non-JSON values", () => {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		expect(() => expandHookMcpInput(cycle, event)).toThrow("bound")
		expect(() => expandHookMcpInput({ fn: () => {} }, event)).toThrow("JSON")
	})
})

describe("connected MCP hook execution", () => {
	it("calls only the selected existing connection with typed arguments and consumes text blocks", async () => {
		const { hub, callTool } = fixture({
			structuredContent: { decision: "block", reason: "Ignored structured output" },
			content: [
				{ type: "text", text: '{"decision":' },
				{ type: "image", data: "ignored", mimeType: "image/png" },
				{ type: "text", text: '"block","reason":"Inspect tests"}' },
			],
		})
		const signal = new AbortController().signal
		expect(
			await runLifecycleHookMcp(
				{ ...hook, input: { count: "${tool_input.count}", command: "${tool_input.command}" } },
				event,
				signal,
				{ hub },
			),
		).toEqual({ exitCode: 0, stdout: '{"decision":\n"block","reason":"Inspect tests"}', stderr: "" })
		expect(callTool).toHaveBeenCalledExactlyOnceWith(
			"scanner",
			"scan",
			{ count: 3, command: "pnpm test" },
			"global",
			expect.any(AbortSignal),
			{ transportTimeoutMs: MAX_HOOK_TIMEOUT_MS },
		)
	})

	it.each([
		{ ...server, status: "connecting" as const },
		{ ...server, disabled: true },
		{ ...server, tools: [] },
		{ ...server, tools: [{ name: "scan", enabledForPrompt: false }] },
	])("does not dispatch when a connection or tool is unavailable", async (unavailable) => {
		const { hub, callTool, getServers } = fixture()
		getServers.mockReturnValue([unavailable])
		expect(await runLifecycleHookMcp(hook, event, new AbortController().signal, { hub })).toMatchObject({
			exitCode: null,
			failure: "MCP server or tool is unavailable",
		})
		expect(callTool).not.toHaveBeenCalled()
	})

	it("skips missing hubs, invalid templates, SessionEnd, and preexisting cancellation", async () => {
		const { hub, callTool } = fixture()
		const signal = new AbortController().signal
		expect((await runLifecycleHookMcp(hook, event, signal)).failure).toBe("MCP server or tool is unavailable")
		expect(
			(await runLifecycleHookMcp({ ...hook, input: { key: "${missing}" } }, event, signal, { hub })).failure,
		).toBe("received an invalid MCP input template")
		expect(
			(
				await runLifecycleHookMcp(hook, { ...event, hook_event_name: "SessionEnd", reason: "other" }, signal, {
					hub,
				})
			).failure,
		).toContain("SessionEnd")
		const cancelled = new AbortController()
		cancelled.abort()
		expect((await runLifecycleHookMcp(hook, event, cancelled.signal, { hub })).failure).toBe("cancelled")
		expect(callTool).not.toHaveBeenCalled()
	})

	it("keeps tool errors advisory without exposing response or transport secrets", async () => {
		const { hub, callTool } = fixture({ isError: true, content: [{ type: "text", text: "SECRET=hidden" }] })
		const signal = new AbortController().signal
		expect(await runLifecycleHookMcp(hook, event, signal, { hub })).toEqual({
			exitCode: null,
			stdout: "",
			stderr: "",
			failure: "MCP tool returned an error",
		})
		callTool.mockRejectedValue(new Error("SECRET=hidden"))
		expect((await runLifecycleHookMcp(hook, event, signal, { hub })).failure).toBe("MCP call failed")
	})

	it("bounds output before joining text blocks", async () => {
		const { hub } = fixture({ content: [{ type: "text", text: "x".repeat(MAX_HOOK_OUTPUT_BYTES + 1) }] })
		expect((await runLifecycleHookMcp(hook, event, new AbortController().signal, { hub })).failure).toBe(
			"output limit exceeded",
		)
	})

	it("cancels promptly when a transport ignores its signal and drops late hook decisions", async () => {
		const { hub, callTool } = fixture()
		let settle!: (value: McpToolCallResponse) => void
		callTool.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
		const controller = new AbortController()
		const pending = runLifecycleHookMcp(hook, event, controller.signal, { hub })
		const callSignal = callTool.mock.calls[0][4]!
		controller.abort()
		expect(await pending).toMatchObject({ failure: "cancelled", stdout: "" })
		expect(callSignal.aborted).toBe(true)
		settle({ content: [{ type: "text", text: '{"decision":"block","reason":"late"}' }] })
		await Promise.resolve()
	})

	it("uses the hook deadline and clears its timer after a timed-out transport settles late", async () => {
		vi.useFakeTimers()
		const { hub, callTool } = fixture()
		let settle!: (value: McpToolCallResponse) => void
		callTool.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
		const pending = runLifecycleHookMcp({ ...hook, timeoutMs: 25 }, event, new AbortController().signal, { hub })
		await vi.advanceTimersByTimeAsync(25)
		expect(await pending).toMatchObject({ failure: "timed out", stdout: "" })
		expect(callTool.mock.calls[0][4]?.aborted).toBe(true)
		settle({ content: [] })
		await Promise.resolve()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("limits active execution to the shorter configured server deadline", async () => {
		vi.useFakeTimers()
		const { hub, callTool, getServers } = fixture()
		getServers.mockReturnValue([{ ...server, config: JSON.stringify({ timeout: 1 }) }])
		callTool.mockImplementation(() => new Promise(() => {}))
		const pending = runLifecycleHookMcp({ ...hook, timeoutMs: 5_000 }, event, new AbortController().signal, { hub })
		const settled = vi.fn()
		void pending.then(settled)
		await vi.advanceTimersByTimeAsync(999)
		expect(settled).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toMatchObject({ failure: "timed out" })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("pauses both hook and server active-time budgets during originating-task elicitation", async () => {
		vi.useFakeTimers()
		const { hub, callTool, getServers } = fixture()
		getServers.mockReturnValue([{ ...server, config: JSON.stringify({ timeout: 1 }) }])
		callTool.mockImplementation(() => new Promise(() => {}))
		let capturedOwner!: McpElicitationOwner
		let answer!: (value: string | undefined) => void
		const ask = vi.fn<McpElicitationOwner["ask"]>(() => new Promise((resolve) => (answer = resolve)))
		const withElicitation: NonNullable<LifecycleHookMcpHub["withElicitation"]> = async (
			_server,
			_source,
			owner,
			dispatch,
		) => {
			capturedOwner = owner
			return dispatch()
		}
		const signal = new AbortController().signal
		const pending = runLifecycleHookMcp({ ...hook, timeoutMs: 5_000 }, event, signal, {
			hub: { ...hub, withElicitation },
			elicitationOwner: { signal, ask },
		})
		const settled = vi.fn()
		void pending.then(settled)
		await vi.advanceTimersByTimeAsync(300)
		const question = capturedOwner.ask("Choose region", {}, signal)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(settled).not.toHaveBeenCalled()
		expect(callTool.mock.calls[0][4]?.aborted).toBe(false)
		answer("selected")
		expect(await question).toBe("selected")
		await vi.advanceTimersByTimeAsync(699)
		expect(settled).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toMatchObject({ failure: "timed out" })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("registers the originating task's elicitation owner on the selected connection", async () => {
		const { hub, callTool } = fixture()
		const ask = vi.fn(async () => undefined)
		const observed = vi.fn()
		const withElicitation: NonNullable<LifecycleHookMcpHub["withElicitation"]> = async (
			server,
			source,
			owner,
			dispatch,
		) => {
			observed(server, source, owner, dispatch)
			return dispatch()
		}
		expect(
			await runLifecycleHookMcp(hook, event, new AbortController().signal, {
				hub: { ...hub, withElicitation },
				elicitationOwner: { ask, signal: new AbortController().signal },
			}),
		).toMatchObject({ exitCode: 0 })
		expect(observed).toHaveBeenCalledWith(
			"scanner",
			"global",
			{ ask: expect.any(Function), signal: expect.any(AbortSignal) },
			expect.any(Function),
		)
		expect(callTool).toHaveBeenCalledOnce()
		expect(ask).not.toHaveBeenCalled()
	})
})
