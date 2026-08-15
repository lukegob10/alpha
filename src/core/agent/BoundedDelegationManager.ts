import type { InternalTaskEnvelope } from "./InternalTaskEnvelope"
import type { SubagentChangeSetState, SubagentVerification } from "@alpha-code/types"

export type InternalTaskStatus = "completed" | "blocked" | "failed" | "denied" | "cancelled" | "timed_out"
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
	usage: { inputTokens?: number; outputTokens?: number; durationMs: number }
	modelRouteId: string
	requiresParentVerification: boolean
}
export type InternalTaskRunner = (
	envelope: InternalTaskEnvelope,
	signal: AbortSignal,
) => Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>

export type InternalTaskCancellationKind = "parent_cancelled" | "user_cancelled" | "timed_out"

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
	private active = 0
	private readonly pending: Array<() => void> = []
	private readonly activeRuns = new Map<string, AbortController>()
	constructor(
		private readonly runner: InternalTaskRunner,
		private readonly maxConcurrency = 2,
	) {
		if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
			throw new Error("Internal task concurrency must be a positive integer")
		}
	}

	cancel(taskId: string, reason: string | Error = "Internal task cancelled by user"): boolean {
		const controller = this.activeRuns.get(taskId)
		if (!controller || controller.signal.aborted) return false

		controller.abort(
			new InternalTaskCancellationError(
				"user_cancelled",
				cancellationMessage(reason, "Internal task cancelled by user"),
			),
		)
		return true
	}

	async run(
		envelope: InternalTaskEnvelope,
		parentSignal?: AbortSignal,
		onStarted?: () => void,
	): Promise<InternalTaskResult> {
		if (envelope.budget.maxDepth > 1 || envelope.policy.delegate)
			throw new Error("Child delegation exceeds maximum depth one")
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
			await this.acquire(controller.signal)
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
			return {
				...result,
				status: controller.signal.aborted ? this.getCancellationStatus(controller.signal) : result.status,
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
			}
		} finally {
			if (timer) clearTimeout(timer)
			if (parentListenerAttached) parentSignal?.removeEventListener("abort", cancelFromParent)
			if (acquired) this.release()
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
	private async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason
		if (this.active < this.maxConcurrency) {
			this.active++
			return
		}
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				signal?.removeEventListener("abort", cancel)
				this.active++
				resolve()
			}
			const cancel = () => {
				const i = this.pending.indexOf(wake)
				if (i >= 0) this.pending.splice(i, 1)
				reject(signal?.reason)
			}
			this.pending.push(wake)
			signal?.addEventListener("abort", cancel, { once: true })
		})
	}
	private release(): void {
		this.active--
		this.pending.shift()?.()
	}

	private getCancellationStatus(signal: AbortSignal): "cancelled" | "timed_out" {
		return signal.reason instanceof InternalTaskCancellationError && signal.reason.kind === "timed_out"
			? "timed_out"
			: "cancelled"
	}
}
