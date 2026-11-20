export async function withProcessSignals<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const abort = new AbortController()
	const onSignal = () => abort.abort()
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)
	try {
		return await operation(abort.signal)
	} finally {
		process.removeListener("SIGINT", onSignal)
		process.removeListener("SIGTERM", onSignal)
	}
}
