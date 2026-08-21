import type { InternalTaskEnvelope } from "./InternalTaskEnvelope"
import type {
	SubagentChangeSetState,
	SubagentRunState,
	SubagentStopReason,
	SubagentVerification,
} from "@alpha-code/types"

export type InternalTaskStatus =
	| "completed"
	| "blocked"
	| "failed"
	| "denied"
	| "cancelled"
	| "timed_out"
	| "interrupted"
export interface InternalTaskResult {
	taskId: string
	status: InternalTaskStatus
	summary: string
	evidence: Array<{ kind: string; reference: string; outcome?: string }>
	changedFiles: string[]
	verification: Array<{ command?: string; status: string; exitCode?: number }>
	displayVerification?: SubagentVerification[]
	changeSet?: SubagentChangeSetState
	remainingRisks: string[]
	usage: SubagentRunState["usage"]
	modelRouteId: string
	requiresParentVerification: boolean
	/** Stable terminal cause, independent of presentation status. */
	stopReason?: SubagentStopReason
}
export type InternalTaskRunner = (
	envelope: InternalTaskEnvelope,
	signal: AbortSignal,
) => Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>

export type InternalTaskCancellationKind =
	| "parent_cancelled"
	| "ancestor_cancelled"
	| "user_cancelled"
	| "timed_out"
	| "interrupted"
	| "input_token_limit"
	| "output_token_limit"
	| "root_token_budget"
	| "root_cost_budget"

/** Typed abort reason shared with runners while retaining a useful Error message for logs and transcripts. */
export class InternalTaskCancellationError extends Error {
	constructor(
		readonly kind: InternalTaskCancellationKind,
		message: string,
	) {
		super(message)
		this.name = "InternalTaskCancellationError"
	}
}

const cancellationMessage = (reason: unknown, fallback: string): string => {
	if (reason instanceof Error && reason.message.trim()) return reason.message
	if (typeof reason === "string" && reason.trim()) return reason
	return fallback
}

export class BoundedDelegationManager {
	private readonly activeByRoot = new Map<string, number>()
	private readonly pending: Array<{
		envelope: InternalTaskEnvelope
		wake: () => void
	}> = []
	private readonly activeRuns = new Map<string, AbortController>()
	constructor(
		private readonly runner: InternalTaskRunner,
		private readonly maxConcurrency: number | ((envelope: InternalTaskEnvelope) => number) = 2,
	) {
		if (typeof maxConcurrency === "number" && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) {
			throw new Error("Internal task concurrency must be a positive integer")
		}
	}

	cancel(
		taskId: string,
		reason: string | Error = "Internal task cancelled by user",
		stopReason: Exclude<
			SubagentStopReason,
			| "completed"
			| "failed"
			| "timeout"
			| "authority_denied"
			| "depth_limit"
			| "orphaned"
			| "recovery_failed"
			| "never_launched"
		> = "cancelled",
	): boolean {
		const kind: InternalTaskCancellationKind = stopReason === "cancelled" ? "user_cancelled" : stopReason
		return this.abortRun(taskId, kind, reason)
	}

	interrupt(taskId: string, reason: string | Error = "Internal task interrupted by parent"): boolean {
		return this.abortRun(taskId, "interrupted", reason)
	}

	private abortRun(taskId: string, kind: InternalTaskCancellationKind, reason: string | Error): boolean {
		const controller = this.activeRuns.get(taskId)
		if (!controller || controller.signal.aborted) return false

		controller.abort(
			new InternalTaskCancellationError(kind, cancellationMessage(reason, "Internal task cancelled by user")),
		)
		return true
	}

