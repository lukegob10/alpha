import type { AlphaTerminalProcess } from "../../integrations/terminal/types"
import { MAX_RETAINED_TERMINAL_PROCESSES } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import type { Task } from "../task/Task"

export interface CommandSession {
	readonly executionId: string
	readonly process: AlphaTerminalProcess
}

export interface TaskCommandOutputFinalization extends CommandSession {
	readonly archiveExecutionId?: string
	readonly completion: Promise<void>
	readonly isCleanupSafe: () => boolean
}

type CommandOutputArchive = {
	readonly archiveExecutionId: string
	readonly isClosed: () => boolean
}

export const MAX_RETAINED_COMMAND_SESSIONS = MAX_RETAINED_TERMINAL_PROCESSES

export interface ExpiredCommandSessionReceipt {
	readonly executionId: string
	readonly artifactId?: string
	readonly exitCode?: number
}

type CommandSessionKey = number | symbol

type TrackedTaskCommandOutput = {
	capture: TaskCommandOutputFinalization
	settled: boolean
	pending: boolean
	validBarrier: boolean
	isClosed: () => boolean
}

type RetainedCommandSession = CommandSession & {
	key: CommandSessionKey
	lastUsed: number
	removeObservers: () => void
	pollPublished: boolean
	pollReleased: boolean
	output?: TrackedTaskCommandOutput
}

type CommandExecutionOwnership = {
	readonly generation: number
	released: boolean
}

type TaskCommandSessions = {
	generation: number
	records: Map<CommandSessionKey, RetainedCommandSession>
	// Weak physical ownership permits a later lifecycle on the same Task object.
	executions: WeakMap<AlphaTerminalProcess, Map<string, CommandExecutionOwnership>>
}

/** Session IDs identify one physical command, even when its terminal is reused. */
export class CommandSessionRegistry {
	private nextSessionId = 1
	private nextUse = 1
	private readonly sessions = new WeakMap<Task, TaskCommandSessions>()
	private readonly expired = new WeakMap<Task, Map<number, ExpiredCommandSessionReceipt>>()
	private readonly outputOwners = new WeakMap<AlphaTerminalProcess, CommandSession>()

	private taskSessions(task: Task): TaskCommandSessions {
		let state = this.sessions.get(task)
		if (!state) {
			state = { generation: 0, records: new Map(), executions: new WeakMap() }
			this.sessions.set(task, state)
		}
		return state
	}

	private executionOwnership(
		state: TaskCommandSessions,
		process: AlphaTerminalProcess,
		executionId: string,
	): CommandExecutionOwnership {
		let executions = state.executions.get(process)
		if (!executions) {
			executions = new Map()
			state.executions.set(process, executions)
		}
		let ownership = executions.get(executionId)
		if (!ownership) {
			ownership = { generation: state.generation, released: false }
			executions.set(executionId, ownership)
		}
		return ownership
	}

	private findSession(
		state: TaskCommandSessions,
		process: AlphaTerminalProcess,
		executionId: string,
	): RetainedCommandSession | undefined {
		for (const session of state.records.values()) {
			if (session.process === process && session.executionId === executionId) return session
		}
		return undefined
	}

	private createSession(
		state: TaskCommandSessions,
		process: AlphaTerminalProcess,
		executionId: string,
	): RetainedCommandSession {
		const session: RetainedCommandSession = {
			executionId,
			process,
			key: Symbol("command-output"),
			lastUsed: this.nextUse++,
			removeObservers: () => undefined,
			pollPublished: false,
			pollReleased: false,
		}
		state.records.set(session.key, session)
		return session
	}

	/** Bind before launch without claiming stdout or allocating a public session ID. */
	trackTaskOutput(
		task: Task,
		process: AlphaTerminalProcess,
		executionId: string,
		archive: CommandOutputArchive,
	): void {
		if (!archive.archiveExecutionId) throw new Error("Cannot track command output without its archive identity")
		this.trackOutput(task, process, executionId, archive)
	}

