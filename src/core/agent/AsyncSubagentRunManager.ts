import { randomUUID } from "crypto"

import type {
	AgentCanonicalPath,
	SubagentLifecycleEvent,
	SubagentRunState,
	SubagentSpawnHandle,
} from "@alpha-code/types"

import { BoundedDelegationManager, type InternalTaskResult, type InternalTaskRunner } from "./BoundedDelegationManager"
import type { InternalTaskEnvelope } from "./InternalTaskEnvelope"

export interface AsyncSubagentLaunchOptions {
	groupId: string
	path: AgentCanonicalPath
	nickname: string
	role: SubagentRunState["role"]
	/** Optional presentation fields copied from an already-prepared group row. */
	initialSnapshot?: Partial<Pick<SubagentRunState, "writeScope" | "phase" | "phaseStartedAt" | "modelRoute">>
}

export interface AsyncSubagentRunManagerOptions {
	/** Used only when the constructor is given a runner instead of an existing bounded manager. */
	maxConcurrency?: number
	now?: () => number
}

export type AsyncSubagentLifecycleListener = (event: SubagentLifecycleEvent) => void

interface AsyncSubagentRunRecord {
	handle: SubagentSpawnHandle
	state: SubagentRunState
	completion: Promise<InternalTaskResult>
	result?: InternalTaskResult
	detachParentSignal?: () => void
}

const isTerminalStatus = (status: SubagentRunState["status"]): boolean =>
	!["pending", "running", "cancelling"].includes(status)

const cloneState = (state: SubagentRunState): SubagentRunState => structuredClone(state)
const cloneResult = (result: InternalTaskResult): InternalTaskResult => structuredClone(result)
const cloneEvent = (event: SubagentLifecycleEvent): SubagentLifecycleEvent => structuredClone(event)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Nonblocking lifecycle registry for internal sub-agent runs.
 *
 * `launch` returns before the supplied runner starts. The registry owns and
 * observes the background promise, so a caller can collect a terminal result
 * later without risking an unhandled rejection. Supplying the legacy bounded
 * manager lets `delegate_task` and asynchronous runs share one capacity pool.
 */
export class AsyncSubagentRunManager {
	private readonly executor: BoundedDelegationManager
	private readonly now: () => number
	private readonly runs = new Map<string, AsyncSubagentRunRecord>()
	private readonly knownTaskIds = new Set<string>()
	private readonly events: SubagentLifecycleEvent[] = []
	private nextEventSequence = 1
	private readonly listeners = new Set<AsyncSubagentLifecycleListener>()

	constructor(executor: BoundedDelegationManager | InternalTaskRunner, options: AsyncSubagentRunManagerOptions = {}) {
		this.executor =
			executor instanceof BoundedDelegationManager
				? executor
				: new BoundedDelegationManager(executor, options.maxConcurrency)
		this.now = options.now ?? Date.now
	}

