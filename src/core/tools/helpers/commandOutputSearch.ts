import path from "node:path"
import { Worker } from "node:worker_threads"

import { t } from "../../../i18n"
import {
	READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES,
	READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES,
} from "../commandOutputContract"

export interface CommandOutputSearchBatch {
	lines: string[]
	firstLineNumber: number
	remainingBytes: number
	hasMatches: boolean
}

export interface CommandOutputSearchBatchResult {
	matchedLineIndices: number[]
	processedLineCount: number
}

export interface CommandOutputMatcher {
	testBatch(batch: CommandOutputSearchBatch): Promise<CommandOutputSearchBatchResult>
}

const MAX_ACTIVE_SEARCHES = 2
const MAX_PENDING_SEARCHES = 8
const SEARCH_QUEUE_TIMEOUT_MS = 5_000
const SEARCH_TIMEOUT_MS = 30_000
const SEARCH_BATCH_TIMEOUT_MS = 1_000
// One decoded 64 KiB chunk may expand invalid UTF-8 to three bytes per input
// byte, plus one retained partial line from the previous chunk.
const MAX_BATCH_BYTES = 4 * READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES

let activeSearches = 0
const pendingSearches: Array<() => void> = []

/** Own a terminable matcher for one streamed search, with bounded admission and lifetime. */
export function withCommandOutputSearch<T>(
	pattern: string,
	signal: AbortSignal | undefined,
	search: (matcher: CommandOutputMatcher, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted()
	if (activeSearches >= MAX_ACTIVE_SEARCHES && pendingSearches.length >= MAX_PENDING_SEARCHES) {
		return Promise.reject(new Error(t("tools:commandOutputSearch.busy")))
	}

	return new Promise<T>((resolve, reject) => {
		let queueTimer: NodeJS.Timeout | undefined
		const removeQueued = (reason: unknown) => {
			const index = pendingSearches.indexOf(start)
			if (index < 0) return
			pendingSearches.splice(index, 1)
			clearTimeout(queueTimer)
			signal?.removeEventListener("abort", onAbort)
			reject(reason)
		}
		const onAbort = () => removeQueued(signal?.reason)
		const start = () => {
			clearTimeout(queueTimer)
			signal?.removeEventListener("abort", onAbort)
			activeSearches++
			void searchInWorker(pattern, signal, search)
				.then(resolve, reject)
				.finally(() => {
					activeSearches--
					pendingSearches.shift()?.()
				})
		}
		if (activeSearches < MAX_ACTIVE_SEARCHES) {
			start()
		} else {
			pendingSearches.push(start)
			queueTimer = setTimeout(
				() => removeQueued(new Error(t("tools:commandOutputSearch.busy"))),
				SEARCH_QUEUE_TIMEOUT_MS,
			)
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) onAbort()
		}
	})
}

function isBatchResult(value: unknown, lineCount: number): value is CommandOutputSearchBatchResult {
	if (
		typeof value !== "object" ||
		value === null ||
		!("processedLineCount" in value) ||
		typeof value.processedLineCount !== "number" ||
		!Number.isSafeInteger(value.processedLineCount) ||
		value.processedLineCount < 1 ||
		value.processedLineCount > lineCount ||
		!("matchedLineIndices" in value) ||
		!Array.isArray(value.matchedLineIndices) ||
		value.matchedLineIndices.length > value.processedLineCount
	) {
		return false
	}
	const processedLineCount = value.processedLineCount
	let previousIndex = -1
	for (const index of value.matchedLineIndices) {
		if (
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index <= previousIndex ||
			index >= processedLineCount
		) {
			return false
		}
		previousIndex = index
	}
	return processedLineCount === lineCount || previousIndex === processedLineCount - 1
}

