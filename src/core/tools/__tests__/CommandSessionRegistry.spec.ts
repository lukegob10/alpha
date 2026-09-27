import { CommandSessionRegistry } from "../CommandSessionRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { Task } from "../../task/Task"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

afterEach(() => vi.restoreAllMocks())

it("binds a session to the task and physical process despite terminal reuse", () => {
	const registry = new CommandSessionRegistry()
	const owner = { taskId: "owner" } as Task
	const other = { taskId: "other" } as Task
	const restoredInstance = { taskId: "owner" } as Task
	const process = { executionId: "first" } as AlphaTerminalProcess
	const terminal = { taskId: "owner", process }
	vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((_busy, taskId) =>
		taskId === "owner" ? [terminal as never] : [],
	)
	const sessionId = registry.register(owner, process)

	expect(registry.register(owner, process)).toBe(sessionId)
	expect(registry.resolve(other, sessionId)).toBeUndefined()
	expect(registry.resolve(restoredInstance, sessionId)).toBeUndefined()
	expect(registry.resolve(owner, sessionId)?.process).toBe(process)
	expect(registry.isCurrent(owner, sessionId, process)).toBe(true)
	terminal.taskId = "other"
	expect(registry.isCurrent(owner, sessionId, process)).toBe(false)
	terminal.taskId = "owner"
	terminal.process = { executionId: "first" } as AlphaTerminalProcess
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
	terminal.process = process

	process.executionId = "second"
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
	expect(registry.register(owner, process)).not.toBe(sessionId)
	registry.release(owner, sessionId)
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
})
