import { getNativeTools } from "../../prompts/tools/native-tools"
import { cancelAgentTool } from "../CancelAgentTool"
import { closeAgentTool } from "../CloseAgentTool"
import { followupTaskTool } from "../FollowupTaskTool"
import { interruptAgentTool } from "../InterruptAgentTool"
import { listAgentsTool } from "../ListAgentsTool"
import { sendMessageTool } from "../SendMessageTool"
import { waitAgentTool } from "../WaitAgentTool"

const lifecycleNames = [
	"list_agents",
	"wait_agent",
	"send_message",
	"followup_task",
	"interrupt_agent",
	"cancel_agent",
	"close_agent",
] as const

function harness() {
	const provider = {
		listAgents: vi.fn(async () => ({ agents: [] })),
		waitForAgent: vi.fn(async () => ({ timedOut: true, events: [] })),
		sendMessageToAgent: vi.fn(async () => ({ status: "running" })),
		followupAgentTask: vi.fn(async () => ({ status: "pending" })),
		interruptAgent: vi.fn(async () => ({ status: "cancelling" })),
		cancelAgent: vi.fn(async () => ({ status: "cancelling" })),
		closeAgent: vi.fn(async () => ({ status: "completed" })),
	}
	const task = {
		providerRef: { deref: () => provider },
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
	} as any
	const askApproval = vi.fn()
	const pushToolResult = vi.fn()
	return {
		provider,
		task,
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
	})

	it("dispatches every operation without asking for approval", async () => {
		const { provider, task, callbacks, pushToolResult, askApproval } = harness()

		await listAgentsTool.execute({ path_prefix: "/root/review" }, task, callbacks)
		await waitAgentTool.execute({}, task, callbacks)
		await sendMessageTool.execute({ target: "/root/review", message: "Check this." }, task, callbacks)
		await followupTaskTool.execute({ target: "child-1", message: "Continue." }, task, callbacks)
		await interruptAgentTool.execute({ target: "child-1" }, task, callbacks)
		await cancelAgentTool.execute({ target: "child-1", reason: "Stop." }, task, callbacks)
		await closeAgentTool.execute({ target: "child-1" }, task, callbacks)

		expect(provider.listAgents).toHaveBeenCalledWith(task, "/root/review")
		expect(provider.waitForAgent).toHaveBeenCalledWith(task, 30_000)
		expect(provider.sendMessageToAgent).toHaveBeenCalledWith(task, "/root/review", "Check this.")
		expect(provider.followupAgentTask).toHaveBeenCalledWith(task, "child-1", "Continue.")
		expect(provider.interruptAgent).toHaveBeenCalledWith(task, "child-1")
		expect(provider.cancelAgent).toHaveBeenCalledWith(task, "child-1", "Stop.")
		expect(provider.closeAgent).toHaveBeenCalledWith(task, "child-1")
		expect(pushToolResult).toHaveBeenCalledTimes(7)
		expect(askApproval).not.toHaveBeenCalled()
	})

	it("rejects invalid inputs before calling the provider", async () => {
		const { provider, task, callbacks, pushToolResult } = harness()

		await sendMessageTool.execute({ target: "/root/Review", message: "Check this." }, task, callbacks)
		await waitAgentTool.execute({ timeout_ms: 9_999 }, task, callbacks)

		expect(provider.sendMessageToAgent).not.toHaveBeenCalled()
		expect(provider.waitForAgent).not.toHaveBeenCalled()
		expect(task.recordToolError).toHaveBeenCalledTimes(2)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("canonical agent path"))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("timeout_ms"))
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})
})