	private trackOutput(
		task: Task,
		process: AlphaTerminalProcess,
		executionId: string,
		archive?: CommandOutputArchive,
	): void {
		if (!executionId || process.executionId !== executionId) {
			throw new Error("Cannot track command output without its original execution identity")
		}
		const state = this.taskSessions(task)
		const existing = this.findSession(state, process, executionId)
		// The post-return fallback may follow synchronous release of this exact
		// command. Its passive binding survives, without restoring polling.
		if (existing?.output) return
		const ownership = this.executionOwnership(state, process, executionId)
		if (ownership.released || ownership.generation !== state.generation || existing?.pollReleased) {
			throw new Error("Cannot track new output for a released command execution")
		}
		if (!process.waitForOutputFinalization && process.isOutputFinalized === true) return
		const session = existing ?? this.createSession(state, process, executionId)
		let completion: Promise<void>
		let validBarrier = false
		try {
			const barrier: unknown = process.waitForOutputFinalization?.()
			if (barrier === process || !(barrier instanceof Promise)) {
				throw new Error("Command output is missing a passive finalization barrier")
			}
			completion = barrier
			validBarrier = true
		} catch (error) {
			// Unknown/false legacy ownership is an explicit failed join, never
			// successful cleanup proof. Do not assimilate the public UI thenable.
			completion = Promise.reject(error)
		}
		const archiveExecutionId = archive?.archiveExecutionId
		const checkClosed = archive?.isClosed
		const isClosed = (): boolean => {
			try {
				return checkClosed?.() ?? false
			} catch {
				return false
			}
		}
		const output: TrackedTaskCommandOutput = {
			capture: Object.freeze({
				executionId,
				process,
				...(archiveExecutionId ? { archiveExecutionId } : {}),
				completion,
				isCleanupSafe: () =>
					validBarrier &&
					output.settled &&
					archiveExecutionId !== undefined &&
					process.executionId === executionId &&
					isClosed(),
			}),
			settled: false,
			pending: true,
			validBarrier,
			isClosed,
		}
		session.output = output
		const taskRef = new WeakRef(task)
		void completion
			.then(
				() => this.outputSettled(taskRef, session, output),
				() => this.outputSettled(taskRef, session, output),
			)
			.catch(() => {
				// Housekeeping must not create an unhandled rejection or replace
				// the original archive outcome exposed through the captured promise.
				console.error("[CommandSessionRegistry] Output finalization housekeeping failed")
			})
	}

	private outputMayRetire(output: TrackedTaskCommandOutput): boolean {
		if (!output.validBarrier || !output.settled) return false
		if (output.capture.process.executionId !== output.capture.executionId) return false
		// A legacy bridge never receives filename cleanup authority. Even its
		// fulfilled barrier must remain discoverable for this original Task.
		if (output.capture.archiveExecutionId === undefined) return false
		return output.isClosed()
	}

	private outputSettled(
		taskRef: WeakRef<Task>,
		session: RetainedCommandSession,
		output: TrackedTaskCommandOutput,
	): void {
		output.settled = true
		if (!this.outputMayRetire(output)) return
		output.pending = false
		const owner = taskRef.deref()
		if (!owner) return
		if (!session.pollPublished || session.pollReleased) {
			session.removeObservers()
			const state = this.sessions.get(owner)
			// Natural archive completion is not public revocation. An explicit
			// release already owns its weak tombstone; a never-published command
			// may still be legitimately published by an existing late caller.
			if (state?.records.get(session.key) === session) state.records.delete(session.key)
		} else {
			this.pruneSettled(owner)
		}
	}

	/** Pure original-owner snapshot, including released polls and changed identities. */
	capturePendingTaskOutput(task: Task): readonly TaskCommandOutputFinalization[] {
		return Object.freeze(
			[...(this.sessions.get(task)?.records.values() ?? [])].flatMap((session) =>
				session.output?.pending ? [session.output.capture] : [],
			),
		)
	}

	register(task: Task, process: AlphaTerminalProcess): number {
		const executionId = process.executionId
		if (!executionId) throw new Error("Cannot register a command without an execution identity")
		const state = this.taskSessions(task)
		const ownership = this.executionOwnership(state, process, executionId)
		if (ownership.released || ownership.generation !== state.generation) {
			throw new Error("Cannot publish a released command execution")
		}
		const session = this.findSession(state, process, executionId) ?? this.createSession(state, process, executionId)
		if (session.pollReleased) throw new Error("Cannot republish a released command session")
		// Compatibility for existing callers that publish a canonical process
		// directly. Unknown archive identity never authorizes file cleanup.
		if (!session.output && process.waitForOutputFinalization) this.trackOutput(task, process, executionId)
		if (typeof session.key !== "number") {
			state.records.delete(session.key)
			session.key = this.nextSessionId++
			state.records.set(session.key, session)
		}
		const sessionId = session.key
		session.lastUsed = this.nextUse++
		if (session.pollPublished) return sessionId
		session.pollPublished = true
		const taskRef = new WeakRef(task)
		const prune = () => {
			const owner = taskRef.deref()
			if (owner) this.pruneSettled(owner)
		}
		const receiptReleased = () => {
			session.lastUsed = this.nextUse++
			prune()
		}
		session.removeObservers = () => {
			process.off("completed", prune)
			process.off("finalized", prune)
			process.off("shell_execution_complete", prune)
			process.off("terminal_closed", prune)
			process.off("output_receipt_released", receiptReleased)
		}
		process.on("completed", prune)
		process.on("finalized", prune)
		process.on("shell_execution_complete", prune)
		process.on("terminal_closed", prune)
		process.on("output_receipt_released", receiptReleased)
		this.outputOwners.set(process, session)
		this.pruneSettled(task)
		return sessionId
	}

