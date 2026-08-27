import { getNativeTools } from "../../prompts/tools/native-tools"
import { cancelAgentTool } from "../CancelAgentTool"
import { closeAgentTool } from "../CloseAgentTool"
import { followupTaskTool } from "../FollowupTaskTool"
import { interruptAgentTool } from "../InterruptAgentTool"
import { listAgentsTool } from "../ListAgentsTool"
import { reportProgressTool } from "../ReportProgressTool"
import { sendMessageTool } from "../SendMessageTool"
import { waitAgentTool } from "../WaitAgentTool"

const lifecycleNames = [
	"list_agents",
	"wait_agent",
	"send_message",
	"report_progress",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
] as const

function harness() {
	const provider = {
		listAgents: vi.fn(async () => ({ agents: [] })),
		waitForAgent: vi.fn(async (): Promise<unknown> => ({ timedOut: true, events: [] })),
		sendMessageToAgent: vi.fn(async () => ({ status: "running" })),
		reportAgentProgress: vi.fn(async () => ({ delivery: "queued" })),
		followupAgentTask: vi.fn(async () => ({ status: "pending" })),
		interruptAgent: vi.fn(async () => ({ status: "cancelling" })),
		cancelAgent: vi.fn(async () => ({ status: "cancelling" })),
		closeAgent: vi.fn(async () => ({ status: "completed" })),
	}
	const say = vi.fn(async (..._args: unknown[]) => undefined)
	const task = {
		providerRef: { deref: () => provider },
		recordToolError: vi.fn(),
		retainWaitAgentResultClaim: vi.fn(),
		say,
		didToolFailInCurrentTurn: false,
	} as any
	const askApproval = vi.fn()
	const pushToolResult = vi.fn()
	return {
		provider,
		task,
		say,
		askApproval: askApproval,
		pushToolResult,
		callbacks: {
			askApproval: askApproval,
			pushToolResult,
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
		} as any,
	}
}

