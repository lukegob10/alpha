import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ToolApprovalDecision } from "@alpha-code/types"

import type { AgentToolCall } from "../AgentResponse"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../ToolScheduler"
import { createToolPolicySnapshot, type ToolPolicyInput } from "../ToolPolicy"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { clearTaskSessionApprovalGrants } from "../../auto-approval/taskSessionApprovalGrants"

const patch = "*** Begin Patch\n*** Add File: fixture.txt\n+must not write\n*** End Patch"

afterEach(() => clearTaskSessionApprovalGrants("policy-denial-status"))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function fixture() {
	const events: AgentTurnEvent[] = []
	const host: ToolExecutionHost = {
		taskId: "policy-denial-status",
		cwd: path.resolve(process.cwd()),
		userMessageContent: [],
		askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			if (host.hasToolResultForCall?.(result.tool_use_id)) return false
			host.userMessageContent.push(result)
			return true
		},
		hasToolResultForCall: (callId) =>
			host.userMessageContent.some((item) => item.type === "tool_result" && item.tool_use_id === callId),
	}
	const execute = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
		callbacks.pushToolResult("executed")
	})
	const registry = new ToolRegistry({ includeBuiltIns: false })
	for (const name of ["read_file", "write_to_file", "apply_patch", "exec_command"]) {
		registry.register({
			name,
			aliases: [],
			schema: { type: "function", function: { name, parameters: { type: "object" } } },
			capabilities: {
				concurrency: "serial",
				sideEffects: name === "read_file" ? "none" : "workspace",
				controlFlow: false,
				requiresApproval: false,
			},
			execute,
		})
	}
	const onEffectStart = vi.fn(async () => {})
	const run = (calls: AgentToolCall[], options: Partial<ToolSchedulerOptions> = {}) =>
		new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
			onEffectStart,
			onEvent: (event) => {
				events.push(event)
			},
			...options,
		}).run(calls)
	return { host, registry, execute, onEffectStart, events, run }
}

interface DenialCase {
	name: string
	tool: string
	argumentsValue: Record<string, unknown>
	policy?: ToolPolicyInput
	mode?: string
	disabledTools?: string[]
	realValidation?: boolean
	scope: "capability" | "workspace"
}