	private pruneSettled(task: Task): void {
		// Reader failure can emit error while the shell remains physically alive.
		const liveProcesses = new Set(
			[...TerminalRegistry.getTerminals(true, task.taskId), ...TerminalRegistry.getTerminals(false, task.taskId)]
				.filter((terminal) => terminal.taskId === task.taskId && terminal.running)
				.map((terminal) => terminal.process),
		)
		const candidates = [...(this.sessions.get(task)?.records.values() ?? [])]
			.filter((session) => {
				if (session.output?.pending && this.outputMayRetire(session.output)) session.output.pending = false
				return (
					session.pollPublished &&
					!session.pollReleased &&
					!session.output?.pending &&
					session.process.isSettled &&
					!liveProcesses.has(session.process) &&
					session.process.isOutputFinalized !== false &&
					!session.process.hasActiveOutputReceipt?.()
				)
			})
			.sort((left, right) => left.lastUsed - right.lastUsed)
		for (const session of candidates.slice(0, Math.max(0, candidates.length - MAX_RETAINED_COMMAND_SESSIONS))) {
			const sessionId = session.key
			if (typeof sessionId !== "number") continue
			let receipts = this.expired.get(task)
			if (!receipts) {
				receipts = new Map()
				this.expired.set(task, receipts)
			}
			const evidence = task
				.getCommandExecutionEvidence?.()
				?.find((item) => item.executionId === session.executionId)
			receipts.set(
				sessionId,
				Object.freeze({
					executionId: session.executionId,
					...(session.process.outputArtifactId ? { artifactId: session.process.outputArtifactId } : {}),
					...(typeof evidence?.exitCode === "number" ? { exitCode: evidence.exitCode } : {}),
				}),
			)
			while (receipts.size > MAX_RETAINED_COMMAND_SESSIONS) receipts.delete(receipts.keys().next().value!)
			this.release(task, sessionId)
			TerminalRegistry.releaseCompletedProcess(session.process)
		}
	}

	/** Compact host evidence survives expiry without retaining the process/output. */
	getExpiredReceipt(task: Task, sessionId: number): ExpiredCommandSessionReceipt | undefined {
		if (!Number.isSafeInteger(sessionId) || sessionId < 1) return undefined
		return this.expired.get(task)?.get(sessionId)
	}

	/** Explicit session polls own stdout until their final receipt is delivered. */
	ownsOutput(process: AlphaTerminalProcess): boolean {
		const session = this.outputOwners.get(process)
		return session !== undefined && session.executionId === process.executionId
	}

	resolve(task: Task, sessionId: number): CommandSession | undefined {
		if (!Number.isSafeInteger(sessionId) || sessionId < 1) return undefined
		const session = this.sessions.get(task)?.records.get(sessionId)
		if (!session?.pollPublished || session.pollReleased || session.process.executionId !== session.executionId) {
			return undefined
		}
		session.lastUsed = this.nextUse++
		// A command can finish between returning its session ID and the next poll.
		// Its settled process still owns the unread output even after terminal reuse.
		if (session.process.isSettled) return session
		return this.resolveActive(task, session)
	}

	private resolveActive(task: Task, session: CommandSession, requireRunning = false): CommandSession | undefined {
		const terminals = [
			...TerminalRegistry.getTerminals(true, task.taskId),
			...TerminalRegistry.getTerminals(false, task.taskId),
		]
		return terminals.some(
			(terminal) =>
				terminal.taskId === task.taskId &&
				terminal.process === session.process &&
				terminal.process.executionId === session.executionId &&
				(!requireRunning || terminal.running),
		)
			? session
			: undefined
	}

	/** Output-reader failure does not establish physical exit or revoke safe interrupt control. */
	isRunning(task: Task, sessionId: number, process: AlphaTerminalProcess): boolean {
		if (!Number.isSafeInteger(sessionId) || sessionId < 1) return false
		const session = this.sessions.get(task)?.records.get(sessionId)
		return (
			!!session &&
			session.pollPublished &&
			!session.pollReleased &&
			session.process === process &&
			process.executionId === session.executionId &&
			this.resolveActive(task, session, true)?.process === process
		)
	}

	/** Literal input additionally requires a healthy output/process observation. */
	isCurrent(task: Task, sessionId: number, process: AlphaTerminalProcess): boolean {
		return !process.isSettled && this.isRunning(task, sessionId, process)
	}

	private releaseSession(state: TaskCommandSessions, session: RetainedCommandSession): void {
		this.executionOwnership(state, session.process, session.executionId).released = true
		session.pollReleased = true
		session.removeObservers()
		if (this.outputOwners.get(session.process) === session) this.outputOwners.delete(session.process)
		if (session.output?.pending && this.outputMayRetire(session.output)) session.output.pending = false
		if (!session.output?.pending) state.records.delete(session.key)
	}

	release(task: Task, sessionId: number): void {
		const state = this.sessions.get(task)
		const session = state?.records.get(sessionId)
		if (state && session) this.releaseSession(state, session)
	}

	/** Revoke original polls without losing pending archives or blocking a later lifecycle. */
	releaseForTask(task: Task): void {
		this.expired.delete(task)
		const state = this.sessions.get(task)
		if (state) {
			const originalSessions = [...state.records.values()]
			// Retired private records still have weak admission ownership. Fence
			// those old executions before cleanup can admit a later lifecycle.
			state.generation++
			for (const session of originalSessions) this.releaseSession(state, session)
		}
	}
}

export const commandSessionRegistry = new CommandSessionRegistry()
