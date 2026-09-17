import { AgentTurnEngine, type AgentTurnHost } from "../../agent/AgentTurnEngine"
import type { AgentToolCall } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task } from "../Task"

function harness(taskKind: "primary" | "subagent", executionMode: "serial" | "selective-parallel") {
	const detector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })
	const provider = {
		waitForAgent: vi.fn(async (): Promise<unknown> => ({ timedOut: false, noActiveAgents: true, events: [] })),
		getVerificationProgressState: () => ({ stateFingerprint: "unchanged-workspace" }),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskKind,
		workspacePath: "/workspace",
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		commandExecutionEvidence: new Map(),
		toolRepetitionDetector: detector,
		userMessageContent: [],
		providerRef: { deref: () => provider },
		say: vi.fn(async () => {}),
		retainWaitAgentResultClaim: vi.fn(),
	}) as Task
	const host: ToolExecutionHost = {
		taskId: "wait-progress",
		cwd: "/workspace",
		taskFacade: task,
		userMessageContent: [],
		say: async () => {},
		recordToolUsage: () => {},
		recordToolCallForStopping: task.recordToolCallForStopping.bind(task),
		shouldStopRepeatedToolCall: task.shouldStopRepeatedToolCall.bind(task),
		pushToolResultToUserContent(result) {
			if (
				host.userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			)
				return false
			host.userMessageContent.push(result)
			return true
		},
	}
	const run = (index: number) => {
		const call: AgentToolCall = {
			type: "tool_call",
			id: `wait-${index}`,
			name: "wait_agent",
			arguments: { timeout_ms: 10_000 + index, target: null, until_terminal: null },
		}
		return new ToolScheduler({
			executionHost: host,
			registry: new ToolRegistry(),
			mode: "code",
			executionMode,
		}).run([call])
	}
	return { task, provider, host, detector, run }
}