const denials: DenialCase[] = [
	{
		name: "hidden captured tool",
		tool: "read_file",
		argumentsValue: { path: "proof.txt" },
		policy: { visibleTools: [] },
		scope: "capability",
	},
	{
		name: "disallowed captured tool",
		tool: "read_file",
		argumentsValue: { path: "proof.txt" },
		policy: { visibleTools: ["read_file"], allowedTools: [] },
		scope: "capability",
	},
	{
		name: "disabled captured tool",
		tool: "read_file",
		argumentsValue: { path: "proof.txt" },
		policy: { visibleTools: ["read_file"], disabledTools: ["read_file"] },
		scope: "capability",
	},
	{
		name: "disabled adapter tool",
		tool: "apply_patch",
		argumentsValue: { patch },
		disabledTools: ["apply_patch"],
		realValidation: true,
		scope: "capability",
	},
	{
		name: "outside workspace file",
		tool: "read_file",
		argumentsValue: { path: "../outside/proof.txt" },
		scope: "workspace",
	},
	{
		name: "outside workspace command cwd",
		tool: "exec_command",
		argumentsValue: { cmd: "pwd", workdir: ".." },
		scope: "workspace",
	},
	{
		name: "Plan mutation",
		tool: "apply_patch",
		argumentsValue: { patch },
		mode: "architect",
		realValidation: true,
		scope: "capability",
	},
	{
		name: "shell patch denied by captured tool surface",
		tool: "exec_command",
		argumentsValue: { cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH` },
		policy: { visibleTools: ["exec_command"] },
		scope: "capability",
	},
]

describe("ToolScheduler policy denial status", () => {
	it.each(denials)("publishes one denied receipt for $name without starting an effect", async (testCase) => {
		const { host, execute, onEffectStart, events, run } = fixture()
		const call: AgentToolCall = {
			type: "tool_call",
			id: "policy-denied",
			name: testCase.tool,
			arguments: testCase.argumentsValue,
		}
		const outcome = await run([call], {
			mode: testCase.mode ?? "code",
			disabledTools: testCase.disabledTools,
			...(testCase.realValidation ? { validateCall: undefined } : {}),
			policy: createToolPolicySnapshot({
				visibleTools: [testCase.tool],
				execution: { workspaceRoots: [host.cwd!] },
				...testCase.policy,
			}),
		})

		expect(outcome.status).toBe("completed")
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({
			callId: call.id,
			name: call.name,
			status: "denied",
			failure: {
				reason: "policy_denied",
				affectedScope: { kind: testCase.scope },
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: "user-action" },
			},
		})
		expect(JSON.parse(String(outcome.results[0].content))).toMatchObject({ status: "denied" })
		expect(events.filter((event) => event.type === "tool_result")).toEqual([
			expect.objectContaining({ callId: call.id, status: "denied" }),
		])
		expect(host.userMessageContent).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: call.id, is_error: true }),
		])
		expect(host.userMessageContentReady).toBe(true)
		expect(host.askApproval).not.toHaveBeenCalled()
		expect(host.recordToolUsage).not.toHaveBeenCalled()
		expect(onEffectStart).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	})

	it("keeps unavailable tools and malformed arguments as errors", async () => {
		const { execute, run } = fixture()
		const unavailable = await run([{ type: "tool_call", id: "missing", name: "missing_tool", arguments: {} }])
		expect(unavailable.results[0]).toMatchObject({
			status: "error",
			failure: { reason: "capability_unavailable", effectsStarted: "no" },
		})
		const malformed = await run([{ type: "tool_call", id: "malformed", name: "read_file", arguments: null }])
		expect(malformed.results[0]).toMatchObject({
			status: "error",
			failure: { reason: "invalid_arguments", effectsStarted: "no" },
		})
		expect(execute).not.toHaveBeenCalled()
	})

	it("keeps an executor fault as an error", async () => {
		const { execute, run } = fixture()
		execute.mockRejectedValueOnce(new Error("fixture executor failed"))
		const outcome = await run([
			{ type: "tool_call", id: "executor-error", name: "read_file", arguments: { path: "proof.txt" } },
		])
		expect(outcome.results[0]).toMatchObject({ status: "error", failure: { reason: "execution_failed" } })
		expect(execute).toHaveBeenCalledOnce()
	})

	it("retains a settled denial and closes its undispatched sibling once when cancellation arrives", async () => {
		const { host, execute, onEffectStart, events, run } = fixture()
		const controller = new AbortController()
		host.recordToolCallForStopping = (_name, _args, status) => {
			if (status === "denied") controller.abort(new Error("Stop after policy denial"))
		}
		const outcome = await run(
			[
				{ type: "tool_call", id: "denied-first", name: "read_file", arguments: { path: "proof.txt" } },
				{ type: "tool_call", id: "cancelled-next", name: "write_to_file", arguments: { path: "later.txt" } },
			],
			{
				policy: createToolPolicySnapshot({ visibleTools: ["write_to_file"] }),
				signal: controller.signal,
				preserveAbortedResults: true,
			},
		)

		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map(({ callId, status }) => ({ callId, status }))).toEqual([
			{ callId: "denied-first", status: "denied" },
			{ callId: "cancelled-next", status: "cancelled" },
		])
		expect(host.userMessageContent.filter((item) => item.type === "tool_result")).toHaveLength(2)
		expect(events.filter((event) => event.type === "tool_result").map(({ callId }) => callId)).toEqual([
			"denied-first",
			"cancelled-next",
		])
		expect(execute).not.toHaveBeenCalled()
		expect(onEffectStart).not.toHaveBeenCalled()
	})

	it("does not duplicate a denied provider-history receipt when an accepted call is replayed", async () => {
		const { host, execute, run } = fixture()
		const call: AgentToolCall = { type: "tool_call", id: "denial-replay", name: "read_file", arguments: {} }
		const options = { policy: createToolPolicySnapshot({ visibleTools: [] }) }
		await run([call], options)
		await run([call], options)

		expect(host.userMessageContent).toHaveLength(1)
		expect(host.userMessageContent[0]).toMatchObject({ tool_use_id: call.id, is_error: true })
		expect(execute).not.toHaveBeenCalled()
	})

	it.each([
		{ decision: "approve_once" as const, reviews: 2 },
		{ decision: "approve_session" as const, reviews: 1 },
	])(
		"preserves explicit $decision grants independently of the global review ceiling",
		async ({ decision, reviews }) => {
			const { host, registry, run } = fixture()
			const effect = vi.fn(async () => "MCP completed")
			host.requestToolApproval = vi.fn(async () => ({ decision }))
			registry.register({
				name: "mcp--fixture--lookup",
				aliases: [],
				schema: {
					type: "function",
					function: { name: "mcp--fixture--lookup", parameters: { type: "object" } },
				},
				capabilities: {
					concurrency: "serial",
					sideEffects: "external",
					controlFlow: false,
					requiresApproval: true,
				},
				execute: async ({ callbacks }) => {
					if (await callbacks.askApproval("use_mcp_server", "fixture lookup")) {
						callbacks.pushToolResult(await effect())
					}
				},
			})
			const options = {
				policy: createToolPolicySnapshot({
					visibleTools: ["mcp--fixture--lookup"],
					approvalMode: "auto",
					reviewPolicy: { protectedWriteAllowed: false, mcp: { enabled: false, grants: [] } },
				}),
			}
			for (const id of ["first-explicit", "second-explicit"]) {
				const outcome = await run(
					[{ type: "tool_call", id, name: "mcp--fixture--lookup", arguments: {} }],
					options,
				)
				expect(outcome.results[0].status).toBe("success")
			}
			expect(host.requestToolApproval).toHaveBeenCalledTimes(reviews)
			expect(effect).toHaveBeenCalledTimes(2)
		},
	)

	it("does not execute or retain a session grant when cancellation beats a late explicit approval", async () => {
		const { host, registry, onEffectStart, run } = fixture()
		const approvalEntered = deferred<void>()
		const approval = deferred<ToolApprovalDecision>()
		const controller = new AbortController()
		const effect = vi.fn(async () => "MCP completed")
		host.requestToolApproval = vi.fn(async () => {
			approvalEntered.resolve()
			return approval.promise
		})
		registry.register({
			name: "mcp--fixture--late",
			aliases: [],
			schema: { type: "function", function: { name: "mcp--fixture--late", parameters: { type: "object" } } },
			capabilities: {
				concurrency: "serial",
				sideEffects: "external",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: async ({ callbacks }) => {
				if (await callbacks.askApproval("use_mcp_server", "fixture late")) {
					callbacks.pushToolResult(await effect())
				}
			},
		})
		const policy = createToolPolicySnapshot({ visibleTools: ["mcp--fixture--late"] })
		const running = run([{ type: "tool_call", id: "late-first", name: "mcp--fixture--late", arguments: {} }], {
			policy,
			signal: controller.signal,
			preserveAbortedResults: true,
		})
		await approvalEntered.promise
		controller.abort(new Error("Stop before approval"))
		approval.resolve({ decision: "approve_session" })
		const cancelled = await running

		expect(cancelled.results[0].status).toBe("cancelled")
		expect(effect).not.toHaveBeenCalled()
		expect(onEffectStart).not.toHaveBeenCalled()
		host.requestToolApproval = vi.fn(async () => ({ decision: "deny" as const }))
		const next = await run([{ type: "tool_call", id: "late-next", name: "mcp--fixture--late", arguments: {} }], {
			policy,
		})
		expect(host.requestToolApproval).toHaveBeenCalledOnce()
		expect(next.results[0].status).toBe("denied")
		expect(effect).not.toHaveBeenCalled()
	})
})
