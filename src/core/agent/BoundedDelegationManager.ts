import type { InternalTaskEnvelope } from "./InternalTaskEnvelope"

export type InternalTaskStatus = "completed" | "failed" | "denied" | "cancelled" | "timed_out"
export interface InternalTaskResult {
	taskId: string
	status: InternalTaskStatus
	summary: string
	evidence: Array<{ kind: string; reference: string; outcome?: string }>
	changedFiles: string[]
	verification: Array<{ command?: string; status: string; exitCode?: number }>
	remainingRisks: string[]
	usage: { inputTokens?: number; outputTokens?: number; durationMs: number }
	modelRouteId: string
	requiresParentVerification: boolean
}
export type InternalTaskRunner = (
	envelope: InternalTaskEnvelope,
	signal: AbortSignal,
) => Promise<Omit<InternalTaskResult, "modelRouteId" | "requiresParentVerification">>

export class BoundedDelegationManager {
	private active = 0
	private readonly pending: Array<() => void> = []
	constructor(
		private readonly runner: InternalTaskRunner,
		private readonly maxConcurrency = 2,
	) {}
	async run(envelope: InternalTaskEnvelope, parentSignal?: AbortSignal): Promise<InternalTaskResult> {
		if (envelope.budget.maxDepth > 1 || envelope.policy.delegate)
			throw new Error("Child delegation exceeds maximum depth one")
		await this.acquire(parentSignal)
		const controller = new AbortController()
		const cancel = () => controller.abort(parentSignal?.reason)
		parentSignal?.addEventListener("abort", cancel, { once: true })
		const timer = setTimeout(
			() => controller.abort(new Error("internal task timed out")),
			envelope.budget.timeoutMs,
		)
		const started = Date.now()
		try {
			const result = await this.runner(envelope, controller.signal)
			return {
				...result,
				status: controller.signal.aborted ? (parentSignal?.aborted ? "cancelled" : "timed_out") : result.status,
				usage: { ...result.usage, durationMs: result.usage.durationMs || Date.now() - started },
				modelRouteId: envelope.modelRoute.id,
				requiresParentVerification: result.changedFiles.length > 0,
			}
		} catch (error) {
			const status = controller.signal.aborted ? (parentSignal?.aborted ? "cancelled" : "timed_out") : "failed"
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
			clearTimeout(timer)
			parentSignal?.removeEventListener("abort", cancel)
			this.release()
		}
	}
	async runBatch(envelopes: InternalTaskEnvelope[], parentSignal?: AbortSignal): Promise<InternalTaskResult[]> {
		const ids = new Set(envelopes.map((item) => item.id))
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
}