	async run(
		envelope: InternalTaskEnvelope,
		parentSignal?: AbortSignal,
		onStarted?: () => void,
	): Promise<InternalTaskResult> {
		if (this.activeRuns.has(envelope.id)) throw new Error(`Internal task is already running: ${envelope.id}`)

		const controller = new AbortController()
		this.activeRuns.set(envelope.id, controller)
		const cancelFromParent = () =>
			controller.abort(
				new InternalTaskCancellationError(
					"parent_cancelled",
					cancellationMessage(parentSignal?.reason, "Parent task cancelled"),
				),
			)
		let parentListenerAttached = false
		if (parentSignal?.aborted) {
			cancelFromParent()
		} else if (parentSignal) {
			parentSignal.addEventListener("abort", cancelFromParent, { once: true })
			parentListenerAttached = true
		}

		let acquired = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const started = Date.now()
		try {
			await this.acquire(envelope, controller.signal)
			acquired = true
			if (controller.signal.aborted) throw controller.signal.reason
			onStarted?.()
			// A lifecycle observer may synchronously cancel the run in response to
			// the started notification. Do not invoke the child runner in that case.
			if (controller.signal.aborted) throw controller.signal.reason
			timer = setTimeout(
				() => controller.abort(new InternalTaskCancellationError("timed_out", "internal task timed out")),
				envelope.budget.timeoutMs,
			)
			const result = await this.runner(envelope, controller.signal)
			const cancelled = controller.signal.aborted
			return {
				...result,
				status: cancelled ? this.getCancellationStatus(controller.signal) : result.status,
				stopReason: cancelled
					? this.getCancellationStopReason(controller.signal)
					: (result.stopReason ?? this.getDefaultStopReason(result.status)),
				usage: { ...result.usage, durationMs: result.usage.durationMs || Date.now() - started },
				modelRouteId: envelope.modelRoute.id,
				requiresParentVerification: result.changedFiles.length > 0,
			}
		} catch (error) {
			const status = controller.signal.aborted ? this.getCancellationStatus(controller.signal) : "failed"
			return {
				taskId: envelope.id,
				status,
				summary: error instanceof Error ? error.message : String(error),
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: ["Child task did not complete successfully"],
				usage: { durationMs: Date.now() - started },
				modelRouteId: envelope.modelRoute.id,
				requiresParentVerification: false,
				stopReason: controller.signal.aborted ? this.getCancellationStopReason(controller.signal) : "failed",
			}
		} finally {
			if (timer) clearTimeout(timer)
			if (parentListenerAttached) parentSignal?.removeEventListener("abort", cancelFromParent)
			if (acquired) this.release(envelope)
			if (this.activeRuns.get(envelope.id) === controller) this.activeRuns.delete(envelope.id)
		}
	}
	async runBatch(envelopes: InternalTaskEnvelope[], parentSignal?: AbortSignal): Promise<InternalTaskResult[]> {
		const ids = new Set(envelopes.map((item) => item.id))
		if (ids.size !== envelopes.length) throw new Error("Duplicate child task ID in delegation batch")
		const remaining = new Map(envelopes.map((item) => [item.id, item]))
		const results = new Map<string, InternalTaskResult>()
		for (const item of envelopes)
			for (const dependency of item.dependencies)
				if (!ids.has(dependency)) throw new Error(`Unknown child dependency: ${dependency}`)
		while (remaining.size) {
			const ready = [...remaining.values()]
				.filter((item) => item.dependencies.every((id) => results.has(id)))
				.sort((a, b) => a.id.localeCompare(b.id))
			if (!ready.length) throw new Error("Cyclic child dependencies")
			for (const result of await Promise.all(ready.map((item) => this.run(item, parentSignal)))) {
				results.set(result.taskId, result)
				remaining.delete(result.taskId)
			}
		}
		return envelopes.map((item) => results.get(item.id)!)
	}
	private async acquire(envelope: InternalTaskEnvelope, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason
		const rootKey = this.getRootKey(envelope)
		if (this.getActive(rootKey) < this.getMaxConcurrency(envelope)) {
			this.activeByRoot.set(rootKey, this.getActive(rootKey) + 1)
			return
		}
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				signal?.removeEventListener("abort", cancel)
				this.activeByRoot.set(rootKey, this.getActive(rootKey) + 1)
				resolve()
			}
			const cancel = () => {
				const i = this.pending.findIndex((entry) => entry.wake === wake)
				if (i >= 0) this.pending.splice(i, 1)
				reject(signal?.reason)
			}
			this.pending.push({ envelope, wake })
			signal?.addEventListener("abort", cancel, { once: true })
		})
	}
	private release(envelope: InternalTaskEnvelope): void {
		const rootKey = this.getRootKey(envelope)
		const active = Math.max(0, this.getActive(rootKey) - 1)
		if (active === 0) this.activeByRoot.delete(rootKey)
		else this.activeByRoot.set(rootKey, active)

		const nextIndex = this.pending.findIndex(
			(entry) =>
				this.getRootKey(entry.envelope) === rootKey &&
				this.getActive(rootKey) < this.getMaxConcurrency(entry.envelope),
		)
		if (nextIndex >= 0) this.pending.splice(nextIndex, 1)[0].wake()
	}

	private getRootKey(envelope: InternalTaskEnvelope): string {
		return envelope.rootTaskId ?? envelope.parentTaskId
	}

	private getActive(rootKey: string): number {
		return this.activeByRoot.get(rootKey) ?? 0
	}

	private getMaxConcurrency(envelope: InternalTaskEnvelope): number {
		const value = typeof this.maxConcurrency === "function" ? this.maxConcurrency(envelope) : this.maxConcurrency
		if (!Number.isInteger(value) || value < 1) {
			throw new Error("Internal task concurrency must be a positive integer")
		}
		return value
	}

	private getCancellationStatus(signal: AbortSignal): "cancelled" | "timed_out" | "interrupted" {
		if (!(signal.reason instanceof InternalTaskCancellationError)) return "cancelled"
		if (signal.reason.kind === "timed_out") return "timed_out"
		if (signal.reason.kind === "interrupted") return "interrupted"
		return "cancelled"
	}

	private getCancellationStopReason(signal: AbortSignal): SubagentStopReason {
		if (!(signal.reason instanceof InternalTaskCancellationError)) return "cancelled"
		switch (signal.reason.kind) {
			case "user_cancelled":
				return "cancelled"
			case "timed_out":
				return "timeout"
			default:
				return signal.reason.kind
		}
	}

	private getDefaultStopReason(status: InternalTaskStatus): SubagentStopReason {
		if (status === "completed" || status === "blocked") return "completed"
		if (status === "cancelled" || status === "denied") return "cancelled"
		if (status === "timed_out") return "timeout"
		if (status === "interrupted") return "interrupted"
		return "failed"
	}
}
