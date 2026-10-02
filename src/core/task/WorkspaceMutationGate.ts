type WorkspaceMutationRequest<T> = {
	taskId: string
	label: string
	run: () => Promise<T>
	resolve: (value: T) => void
	reject: (error: unknown) => void
	isCancelled?: () => boolean
	detachCancellation?: () => void
}

export class WorkspaceMutationCancelledError extends Error {
	constructor(taskId: string, label: string) {
		super(`Workspace mutation '${label}' for task ${taskId} was cancelled before it acquired the workspace lock.`)
		this.name = "WorkspaceMutationCancelledError"
	}
}

export class WorkspaceMutationGate {
	private active = false
	private queue: WorkspaceMutationRequest<unknown>[] = []

	/**
	 * Acquire the gate synchronously only when no mutation is active or queued.
	 * This is used for fail-closed policy transitions: the admission decision and
	 * the transition body form one critical section, so a mutation cannot enter
	 * between a separate busy check and the state change.
	 */
	public runIfIdle<T>(
		taskId: string,
		label: string,
		run: () => Promise<T>,
		isCancelled?: () => boolean,
	): Promise<T> | undefined {
		void taskId
		void label
		if (this.active || this.queue.length > 0 || isCancelled?.()) return undefined

		this.active = true
		return Promise.resolve()
			.then(run)
			.finally(() => {
				this.active = false
				this.drain()
			})
	}

	public run<T>(
		taskId: string,
		label: string,
		run: () => Promise<T>,
		isCancelled?: () => boolean,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted || isCancelled?.()) {
			return Promise.reject(new WorkspaceMutationCancelledError(taskId, label))
		}

		return new Promise<T>((resolve, reject) => {
			const request: WorkspaceMutationRequest<unknown> = {
				taskId,
				label,
				run,
				resolve: resolve as (value: unknown) => void,
				reject,
				isCancelled: signal ? () => signal.aborted || !!isCancelled?.() : isCancelled,
			}
			this.queue.push(request)
			if (signal) {
				const cancelQueued = () => {
					const index = this.queue.indexOf(request)
					if (index === -1) return
					this.queue.splice(index, 1)
					request.detachCancellation?.()
					reject(new WorkspaceMutationCancelledError(taskId, label))
					this.drain()
				}
				signal.addEventListener("abort", cancelQueued, { once: true })
				request.detachCancellation = () => signal.removeEventListener("abort", cancelQueued)
			}
			this.drain()
		})
	}

	private drain(): void {
		if (this.active) {
			return
		}

		const next = this.queue.shift()
		if (!next) {
			return
		}
		next.detachCancellation?.()

		if (next.isCancelled?.()) {
			next.reject(new WorkspaceMutationCancelledError(next.taskId, next.label))
			this.drain()
			return
		}

		this.active = true
		// The owner remains joined until its operation settles. Only queued work
		// is removable on cancellation; synchronous callback failures still release.
		Promise.resolve()
			.then(() => {
				if (next.isCancelled?.()) throw new WorkspaceMutationCancelledError(next.taskId, next.label)
				return next.run()
			})
			.then(next.resolve, next.reject)
			.finally(() => {
				this.active = false
				this.drain()
			})
	}
}
