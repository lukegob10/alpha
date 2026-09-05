import type { ChildProcess } from "node:child_process"

/** Cleanup could not prove all workers exited; their fixture must remain available. */
export class BenchmarkWorkerCleanupError extends AggregateError {}

interface Worker<T> {
	process: ChildProcess
	phase: "starting" | "ready" | "warmed" | "result"
	result?: T
	closed: boolean
	close: Promise<void>
	stderr: string
}

/** A harness deadline bounds the entire worker group; it does not change production transaction timeouts. */
export async function runBenchmarkWorkers<T>(options: {
	writers: number
	timeoutMs: number
	signal?: AbortSignal
	spawn: (worker: number) => ChildProcess
}): Promise<T[]> {
	const workers: Worker<T>[] = []
	let failure: unknown
	let rejectRun!: (error: unknown) => void
	let resolveRun!: (value: T[]) => void
	const result = new Promise<T[]>((resolve, reject) => {
		resolveRun = resolve
		rejectRun = reject
	})
	const fail = (error: unknown) => {
		failure ??= error
		rejectRun(failure)
	}
	const abort = () => fail(new Error("Benchmark harness interrupted", { cause: options.signal?.reason }))
	const timer = setTimeout(
		() => fail(new Error(`Benchmark harness deadline exceeded (${options.timeoutMs} ms)`)),
		options.timeoutMs,
	)
	options.signal?.addEventListener("abort", abort, { once: true })
	const broadcast = (message: string) => {
		for (const worker of workers) {
			try {
				worker.process.send(message, (error) => {
					if (error) fail(error)
				})
			} catch (error) {
				fail(error)
			}
		}
	}
	try {
		if (options.signal?.aborted) abort()
		else
			for (let index = 0; index < options.writers; index++) {
				const process = options.spawn(index)
				let closed!: () => void
				const worker: Worker<T> = {
					process,
					phase: "starting",
					closed: false,
					stderr: "",
					close: new Promise<void>((resolve) => {
						closed = resolve
					}),
				}
				workers.push(worker)
				process.stderr?.on("data", (chunk: Buffer) => {
					worker.stderr = (worker.stderr + chunk.toString()).slice(-8_000)
				})
				process.stderr?.on("error", fail)
				process.on("error", fail)
				process.on("disconnect", () => {
					if (worker.phase !== "result")
						fail(new Error(`Benchmark worker ${index} disconnected before its result`))
				})
				process.on("message", (message: unknown) => {
					if (failure !== undefined) return
					if (typeof message !== "object" || message === null || !("type" in message)) {
						fail(new Error(`Invalid benchmark worker ${index} message`))
						return
					}
					if (message.type === "ready" && worker.phase === "starting") {
						worker.phase = "ready"
						if (workers.length === options.writers && workers.every((worker) => worker.phase === "ready"))
							broadcast("initialize")
					} else if (message.type === "warmed" && worker.phase === "ready") {
						worker.phase = "warmed"
						if (workers.every((worker) => worker.phase === "warmed")) broadcast("measure")
					} else if (message.type === "result" && worker.phase === "warmed" && "value" in message) {
						worker.phase = "result"
						worker.result = message.value as T
						if (workers.every((worker) => worker.phase === "result")) broadcast("finish")
					} else fail(new Error(`Unexpected benchmark worker ${index} phase: ${String(message.type)}`))
				})
				process.once("close", (code, signal) => {
					worker.closed = true
					closed()
					if (code !== 0 || worker.phase !== "result")
						fail(new Error(`Benchmark worker ${index} closed (${code ?? signal}): ${worker.stderr}`))
					else if (workers.length === options.writers && workers.every((worker) => worker.closed))
						resolveRun(workers.map((worker) => worker.result!))
				})
			}
		return await result
	} catch (error) {
		failure ??= error
		// A synchronous spawn failure can leave the run promise pending; consume it before teardown.
		void result.catch(() => undefined)
		throw failure
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", abort)
		const stop = (signal: NodeJS.Signals) => {
			for (const worker of workers)
				if (!worker.closed) {
					try {
						worker.process.kill(signal)
					} catch (error) {
						failure ??= error
					}
				}
		}
		stop("SIGTERM")
		const escalation = setTimeout(() => stop("SIGKILL"), 5_000)
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				Promise.all(workers.map((worker) => worker.close)),
				new Promise<never>((_, reject) => {
					cleanupTimer = setTimeout(
						() =>
							reject(
								new BenchmarkWorkerCleanupError(
									[failure, new Error("Benchmark workers did not close after termination")],
									"Benchmark failed; fixture retained because worker cleanup is incomplete",
									{ cause: failure },
								),
							),
						10_000,
					)
				}),
			])
		} finally {
			clearTimeout(escalation)
			clearTimeout(cleanupTimer)
		}
	}
}
