/**
 * Optional lifecycle boundary exposed by newer task runtimes. The extension
 * keeps this adapter structural so older Task implementations continue to
 * work without importing or changing the runtime contract.
 */
export interface TaskCancellationBoundaryResult {
	lifecycleRuntimeAvailable: boolean
	abortResult?: unknown
	receipt?: unknown
}

type RuntimeObject = Record<string, unknown>

const boundaryMethodNames = [
	"join",
	"waitForCancellation",
	"waitForAbort",
	"waitForTermination",
	"awaitCancellation",
	"awaitTermination",
	"waitForSettled",
	"waitForIdle",
	"getCancellationReceipt",
	"getAbortReceipt",
	"getTerminationReceipt",
] as const

const persistenceMethodNames = [
	"waitForPersistence",
	"waitForPersistenceComplete",
	"waitForPersistedState",
	"flushPersistence",
	"flushApiConversationHistoryPersistence",
	"flushClineMessages",
	"waitForClineMessagesSaved",
	"whenPersisted",
] as const

const receiptKeys = [
	"receipt",
	"cancellationReceipt",
	"abortReceipt",
	"terminationReceipt",
	"join",
	"joined",
	"termination",
	"terminated",
	"completion",
	"completed",
	"persistence",
	"persistencePromise",
	"persistenceCompletion",
	"persisted",
	"saved",
	"savePromise",
] as const

const isObject = (value: unknown): value is RuntimeObject => typeof value === "object" && value !== null

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
	(typeof value === "object" && value !== null) || typeof value === "function"
		? typeof (value as { then?: unknown }).then === "function"
		: false

function runtimeObjects(task: unknown): RuntimeObject[] {
	if (!isObject(task)) return []
	const runtimes: RuntimeObject[] = [task]
	for (const key of ["lifecycleRuntime", "agentRuntime", "agentTurnEngine", "runtime", "cancellationRuntime"]) {
		const value = task[key]
		if (isObject(value)) runtimes.push(value)
	}
	return runtimes
}

function findMethod(
	runtimes: readonly RuntimeObject[],
	names: readonly string[],
):
	| {
			runtime: RuntimeObject
			name: string
	  }
	| undefined {
	for (const runtime of runtimes) {
		for (const name of names) {
			if (typeof runtime[name] === "function") return { runtime, name }
		}
	}
	return undefined
}

function hasReceiptShape(value: unknown): boolean {
	return isObject(value) && receiptKeys.some((key) => key in value)
}

function hasDirectReceiptShape(runtimes: readonly RuntimeObject[]): boolean {
	return runtimes.some((runtime) =>
		["cancellationReceipt", "abortReceipt", "terminationReceipt", "persistence", "persisted"].some(
			(key) => key in runtime,
		),
	)
}

/** Whether a task exposes a post-abort runtime boundary. */
export function hasTaskCancellationBoundary(task: unknown): boolean {
	const runtimes = runtimeObjects(task)
	return Boolean(findMethod(runtimes, boundaryMethodNames) || hasDirectReceiptShape(runtimes))
}

async function awaitValue(value: unknown): Promise<unknown> {
	return isPromiseLike(value) ? await value : value
}

async function awaitReceiptValues(value: unknown, seen = new Set<unknown>()): Promise<void> {
	if (value === undefined || value === null || seen.has(value)) return
	if (isPromiseLike(value)) {
		const resolved = await value
		await awaitReceiptValues(resolved, seen)
		return
	}
	if (!isObject(value)) return
	seen.add(value)
	for (const key of receiptKeys) {
		if (key in value) await awaitReceiptValues(value[key], seen)
	}
}

/**
 * Await the runtime's cancellation/join boundary and every explicit
 * persistence promise it exposes. The function intentionally has no timeout:
 * once a runtime advertises a boundary, replacement must not race it.
 */
export async function awaitTaskCancellationBoundary(
	task: unknown,
	abortResult?: unknown,
): Promise<TaskCancellationBoundaryResult> {
	const runtimes = runtimeObjects(task)
	const boundary = findMethod(runtimes, boundaryMethodNames)
	const persistence = findMethod(runtimes, persistenceMethodNames)
	const lifecycleRuntimeAvailable = Boolean(
		boundary || hasReceiptShape(abortResult) || hasDirectReceiptShape(runtimes),
	)
	if (!lifecycleRuntimeAvailable) return { lifecycleRuntimeAvailable: false, abortResult }
	if (hasReceiptShape(abortResult)) await awaitReceiptValues(abortResult)

	let receipt: unknown
	const invokedMethods = new Set<string>()
	if (boundary) {
		invokedMethods.add(`${runtimes.indexOf(boundary.runtime)}:${boundary.name}`)
		receipt = await awaitValue((boundary.runtime[boundary.name] as () => unknown).call(boundary.runtime))
		// A receipt can carry a join/persistence promise without making the
		// runtime expose another method on the task itself.
		await awaitReceiptValues(receipt)
	}

	// Some runtimes expose a receipt only after join/cancellation settles.
	for (const runtime of runtimes) {
		for (const name of ["getCancellationReceipt", "getAbortReceipt", "getTerminationReceipt"]) {
			if (typeof runtime[name] !== "function") continue
			const methodKey = `${runtimes.indexOf(runtime)}:${name}`
			if (invokedMethods.has(methodKey)) continue
			invokedMethods.add(methodKey)
			const nextReceipt = await awaitValue((runtime[name] as () => unknown).call(runtime))
			receipt = nextReceipt ?? receipt
			await awaitReceiptValues(nextReceipt)
		}
	}

	if (persistence) {
		await awaitValue((persistence.runtime[persistence.name] as () => unknown).call(persistence.runtime))
	}

	// A direct receipt property is useful for runtimes that cannot expose a
	// method because cancellation is represented by an immutable operation
	// object. Await it after the explicit methods above.
	for (const runtime of runtimes) {
		for (const key of ["cancellationReceipt", "abortReceipt", "terminationReceipt", "persistence", "persisted"]) {
			if (key in runtime) await awaitReceiptValues(runtime[key])
		}
	}

	return { lifecycleRuntimeAvailable: true, abortResult, receipt }
}

export const awaitCancellationBoundary = awaitTaskCancellationBoundary