	launch(
		envelope: InternalTaskEnvelope,
		options: AsyncSubagentLaunchOptions,
		parentSignal?: AbortSignal,
	): SubagentSpawnHandle {
		this.assertLaunch(envelope, options)

		const createdAt = this.now()
		const handle: SubagentSpawnHandle = Object.freeze({
			taskId: envelope.id,
			// A process-local generation counter resets after reload and can collide
			// with lifecycle events already persisted for this stable task ID.
			runId: `${envelope.id}:${randomUUID()}`,
			groupId: options.groupId.trim(),
			parentTaskId: envelope.parentTaskId,
			path: options.path,
			nickname: options.nickname.trim(),
			role: options.role,
			status: "pending",
			createdAt,
		})
		const state: SubagentRunState = {
			taskId: envelope.id,
			nickname: handle.nickname,
			role: options.role,
			objective: envelope.objective,
			writeScope: options.initialSnapshot?.writeScope ? [...options.initialSnapshot.writeScope] : undefined,
			status: "pending",
			phase: options.initialSnapshot?.phase ?? "queued",
			phaseStartedAt: options.initialSnapshot?.phaseStartedAt ?? createdAt,
			modelRoute: options.initialSnapshot?.modelRoute
				? structuredClone(options.initialSnapshot.modelRoute)
				: undefined,
			usage: { durationMs: 0 },
		}

		// The completion promise is replaced before launch returns. This temporary
		// value keeps construction atomic without exposing a rejecting promise.
		const record: AsyncSubagentRunRecord = {
			handle,
			state,
			completion: Promise.resolve(this.failureResult(envelope, "Sub-agent run was not launched")),
		}
		this.knownTaskIds.add(envelope.id)
		this.runs.set(envelope.id, record)

		let execution: Promise<InternalTaskResult>
		try {
			execution = this.executor.run(envelope, parentSignal, () => this.markStarted(record))
		} catch (error) {
			execution = Promise.resolve(this.failureResult(envelope, errorMessage(error)))
		}

		// Convert every failure into data immediately. The promise retained by the
		// registry is therefore always fulfilled, even when no caller ever waits.
		record.completion = execution.then(
			(result) =>
				result.taskId === envelope.id
					? result
					: this.failureResult(
							envelope,
							`Sub-agent runner returned task ${result.taskId} for handle ${envelope.id}`,
						),
			(error) => this.failureResult(envelope, errorMessage(error)),
		)
		void record.completion.then((result) => {
			try {
				this.complete(record, result)
			} catch {
				// Lifecycle publication is best effort. The fulfilled completion remains
				// retrievable even if an unexpected observer or cloning error occurs.
				record.result = result
				record.detachParentSignal?.()
			}
		})

		// Register the run with the bounded executor before making its pending
		// state observable. A subscriber can therefore cancel synchronously from
		// the first notification without racing executor registration.
		this.publish("status", record)
		const markParentCancellation = () => this.markCancelling(record)
		if (parentSignal?.aborted) {
			markParentCancellation()
		} else if (parentSignal) {
			parentSignal.addEventListener("abort", markParentCancellation, { once: true })
			record.detachParentSignal = () => parentSignal.removeEventListener("abort", markParentCancellation)
		}

		return handle
	}

	/**
	 * Start another turn for a retained terminal agent while preserving its
	 * stable task ID and historical lifecycle events.
	 */
	relaunch(
		envelope: InternalTaskEnvelope,
		options: AsyncSubagentLaunchOptions,
		parentSignal?: AbortSignal,
	): SubagentSpawnHandle {
		const previous = this.runs.get(envelope.id)
		if (!previous || !isTerminalStatus(previous.state.status)) {
			throw new Error(`Sub-agent task is not available for follow-up: ${envelope.id}`)
		}

		previous.detachParentSignal?.()
		this.runs.delete(envelope.id)
		this.knownTaskIds.delete(envelope.id)
		try {
			return this.launch(envelope, options, parentSignal)
		} catch (error) {
			this.runs.set(envelope.id, previous)
			this.knownTaskIds.add(envelope.id)
			throw error
		}
	}

	cancel(taskId: string, reason: string | Error = "Internal task cancelled by user"): boolean {
		const record = this.runs.get(taskId)
		if (!record || isTerminalStatus(record.state.status) || record.state.status === "cancelling") return false

		const cancelled = this.executor.cancel(taskId, reason)
		if (cancelled) this.markCancelling(record)
		return cancelled
	}

	interrupt(taskId: string, reason: string | Error = "Internal task interrupted by parent"): boolean {
		const record = this.runs.get(taskId)
		if (!record || isTerminalStatus(record.state.status) || record.state.status === "cancelling") return false

		const interrupted = this.executor.interrupt(taskId, reason)
		if (interrupted) this.markCancelling(record)
		return interrupted
	}

	getSnapshot(taskId: string): SubagentRunState | undefined {
		const state = this.runs.get(taskId)?.state
		return state ? cloneState(state) : undefined
	}

	listSnapshots(parentTaskId?: string): SubagentRunState[] {
		return [...this.runs.values()]
			.filter((record) => parentTaskId === undefined || record.handle.parentTaskId === parentTaskId)
			.map((record) => cloneState(record.state))
	}

	getResult(taskId: string): InternalTaskResult | undefined {
		const result = this.runs.get(taskId)?.result
		return result ? cloneResult(result) : undefined
	}

	/** Returns undefined for an unknown handle and an always-fulfilled promise otherwise. */
	waitForResult(taskId: string): Promise<InternalTaskResult> | undefined {
		const completion = this.runs.get(taskId)?.completion
		return completion?.then(cloneResult)
	}

