import type { AlphaTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { Task } from "../task/Task"

export interface CommandSession {
	readonly executionId: string
	readonly process: AlphaTerminalProcess
}

/** Session IDs identify one physical command, even when its terminal is reused. */
export class CommandSessionRegistry {
	private nextSessionId = 1
	private readonly sessions = new WeakMap<Task, Map<number, CommandSession>>()

	register(task: Task, process: AlphaTerminalProcess): number {
		const executionId = process.executionId
		if (!executionId) throw new Error("Cannot register a command without an execution identity")
		let taskSessions = this.sessions.get(task)
		if (!taskSessions) {
			taskSessions = new Map()
			this.sessions.set(task, taskSessions)
		}
		for (const [sessionId, session] of taskSessions) {
			if (session.process === process && session.executionId === executionId) return sessionId
		}
		const sessionId = this.nextSessionId++
		taskSessions.set(sessionId, { executionId, process })
		return sessionId
	}

	resolve(task: Task, sessionId: number): CommandSession | undefined {
		if (!Number.isSafeInteger(sessionId) || sessionId < 1) return undefined
		const session = this.sessions.get(task)?.get(sessionId)
		if (!session || session.process.executionId !== session.executionId) return undefined
		const terminals = [
			...TerminalRegistry.getTerminals(true, task.taskId),
			...TerminalRegistry.getTerminals(false, task.taskId),
		]
		return terminals.some(
			(terminal) =>
				terminal.taskId === task.taskId &&
				terminal.process === session.process &&
				terminal.process.executionId === session.executionId,
		)
			? session
			: undefined
	}

	/** Use this before and after approval, immediately before sending literal input. */
	isCurrent(task: Task, sessionId: number, process: AlphaTerminalProcess): boolean {
		return this.resolve(task, sessionId)?.process === process
	}

	release(task: Task, sessionId: number): void {
		this.sessions.get(task)?.delete(sessionId)
	}
}

export const commandSessionRegistry = new CommandSessionRegistry()