describe("agent lifecycle tools", () => {
	it("publish strict native schemas", () => {
		const definitions = getNativeTools().flatMap((tool) =>
			tool.type === "function" && lifecycleNames.includes(tool.function.name as any) ? [tool.function] : [],
		)

		expect(definitions.map((definition) => definition.name)).toEqual(lifecycleNames)
		for (const definition of definitions) {
			expect(definition.strict).toBe(true)
			expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false })
		}
		expect(definitions.find((definition) => definition.name === "report_progress")?.parameters).toMatchObject({
			required: ["message"],
			properties: { message: { type: "string", minLength: 1, maxLength: 2_000 } },
		})
		expect(definitions.find((definition) => definition.name === "wait_agent")?.parameters).toMatchObject({
			required: ["timeout_ms", "target", "until_terminal"],
			properties: {
				target: expect.any(Object),
				until_terminal: expect.any(Object),
			},
		})
	})

	it("dispatches every operation without asking for approval", async () => {
		const { provider, task, say, callbacks, pushToolResult, askApproval } = harness()

		await listAgentsTool.execute({ path_prefix: "/root/review" }, task, callbacks)
		await waitAgentTool.execute({}, task, callbacks)
		await sendMessageTool.execute({ target: "/root/review", message: "Check this." }, task, callbacks)
		await reportProgressTool.execute({ message: "Halfway through." }, task, callbacks)
		await followupTaskTool.execute({ target: "child-1", message: "Continue." }, task, callbacks)
		await interruptAgentTool.execute({ target: "child-1" }, task, callbacks)
		await cancelAgentTool.execute({ target: "child-1", reason: "Stop." }, task, callbacks)
		await closeAgentTool.execute({ target: "child-1" }, task, callbacks)

		expect(provider.listAgents).toHaveBeenCalledWith(task, "/root/review")
		expect(provider.waitForAgent).toHaveBeenCalledWith(task, 30_000)
		expect(provider.sendMessageToAgent).toHaveBeenCalledWith(task, "/root/review", "Check this.")
		expect(provider.reportAgentProgress).toHaveBeenCalledWith(task, "Halfway through.")
		expect(provider.followupAgentTask).toHaveBeenCalledWith(task, "child-1", "Continue.")
		expect(provider.interruptAgent).toHaveBeenCalledWith(task, "child-1")
		expect(provider.cancelAgent).toHaveBeenCalledWith(task, "child-1", "Stop.")
		expect(provider.closeAgent).toHaveBeenCalledWith(task, "child-1")
		expect(pushToolResult).toHaveBeenCalledTimes(8)
		expect(askApproval).not.toHaveBeenCalled()
		expect(say).toHaveBeenCalledTimes(4)

		const presentations = say.mock.calls.map((call) => ({
			payload: JSON.parse(call[1] as string),
			partial: call[3],
		}))
		expect(presentations).toEqual([
			{
				payload: expect.objectContaining({
					tool: "agentLifecycle",
					agentAction: "list_agents",
					lifecycleStatus: "running",
				}),
				partial: true,
			},
			{
				payload: expect.objectContaining({
					tool: "agentLifecycle",
					agentAction: "list_agents",
					lifecycleStatus: "completed",
					agentCount: 0,
				}),
				partial: false,
			},
			{
				payload: expect.objectContaining({
					tool: "agentLifecycle",
					agentAction: "wait_agent",
					lifecycleStatus: "running",
				}),
				partial: true,
			},
			{
				payload: expect.objectContaining({
					tool: "agentLifecycle",
					agentAction: "wait_agent",
					lifecycleStatus: "completed",
					timedOut: true,
					eventCount: 0,
				}),
				partial: false,
			},
		])
	})

	it("shows the wait state before the blocking provider operation resolves", async () => {
		const { provider, task, say, callbacks } = harness()
		let resolveWait!: (value: unknown) => void
		provider.waitForAgent.mockImplementationOnce(() => new Promise((resolve) => (resolveWait = resolve)))

		const execution = waitAgentTool.execute({ timeout_ms: 120_000 }, task, callbacks)
		await vi.waitFor(() => expect(provider.waitForAgent).toHaveBeenCalledTimes(1))
		expect(say).toHaveBeenCalledTimes(1)
		expect(JSON.parse(say.mock.calls[0][1] as string)).toMatchObject({
			tool: "agentLifecycle",
			agentAction: "wait_agent",
			lifecycleStatus: "running",
		})

		resolveWait({ timedOut: false, events: [], alreadyDelivered: true })
		await execution
		expect(JSON.parse(say.mock.calls[1][1] as string)).toMatchObject({
			lifecycleStatus: "completed",
			alreadyDelivered: true,
		})
	})

	it("surfaces an empty agent tree as an immediate completed wait", async () => {
		const { provider, task, say, callbacks, pushToolResult } = harness()
		provider.waitForAgent.mockResolvedValueOnce({ timedOut: false, noActiveAgents: true, events: [] })

		await waitAgentTool.execute({ timeout_ms: 120_000 }, task, callbacks)

		expect(pushToolResult).toHaveBeenCalledWith(
			JSON.stringify({ timedOut: false, noActiveAgents: true, events: [] }),
		)
		expect(JSON.parse(say.mock.calls[1][1] as string)).toMatchObject({
			agentAction: "wait_agent",
			lifecycleStatus: "completed",
			noActiveAgents: true,
			eventCount: 0,
		})
	})

	it("retains a native wait claim under the tool call ID before returning its provenance envelope", async () => {
		const { provider, task, callbacks, pushToolResult } = harness()
		callbacks.toolCallId = "call-native-wait"
		const nativeResult = {
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: "claim-native-wait",
			events: [
				{
					eventId: "event-child-failed",
					sequence: 7,
					kind: "result",
					name: "agent_failed",
					senderTaskId: "child-failed",
					senderPath: "/root/child_failed",
					payload: {
						taskId: "child-failed",
						status: "failed",
						summary: "The review failed.",
						stopReason: "runtime_error",
					},
				},
			],
		}
		provider.waitForAgent.mockResolvedValueOnce(nativeResult)

		await waitAgentTool.execute({ timeout_ms: 10_000 }, task, callbacks)

		expect(task.retainWaitAgentResultClaim).toHaveBeenCalledWith("call-native-wait", "claim-native-wait")
		expect(pushToolResult).toHaveBeenCalledWith(JSON.stringify(nativeResult))
		expect(task.retainWaitAgentResultClaim.mock.invocationCallOrder[0]).toBeLessThan(
			pushToolResult.mock.invocationCallOrder[0],
		)
	})

	it("dispatches a targeted terminal wait without changing legacy wait calls", async () => {
		const { provider, task, callbacks } = harness()

		await waitAgentTool.execute(
			{ timeout_ms: 120_000, target: "/root/review", until_terminal: true },
			task,
			callbacks,
		)

		expect(provider.waitForAgent).toHaveBeenCalledWith(task, 120_000, {
			target: "/root/review",
			untilTerminal: true,
		})
	})

	it("replaces the in-progress row with an observable provider error", async () => {
		const { provider, task, say, callbacks, pushToolResult } = harness()
		provider.listAgents.mockRejectedValueOnce(new Error("Registry unavailable"))

		await listAgentsTool.execute({}, task, callbacks)

		expect(say).toHaveBeenCalledTimes(2)
		expect(JSON.parse(say.mock.calls[1][1] as string)).toMatchObject({
			tool: "agentLifecycle",
			agentAction: "list_agents",
			lifecycleStatus: "error",
			content: "Registry unavailable",
		})
		expect(pushToolResult).toHaveBeenCalledWith(JSON.stringify({ error: "Registry unavailable" }))
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("rejects invalid inputs before calling the provider", async () => {
		const { provider, task, callbacks, pushToolResult } = harness()

		await sendMessageTool.execute({ target: "/root/Review", message: "Check this." }, task, callbacks)
		await reportProgressTool.execute({ message: "x".repeat(2_001) }, task, callbacks)
		await waitAgentTool.execute({ timeout_ms: 9_999 }, task, callbacks)
		await waitAgentTool.execute({ target: "/root/review" }, task, callbacks)

		expect(provider.sendMessageToAgent).not.toHaveBeenCalled()
		expect(provider.reportAgentProgress).not.toHaveBeenCalled()
		expect(provider.waitForAgent).not.toHaveBeenCalled()
		expect(task.recordToolError).toHaveBeenCalledTimes(4)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("canonical agent path"))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("2,000 characters"))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("timeout_ms"))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("until_terminal"))
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})
})