	getEvents(taskId?: string): SubagentLifecycleEvent[] {
		return this.events
			.filter((event) => taskId === undefined || event.taskId === taskId)
			.map((event) => cloneEvent(event))
	}

	subscribe(listener: AsyncSubagentLifecycleListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Release a retained terminal record after its result has been consumed or persisted. */
	forget(taskId: string): boolean {
		const record = this.runs.get(taskId)
		if (!record || !isTerminalStatus(record.state.status)) return false
		record.detachParentSignal?.()
		this.runs.delete(taskId)
		for (let index = this.events.length - 1; index >= 0; index--) {
			if (this.events[index].taskId === taskId) this.events.splice(index, 1)
		}
		return true
	}

	private assertLaunch(envelope: InternalTaskEnvelope, options: AsyncSubagentLaunchOptions): void {
		if (this.knownTaskIds.has(envelope.id)) {
			throw new Error(`Sub-agent task ID is already registered: ${envelope.id}`)
		}
		if (!options.groupId.trim()) throw new Error("Sub-agent group ID is required")
		if (!options.path.startsWith("/root/")) throw new Error("Sub-agent canonical path is required")
		if (!options.nickname.trim()) throw new Error("Sub-agent nickname is required")
		if (envelope.budget.maxDepth > 1 || envelope.policy.delegate) {
			throw new Error("Child delegation exceeds maximum depth one")
		}
		if (envelope.agentKind && envelope.agentKind !== options.role) {
			throw new Error(`Sub-agent role ${options.role} does not match envelope agent kind ${envelope.agentKind}`)
		}
	}

	private markStarted(record: AsyncSubagentRunRecord): void {
		if (record.state.status !== "pending") return
		const startedAt = this.now()
		record.state = {
			...record.state,
			status: "running",
			phase: "starting",
			phaseStartedAt: startedAt,
			startedAt,
			usage: { durationMs: Math.max(0, startedAt - record.handle.createdAt) },
		}
		this.publish("started", record)
	}

	private markCancelling(record: AsyncSubagentRunRecord): void {
		if (record.state.status !== "pending" && record.state.status !== "running") return
		record.state = {
			...record.state,
			status: "cancelling",
			cancelRequestedAt: this.now(),
		}
		delete record.state.pendingApproval
		this.publish("status", record)
	}

	private complete(record: AsyncSubagentRunRecord, result: InternalTaskResult): void {
		if (record.result) return
		const completedAt = this.now()
		const status = result.status === "denied" ? "failed" : result.status
		const hasReport = status === "completed" || status === "blocked"
		record.result = result
		record.state = {
			...record.state,
			status,
			summary: hasReport ? result.summary : undefined,
			error: hasReport ? undefined : result.summary,
			changedFiles: [...result.changedFiles],
			verification: result.displayVerification ? structuredClone(result.displayVerification) : undefined,
			changeSet: result.changeSet ? structuredClone(result.changeSet) : undefined,
			requiresParentVerification: result.requiresParentVerification,
			completedAt,
			usage: { ...result.usage },
		}
		delete record.state.phase
		delete record.state.phaseStartedAt
		delete record.state.pendingApproval
		record.detachParentSignal?.()
		record.detachParentSignal = undefined
		this.publish("completed", record)
	}

	private failureResult(envelope: InternalTaskEnvelope, summary: string): InternalTaskResult {
		return {
			taskId: envelope.id,
			status: "failed",
			summary,
			evidence: [],
			changedFiles: [],
			verification: [],
			remainingRisks: ["Child task did not complete successfully"],
			usage: { durationMs: 0 },
			modelRouteId: envelope.modelRoute.id,
			requiresParentVerification: false,
		}
	}

	private publish(type: SubagentLifecycleEvent["type"], record: AsyncSubagentRunRecord): void {
		const sequence = this.nextEventSequence++
		const event = {
			eventId: `${record.handle.runId}:${sequence}`,
			sequence,
			runId: record.handle.runId,
			type,
			taskId: record.handle.taskId,
			groupId: record.handle.groupId,
			parentTaskId: record.handle.parentTaskId,
			occurredAt: this.now(),
			snapshot: cloneState(record.state),
		} as SubagentLifecycleEvent
		this.events.push(event)
		for (const listener of this.listeners) {
			try {
				listener(cloneEvent(event))
			} catch {
				// One observer must not corrupt lifecycle state or another observer.
			}
		}
	}
}
