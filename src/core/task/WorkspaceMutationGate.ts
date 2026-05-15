type WorkspaceMutationRequest<T> = {
	taskId: string
	label: string
	run: () => Promise<T>
	resolve: (value: T) => void
	reject: (error: unknown) => void
	isCancelled?: () => boolean
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

	public run<T>(taskId: string, label: string, run: () => Promise<T>, isCancelled?: () => boolean): Promise<T> {
		if (isCancelled?.()) {
			return Promise.reject(new WorkspaceMutationCancelledError(taskId, label))
		}

		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				taskId,
				label,
				run,
				resolve: resolve as (value: unknown) => void,
				reject,
				isCancelled,
			})
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

		if (next.isCancelled?.()) {
			next.reject(new WorkspaceMutationCancelledError(next.taskId, next.label))
			this.drain()
			return
		}

		this.active = true
		next.run()
			.then(next.resolve, next.reject)
			.finally(() => {
				this.active = false
				this.drain()
			})
	}
}
