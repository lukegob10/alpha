import type { CompletionHookPromptFragment } from "./CompletionHooks"
import type { LifecycleHookTarget } from "./LifecycleHookTargets"

export interface AsyncLifecycleHookOutcome {
	warnings: string[]
	additionalContext?: CompletionHookPromptFragment[]
}

export interface AsyncLifecycleHookResult {
	event: LifecycleHookTarget
	outcome: AsyncLifecycleHookOutcome
}

interface PendingHook {
	event: LifecycleHookTarget
	run: (signal: AbortSignal) => Promise<AsyncLifecycleHookOutcome>
	controller: AbortController
	lifetimeSignal: AbortSignal
	detach: () => void
}

const MAX_CONCURRENCY = 8
// Include undelivered output in admission accounting so an idle task cannot
// accumulate an unbounded result channel while hooks continue to be submitted.
const MAX_OUTSTANDING = 32

/**
 * Owns asynchronous hook work for one Task, without starting or controlling turns.
 * Codex 67f0994 caps async commands at eight and joins them on session shutdown;
 * Alpha additionally bounds queued work and undelivered results for backpressure.
 */
export class AsyncLifecycleHooks {
	private readonly queued: PendingHook[] = []
	private readonly active = new Map<PendingHook, Promise<void>>()
	private readonly completed: Array<AsyncLifecycleHookResult & { lifetimeSignal: AbortSignal }> = []
	private readonly failures: unknown[] = []
	private closed = false
	private shutdownPromise?: Promise<void>

	schedule(
		event: LifecycleHookTarget,
		run: (signal: AbortSignal) => Promise<AsyncLifecycleHookOutcome>,
		lifetimeSignal: AbortSignal,
	): boolean {
		if (
			this.closed ||
			lifetimeSignal.aborted ||
			this.failures.length > 0 ||
			this.queued.length + this.active.size + this.completed.length >= MAX_OUTSTANDING
		)
			return false

		const controller = new AbortController()
		const cancel = () => {
			controller.abort(lifetimeSignal.reason)
			const index = this.queued.indexOf(hook)
			if (index !== -1) {
				this.queued.splice(index, 1)
				hook.detach()
				this.pump()
			}
		}
		const hook: PendingHook = {
			event,
			run,
			controller,
			lifetimeSignal,
			detach: () => lifetimeSignal.removeEventListener("abort", cancel),
		}
		this.queued.push(hook)
		lifetimeSignal.addEventListener("abort", cancel, { once: true })
		if (lifetimeSignal.aborted) cancel()
		this.pump()
		return !lifetimeSignal.aborted
	}

	/** The existing task loop chooses when advisory output becomes model context. */
	drain(): AsyncLifecycleHookResult[] {
		this.throwFailures()
		return this.completed
			.splice(0)
			.flatMap(({ event, outcome, lifetimeSignal }) => (lifetimeSignal.aborted ? [] : [{ event, outcome }]))
	}

	/** Effect/admission fences inspect resource failures without consuming advisory output. */
	checkCleanupFailures(): void {
		this.throwFailures()
	}

	/** Completion may defer for ready feedback; running hooks never hold an idle turn open. */
	hasPendingContext(): boolean {
		return this.completed.some(
			({ outcome, lifetimeSignal }) =>
				!lifetimeSignal.aborted && outcome.additionalContext?.some(({ text }) => text.trim()),
		)
	}

	/** Abort all owned work and wait until each executor has physically settled. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		this.closed = true
		this.cancelQueued()
		this.completed.length = 0
		for (const hook of this.active.keys()) hook.controller.abort()
		this.shutdownPromise = Promise.all([...this.active.values()]).then(() => this.throwFailures())
		return this.shutdownPromise
	}

	private pump(): void {
		while (!this.closed && this.failures.length === 0 && this.active.size < MAX_CONCURRENCY && this.queued.length) {
			const hook = this.queued.shift()!
			const completion = Promise.resolve()
				.then(async () => {
					if (hook.controller.signal.aborted) return
					const outcome = await hook.run(hook.controller.signal)
					if (this.closed || hook.controller.signal.aborted) return
					// Copy only advisory fields; controls from background hooks cannot
					// survive into the boundary that delivers the completed output.
					this.completed.push({
						event: hook.event,
						lifetimeSignal: hook.lifetimeSignal,
						outcome: {
							warnings: [...outcome.warnings],
							...(outcome.additionalContext
								? { additionalContext: structuredClone(outcome.additionalContext) }
								: {}),
						},
					})
				})
				.catch((error: unknown) => {
					// Normal hook failures are advisory outcomes. Rejections retain
					// resource failures for the Task's existing cleanup/recovery owner.
					// Reading that failure cannot reopen admission while a sibling
					// executor still owns physical process cleanup.
					this.closed = true
					this.failures.push(error)
					this.cancelQueued()
					for (const running of this.active.keys()) running.controller.abort()
				})
				.finally(() => {
					hook.detach()
					this.active.delete(hook)
					this.pump()
				})
			this.active.set(hook, completion)
		}
	}

	private cancelQueued(): void {
		for (const hook of this.queued.splice(0)) {
			hook.detach()
			hook.controller.abort()
		}
	}

	private throwFailures(): void {
		const failures = this.failures.splice(0)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) throw new AggregateError(failures, "Asynchronous lifecycle hook cleanup failed")
	}
}
