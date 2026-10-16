import { EventEmitter } from "node:events"

import { CommandSessionRegistry } from "../CommandSessionRegistry"
import type { AlphaTerminalProcess } from "../../../integrations/terminal/types"
import type { Task } from "../../task/Task"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

afterEach(() => vi.restoreAllMocks())

function fixtureProcess(values: Partial<AlphaTerminalProcess>): AlphaTerminalProcess {
	return Object.assign(new EventEmitter(), values) as AlphaTerminalProcess
}

it("binds a session to the task and physical process despite terminal reuse", () => {
	const registry = new CommandSessionRegistry()
	const owner = { taskId: "owner" } as Task
	const other = { taskId: "other" } as Task
	const restoredInstance = { taskId: "owner" } as Task
	const process = fixtureProcess({ executionId: "first" })
	const terminal = { taskId: "owner", process, running: true }
	vi.spyOn(TerminalRegistry, "getTerminals").mockImplementation((_busy, taskId) =>
		taskId === "owner" ? [terminal as never] : [],
	)
	const sessionId = registry.register(owner, process)
	expect(registry.ownsOutput(process)).toBe(true)

	expect(registry.register(owner, process)).toBe(sessionId)
	expect(registry.resolve(other, sessionId)).toBeUndefined()
	expect(registry.resolve(restoredInstance, sessionId)).toBeUndefined()
	expect(registry.resolve(owner, sessionId)?.process).toBe(process)
	expect(registry.isCurrent(owner, sessionId, process)).toBe(true)
	terminal.taskId = "other"
	expect(registry.isCurrent(owner, sessionId, process)).toBe(false)
	terminal.taskId = "owner"
	terminal.process = fixtureProcess({ executionId: "first" })
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
	terminal.process = process

	process.executionId = "second"
	expect(registry.ownsOutput(process)).toBe(false)
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
	const nextSessionId = registry.register(owner, process)
	expect(nextSessionId).not.toBe(sessionId)
	registry.release(owner, sessionId)
	expect(registry.ownsOutput(process)).toBe(true)
	expect(registry.resolve(owner, sessionId)).toBeUndefined()
	registry.release(owner, nextSessionId)
	expect(registry.ownsOutput(process)).toBe(false)
})

it("releases only the disposed task instance's sessions and preserves unread output", () => {
	const registry = new CommandSessionRegistry()
	const owner = { taskId: "owner" } as Task
	const reloaded = { taskId: "owner" } as Task
	const other = { taskId: "other" } as Task
	const completed = fixtureProcess({
		executionId: "completed",
		isSettled: true,
		hasUnretrievedOutput: () => true,
	})
	const running = fixtureProcess({ executionId: "running" })
	const otherProcess = fixtureProcess({ executionId: "other", isSettled: true })
	const completedId = registry.register(owner, completed)
	const runningId = registry.register(owner, running)
	const otherId = registry.register(other, otherProcess)
	registry.releaseForTask(reloaded)
	expect(registry.ownsOutput(completed)).toBe(true)
	expect(registry.resolve(owner, completedId)?.process).toBe(completed)
	registry.releaseForTask(owner)
	registry.releaseForTask(owner)
	expect(registry.resolve(owner, completedId)).toBeUndefined()
	expect(registry.resolve(owner, runningId)).toBeUndefined()
	expect(registry.resolve(reloaded, completedId)).toBeUndefined()
	expect(registry.ownsOutput(completed)).toBe(false)
	expect(registry.ownsOutput(running)).toBe(false)
	expect(completed.hasUnretrievedOutput()).toBe(true)
	expect(registry.ownsOutput(otherProcess)).toBe(true)
	expect(registry.resolve(other, otherId)?.process).toBe(otherProcess)
})

it("disposing an older owner cannot clear a later session on the same physical process", () => {
	const registry = new CommandSessionRegistry()
	const owner = { taskId: "task" } as Task
	const reloaded = { taskId: "task" } as Task
	const process = fixtureProcess({ executionId: "first", isSettled: true })
	registry.register(owner, process)
	process.executionId = "second"
	const currentId = registry.register(reloaded, process)
	registry.releaseForTask(owner)
	expect(registry.ownsOutput(process)).toBe(true)
	expect(registry.resolve(reloaded, currentId)?.process).toBe(process)
	registry.releaseForTask(reloaded)
	expect(registry.ownsOutput(process)).toBe(false)
})
