export function createDebounce(delayMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	let pending: (() => void) | undefined
	let dueAt = 0

	const wake = () => {
		const remaining = Math.ceil(dueAt - performance.now())
		if (remaining > 0) {
			timer = setTimeout(wake, remaining)
			return
		}
		timer = undefined
		const run = pending
		pending = undefined
		run?.()
	}

	return {
		schedule(run: () => void) {
			pending = run
			dueAt = performance.now() + delayMs
			timer ??= setTimeout(wake, delayMs)
		},
		cancel() {
			clearTimeout(timer)
			timer = undefined
			pending = undefined
		},
	}
}
