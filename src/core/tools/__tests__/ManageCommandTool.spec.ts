import { EventEmitter } from "events"
import { manageCommandTool, waitForCommand } from "../ManageCommandTool"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { Task } from "../../task/Task"

function harness() {
	const process = Object.assign(new EventEmitter(), {
		executionId: "execution",
		isSettled: false,
		hasUnretrievedOutput: vi.fn(() => false),
		abort: vi.fn(),
		writeInput: vi.fn(),
		captureUnretrievedOutput: vi.fn(() => ({
			output: "ready at http://localhost:1234",
			commit: vi.fn(),
			release: vi.fn(),
		})),
	}) as unknown as AlphaTerminalProcess
	const terminal = { taskId: "task", process, running: true }
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const task = {
		taskId: "task",
		getCommandExecutionEvidence: () => [{ executionId: "execution", status: "running" }],
		providerRef: {
			deref: () => ({
				runWorkspaceMutation: async (_task: unknown, _name: string, run: () => Promise<void>) => run(),
			}),
		},
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
	}
	return { process, terminal, task, callbacks }
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

it("waits inside the host for output, then removes listeners", async () => {
	const { process } = harness()
	const waiting = waitForCommand(process, 30_000)
	expect(process.listenerCount("output_available")).toBe(1)
	process.emit("output_available")
	await waiting
	expect(process.listenerCount("output_available")).toBe(0)
	expect(process.listenerCount("completed")).toBe(0)
})

it.each(["timeout", "cancel", "completed", "error"])("cleans up a %s wait", async (cause) => {
	vi.useFakeTimers()
	const { process } = harness()
	const controller = new AbortController()
	const waiting = waitForCommand(process, 50, controller.signal).catch((error: unknown) => error)
	if (cause === "timeout") await vi.advanceTimersByTimeAsync(50)
	else if (cause === "cancel") controller.abort(new Error("cancelled"))
	else if (cause === "error") process.emit("error", new Error("failed"))
	else process.emit("completed")
	const result = await waiting
	if (cause === "cancel") expect(result).toEqual(new Error("cancelled"))
	expect(process.listenerCount("output_available")).toBe(0)
	expect(vi.getTimerCount()).toBe(0)
})

it("does not require a model poll or approval for a bounded wait", async () => {
	const { task, callbacks } = harness()
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 0 }, task, callbacks)
	expect(callbacks.askApproval).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'))
})

it("accepts long managed-command waits within the host limit", async () => {
	const { task, callbacks, process } = harness()
	process.hasUnretrievedOutput = vi.fn(() => true)
	await manageCommandTool.execute({ execution_id: "execution", action: "wait", timeout_ms: 300_000 }, task, callbacks)
	expect(callbacks.handleError).not.toHaveBeenCalled()
	expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"running"'))
})

it("cannot operate another task's command", async () => {
	const { task, callbacks, process } = harness()
	await manageCommandTool.execute({ execution_id: "other", action: "stop" }, task, callbacks)
	expect(callbacks.handleError).toHaveBeenCalled()
	expect(process.abort).not.toHaveBeenCalled()
})

it("rechecks process identity after approval", async () => {
	const { task, callbacks, process, terminal } = harness()
	callbacks.askApproval.mockImplementation(async () => {
		terminal.taskId = "other"
		return true
	})
	await manageCommandTool.execute({ execution_id: "execution", action: "stop" }, task, callbacks)
	expect(process.abort).not.toHaveBeenCalled()
	expect(callbacks.handleError).toHaveBeenCalled()
})

it("preserves denied input and sends only literal approved input", async () => {
	const { task, callbacks, process } = harness()
	callbacks.askApproval.mockResolvedValueOnce(false)
	const args = { execution_id: "execution", action: "input" as const, input: "yes\n", timeout_ms: 0 }
	await manageCommandTool.execute(args, task, callbacks)
	expect(process.writeInput).not.toHaveBeenCalled()
	await manageCommandTool.execute(args, task, callbacks)
	expect(process.writeInput).toHaveBeenCalledWith("yes\n")
})