describe.each(["serial", "selective-parallel"] as const)("managed wait progress in %s mode", (mode) => {
	it.each(["command", "completion"] as const)(
		"bounds a stuck %s evidence publisher while observing tool results",
		async (publisher) => {
			vi.useFakeTimers()
			const { task } = harness("primary", mode)
			if (publisher === "command") Reflect.set(task, "pendingCommandVerification", new Promise(() => {}))
			else {
				Reflect.set(task, "completionRecoveryActive", true)
				vi.spyOn(task, "getCompletionGateDecision").mockImplementation(() => new Promise(() => {}))
			}
			let settled = false
			const run = task.recordToolCallForStopping("read_file", { path: "file.ts" }, "success").then(() => {
				settled = true
			})
			try {
				await vi.advanceTimersByTimeAsync(31_000)
				expect(settled).toBe(true)
				expect(task.shouldStopRepeatedToolCall("read_file", {})).toBe(true)
			} finally {
				Reflect.get(task, "taskCancellationController").abort()
				await run
				vi.useRealTimers()
			}
		},
	)

	it.each(["primary", "subagent"] as const)(
		"allows distinct MCP exchanges and bounds unchanged results for %s",
		async (surface) => {
			const { task, provider, host } = harness(surface, mode)
			const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }))
			Object.assign(provider, {
				getMcpHub: () => ({
					getAllServers: () => [{ name: "external", tools: [{ name: "operation" }] }],
					callTool,
				}),
				postMessageToWebview: async () => {},
			})
			host.askApproval = async () => ({ response: "yesButtonClicked" })
			const scheduler = new ToolScheduler({
				executionHost: host,
				registry: new ToolRegistry(),
				mode: "code",
				executionMode: mode,
				validateCall: () => {},
			})
			const run = (index: number, id: number) =>
				scheduler.run([
					{
						type: "tool_call",
						id: `mcp-${index}`,
						name: "use_mcp_tool",
						arguments: { server_name: "external", tool_name: "operation", arguments: { id } },
					},
				])
			for (let index = 0; index < 20; index++) {
				const result = (await run(index, index)).results[0]
				expect(result.status).toBe("success")
				expect(result.trustedProgress).toBeUndefined()
				expect(result.opaqueResultFingerprint).toMatch(/^[a-f0-9]{64}$/)
			}
			expect(task.shouldStopRepeatedToolCall("use_mcp_tool", {})).toBe(false)
			for (let index = 20; index < 24; index++) await run(index, 19)
			expect(task.shouldStopRepeatedToolCall("use_mcp_tool", {})).toBe(true)
			expect(callTool).toHaveBeenCalledTimes(24)
			expect(host.userMessageContent).toHaveLength(24)
			expect(Reflect.get(task, "userMessageContent")).toEqual([
				{ type: "text", text: expect.stringContaining("external calls returned unchanged results") },
			])
		},
	)

	it.each([false, true])(
		"bounds nonblocking command reads while a command runs (completion recovery: %s)",
		async (recovery) => {
			const { task } = harness("primary", mode)
			Reflect.set(
				task,
				"commandExecutionEvidence",
				new Map([["command", { status: "running", executionId: "123:call" }]]),
			)
			if (recovery) {
				Reflect.set(task, "completionRecoveryActive", true)
				vi.spyOn(task, "getCompletionGateDecision").mockResolvedValue({
					allowed: false,
					classification: "waiting",
					reasonCode: "command_running",
					modelCanResolveRejection: false,
				})
			}
			for (let index = 0; index < 5; index++) {
				await task.recordToolCallForStopping(
					"read_command_output",
					{ artifact_id: "cmd-123.txt" },
					"success",
					undefined,
					{
						callId: `read-${index}`,
						name: "read_command_output",
						status: "success",
						content: "same output",
						durationMs: 0,
						trustedProgress: { kind: "read", scope: "cmd-123.txt", stateFingerprint: "unchanged" },
					},
				)
			}
			expect(task.shouldStopRepeatedToolCall("read_command_output", {})).toBe(true)
		},
	)

	it.each(["primary", "subagent"] as const)("bounds empty %s waits within four model steps", async (surface) => {
		const { task, provider, host, run } = harness(surface, mode)
		const turnHost: AgentTurnHost<number> = {
			shouldAbort: () => false,
			runStep: vi.fn<AgentTurnHost<number>["runStep"]>(async (step) => {
				await run(step)
				return {
					response: {
						items: [],
						toolCalls: [{ type: "tool_call", id: `wait-${step}`, name: "wait_agent", arguments: {} }],
						text: "",
						reasoning: "",
					},
					nextInput: step + 1,
					...(task.shouldStopRepeatedToolCall("wait_agent", {})
						? { status: "incomplete" as const }
						: step === 19
							? { status: "exhausted" as const }
							: {}),
				}
			}),
		}
		expect(await new AgentTurnEngine(turnHost).run(0)).toMatchObject({ status: "incomplete", steps: 4 })
		expect(provider.waitForAgent).toHaveBeenCalledTimes(4)
		expect(host.userMessageContent).toHaveLength(4)
		expect(Reflect.get(task, "userMessageContent")).toEqual([
			{ type: "text", text: expect.stringContaining("Use available child results or continue other work") },
		])
	})

	it.each(["timeout", "mailbox"] as const)(
		"allows repeated %s results without clearing an existing strike",
		async (kind) => {
			const { task, provider, detector, run } = harness("primary", mode)
			await task.recordToolCallForStopping("execute_command", { command: "same-check" }, "success")
			provider.waitForAgent.mockImplementation(async () =>
				kind === "timeout"
					? { timedOut: true, events: [] }
					: {
							timedOut: false,
							source: "managed_agent_mailbox",
							claimId: `claim-${provider.waitForAgent.mock.calls.length}`,
							events: [{ eventId: `event-${provider.waitForAgent.mock.calls.length}`, kind: "result" }],
						},
			)
			for (let index = 0; index < 20; index++) expect((await run(index)).results[0].status).toBe("success")
			expect(task.shouldStopRepeatedToolCall("wait_agent", {})).toBe(false)
			expect(
				detector.recordOutcome({ toolName: "execute_command", kind: "check", status: "success" }),
			).toMatchObject({ action: "change-strategy", stagnantCalls: 2 })
		},
	)

	it.each(["already-delivered", "unknown"] as const)("does not exempt %s wait responses", async (kind) => {
		const { task, provider, run } = harness("primary", mode)
		provider.waitForAgent.mockResolvedValue(
			kind === "already-delivered"
				? { timedOut: false, alreadyDelivered: true, events: [] }
				: { message: "still working", active: true },
		)
		for (let index = 0; index < 4; index++) await run(index)
		expect(task.shouldStopRepeatedToolCall("wait_agent", {})).toBe(true)
	})

	it("keeps a cancelled host wait cancelled through the scheduler", async () => {
		const { provider, run } = harness("primary", mode)
		provider.waitForAgent.mockResolvedValue({ timedOut: false, cancelled: true, events: [] })
		expect((await run(0)).results[0].status).toBe("cancelled")
	})

	it.each(["active", "idle"] as const)(
		"distinguishes %s waits while completion is waiting on a different child",
		async (outcome) => {
			const { task, provider, run } = harness("primary", mode)
			Reflect.set(task, "completionRecoveryActive", true)
			vi.spyOn(task, "getCompletionGateDecision").mockResolvedValue({
				allowed: false,
				classification: "waiting",
				reasonCode: "descendants_running",
				modelCanResolveRejection: false,
			})
			if (outcome === "active") provider.waitForAgent.mockResolvedValue({ timedOut: true, events: [] })
			for (let index = 0; index < 4; index++) await run(index)
			expect(task.shouldStopRepeatedToolCall("wait_agent", {})).toBe(outcome === "idle")
			expect(Reflect.get(task, "completionRecoveryActive")).toBe(true)
		},
	)

	it("lets useful work recover from the idle-wait warning without another warning on active waits", async () => {
		const { task, provider, run } = harness("primary", mode)
		await run(0)
		await run(1)
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
		await task.recordToolCallForStopping("read_file", { path: "relevant-result.ts" }, "success")
		provider.waitForAgent.mockResolvedValue({ timedOut: true, events: [] })
		for (let index = 2; index < 22; index++) await run(index)
		expect(task.shouldStopRepeatedToolCall("wait_agent", {})).toBe(false)
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})
})