async function searchInWorker<T>(
	pattern: string,
	signal: AbortSignal | undefined,
	search: (matcher: CommandOutputMatcher, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted()
	let worker: Worker
	try {
		worker = new Worker(path.join(__dirname, "workers", "searchCommandOutput.js"), {
			workerData: pattern,
			resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
		})
	} catch {
		throw new Error(t("tools:commandOutputSearch.unavailable"))
	}
	const controller = new AbortController()
	const ownedSignal = controller.signal
	let closing = false
	let termination: Promise<number> | undefined
	const terminate = () => {
		closing = true
		termination ??= worker.terminate()
		return termination
	}
	let pending:
		| {
				lineCount: number
				timer: NodeJS.Timeout
				resolve: (result: CommandOutputSearchBatchResult) => void
				reject: (error: unknown) => void
		  }
		| undefined
	const abort = (reason: unknown) => controller.abort(reason)
	const onAbort = () => abort(signal?.reason)
	const onOwnedAbort = () => {
		// Stop executing regex immediately, even while the artifact owner closes
		// a cancelled filesystem operation. Admission still waits for cleanup.
		void terminate().catch(() => undefined)
		if (!pending) return
		const batch = pending
		pending = undefined
		clearTimeout(batch.timer)
		batch.reject(ownedSignal.reason)
	}
	const unavailable = () => abort(new Error(t("tools:commandOutputSearch.unavailable")))
	const onMessage = (result: unknown) => {
		if (closing || ownedSignal.aborted) return
		if (!pending || !isBatchResult(result, pending.lineCount)) {
			unavailable()
			return
		}
		const batch = pending
		pending = undefined
		clearTimeout(batch.timer)
		batch.resolve(result)
	}
	const onError = () => {
		if (!closing) unavailable()
	}
	const onExit = () => {
		if (!closing) unavailable()
	}
	const timer = setTimeout(() => abort(new Error(t("tools:commandOutputSearch.timeout"))), SEARCH_TIMEOUT_MS)
	worker.on("message", onMessage)
	worker.on("error", onError)
	worker.once("exit", onExit)
	ownedSignal.addEventListener("abort", onOwnedAbort, { once: true })
	signal?.addEventListener("abort", onAbort, { once: true })
	if (signal?.aborted) onAbort()
	const matcher: CommandOutputMatcher = {
		testBatch(batch) {
			ownedSignal.throwIfAborted()
			if (batch.lines.length === 0) return Promise.resolve({ matchedLineIndices: [], processedLineCount: 0 })
			if (
				pending ||
				batch.lines.length > READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES ||
				!Number.isSafeInteger(batch.firstLineNumber) ||
				batch.firstLineNumber < 1 ||
				!Number.isSafeInteger(batch.firstLineNumber + batch.lines.length) ||
				!Number.isSafeInteger(batch.remainingBytes) ||
				batch.remainingBytes < 0 ||
				batch.remainingBytes > READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES
			) {
				return Promise.reject(new Error(t("tools:commandOutputSearch.unavailable")))
			}
			let batchBytes = 0
			for (const line of batch.lines) {
				const lineBytes = Buffer.byteLength(line, "utf8")
				batchBytes += lineBytes
				if (lineBytes > READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES || batchBytes > MAX_BATCH_BYTES) {
					return Promise.reject(new Error(t("tools:commandOutputSearch.unavailable")))
				}
			}
			return new Promise((resolve, reject) => {
				pending = {
					lineCount: batch.lines.length,
					resolve,
					reject,
					timer: setTimeout(
						() => abort(new Error(t("tools:commandOutputSearch.timeout"))),
						SEARCH_BATCH_TIMEOUT_MS,
					),
				}
				try {
					worker.postMessage(batch)
				} catch {
					unavailable()
				}
			})
		},
	}
	let outcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown }
	try {
		ownedSignal.throwIfAborted()
		const result = await search(matcher, ownedSignal)
		ownedSignal.throwIfAborted()
		outcome = { kind: "success", value: result }
	} catch (error) {
		outcome = { kind: "failure", error }
	}
	clearTimeout(timer)
	signal?.removeEventListener("abort", onAbort)
	ownedSignal.removeEventListener("abort", onOwnedAbort)
	if (pending) {
		clearTimeout(pending.timer)
		pending.reject(new Error(t("tools:commandOutputSearch.unavailable")))
		pending = undefined
	}
	let cleanupError: Error | undefined
	// Do not release a slot while a timed-out regex is still executing.
	try {
		await terminate()
	} catch {
		cleanupError = new Error(t("tools:commandOutputSearch.cleanup"))
	} finally {
		// Node may drain queued error events before its termination promise settles.
		worker.removeListener("message", onMessage)
		worker.removeListener("error", onError)
		worker.removeListener("exit", onExit)
	}
	if (signal?.aborted) outcome = { kind: "failure", error: signal.reason }
	if (cleanupError) {
		if (outcome.kind === "failure") {
			const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
			throw new AggregateError([outcome.error, cleanupError], `${message}; ${cleanupError.message}`, {
				cause: outcome.error,
			})
		}
		throw cleanupError
	}
	if (outcome.kind === "failure") throw outcome.error
	return outcome.value
}
