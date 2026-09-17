import defaultCrypto, * as crypto from "crypto"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import { monitorEventLoopDelay, performance } from "perf_hooks"
import * as os from "os"
import * as path from "path"
import { isDeepStrictEqual } from "util"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ApiMessage } from "../apiMessages"
import { readApiMessages, saveApiMessages } from "../apiMessages"
import { ProviderTranscriptStore, digestProviderTranscript } from "../ProviderTranscriptStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

/**
 * This file is intentionally a runnable fixture, rather than a production
 * instrumentation hook. It models the current Task save/fence sequence using
 * the public persistence contracts so the same workload can be run after the
 * incremental receipt implementation lands.
 *
 * Run with:
 *   NOR29_BENCHMARK=1 pnpm --dir src exec vitest run core/task-persistence/__tests__/nor-29-benchmark.spec.ts
 *
 * The test is skipped by default so ordinary unit-test runs do not create
 * temporary task trees or add benchmark noise.
 */

const TASK_ID_PREFIX = "nor-29-benchmark"
const BENCHMARK_ENABLED = process.env.NOR29_BENCHMARK === "1"
const DEFAULT_REPETITIONS = 3
const DEFAULT_WARMUP = 1

type Workload = {
	name: "short" | "short-control" | "long"
	turns: number
	payloadBytes: number
	noOpSaves: number
}

export type Nor29BenchmarkOptions = {
	repetitions?: number
	warmup?: number
	mode?: "baseline" | "incremental"
	workloads?: readonly Workload[]
}

export type Nor29BenchmarkMetricSummary = {
	count: number
	mean: number | null
	median: number | null
	p95: number | null
	max: number | null
}

export type Nor29BenchmarkSample = {
	workload: Workload["name"]
	repetition: number
	turns: number
	payloadBytes: number
	finalMessageCount: number
	finalHistoryBytes: number
	finalLegacyBytes: number
	finalSidecarBytes: number
	flushCount: number
	legacyWriteCount: number
	sidecarReadCount: number
	sidecarCommitCount: number
	fenceCount: number
	bytesSerialized: number
	bytesRead: number
	bytesWritten: number
	/** Historical field names: these count ALL active SHA-256 instances, updates, and bytes. */
	fullHistoryHashCalls: number
	fullHistoryHashUpdates: number
	fullHistoryHashBytes: number
	flushLatencyMs: Nor29BenchmarkMetricSummary
	fenceLatencyMs: Nor29BenchmarkMetricSummary
	eventLoopDelayMs: {
		mean: number | null
		p99: number | null
		max: number | null
		timerMax: number | null
	}
	elapsedMs: number
}

export type Nor29BenchmarkReport = {
	format: "nor-29-benchmark-v2"
	hashMeasurement: "all-active-sha256"
	mode: "baseline" | "incremental"
	generatedAt: string
	node: string
	platform: NodeJS.Platform
	repetitions: number
	warmup: number
	workloads: Array<{
		definition: Workload
		samples: Nor29BenchmarkSample[]
		means: {
			flushLatencyMs: number | null
			fenceLatencyMs: number | null
			bytesSerialized: number | null
			bytesRead: number | null
			bytesWritten: number | null
			fullHistoryHashCalls: number | null
			fullHistoryHashUpdates: number | null
			fullHistoryHashBytes: number | null
			eventLoopDelayP99Ms: number | null
		}
	}>
}

type IoCounters = {
	bytesSerialized: number
	bytesRead: number
	bytesWritten: number
	fullHistoryHashCalls: number
	fullHistoryHashUpdates: number
	fullHistoryHashBytes: number
	sidecarReadCount: number
	legacyWriteCount: number
	sidecarCommitCount: number
}

function createIoCounters(): IoCounters {
	return {
		bytesSerialized: 0,
		bytesRead: 0,
		bytesWritten: 0,
		fullHistoryHashCalls: 0,
		fullHistoryHashUpdates: 0,
		fullHistoryHashBytes: 0,
		sidecarReadCount: 0,
		legacyWriteCount: 0,
		sidecarCommitCount: 0,
	}
}

type IncrementalLegacyReceipt = {
	taskId: string
	filePath: string
	digest: string
	byteLength: number
	commitId: string
}

type IncrementalTranscriptStore = {
	commitAuthoritativeTranscript: (
		legacyReceipt: IncrementalLegacyReceipt,
		expectedRevision?: number,
	) => Promise<unknown>
	assertCommitReceipt: (receipt: unknown) => Promise<void>
}

const instrumentation = vi.hoisted(() => ({
	activeCounters: undefined as IoCounters | undefined,
}))

const DEFAULT_WORKLOADS: readonly Workload[] = [
	{ name: "short", turns: 6, payloadBytes: 192, noOpSaves: 0 },
	{ name: "short-control", turns: 6, payloadBytes: 192, noOpSaves: 3 },
	{ name: "long", turns: 36, payloadBytes: 4096, noOpSaves: 0 },
]

// The benchmark's storage shim keeps this fixture independent of VS Code host
// activation while preserving the same task-directory layout.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

// Vitest exposes builtin ESM namespaces as immutable, so the counters use
// module-level wrappers instead of vi.spyOn. The wrappers are inert outside a
// running sample and therefore do not alter ordinary test behavior.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	const originalReadFile = actual.readFile.bind(actual) as unknown as (...args: unknown[]) => Promise<string | Buffer>
	const originalOpen = actual.open.bind(actual) as unknown as (...args: unknown[]) => Promise<fs.FileHandle>
	return {
		...actual,
		readFile: ((...args: unknown[]) => {
			const result = originalReadFile(...args)
			const counters = instrumentation.activeCounters
			if (!counters || !trackedPath(args[0])) return result
			if (String(args[0]).includes(GlobalFileNames.providerTranscript)) counters.sidecarReadCount += 1
			return result.then((value) => {
				counters.bytesRead += bytesFor(value)
				return value
			})
		}) as typeof actual.readFile,
		open: (async (...args: unknown[]) => {
			const handle = await originalOpen(...args)
			const counters = instrumentation.activeCounters
			if (!counters || !trackedPath(args[0])) return handle
			const originalWriteFile = handle.writeFile.bind(handle) as unknown as (
				...writeArgs: unknown[]
			) => Promise<void>
			handle.writeFile = ((...writeArgs: unknown[]) => {
				const byteCount = bytesFor(
					writeArgs[0],
					typeof writeArgs[1] === "string" ? (writeArgs[1] as BufferEncoding) : undefined,
				)
				counters.bytesWritten += byteCount
				return originalWriteFile(...writeArgs)
			}) as typeof handle.writeFile
			const originalRead = handle.read.bind(handle) as unknown as (...readArgs: unknown[]) => Promise<unknown>
			handle.read = ((...readArgs: unknown[]) =>
				originalRead(...readArgs).then((result) => {
					if (result !== null && typeof result === "object" && "bytesRead" in result) {
						const bytesRead = result.bytesRead
						if (typeof bytesRead === "number") counters.bytesRead += bytesRead
					}
					return result
				})) as typeof handle.read
			return handle
		}) as typeof actual.open,
	}
})

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	const originalCreateWriteStream = actual.createWriteStream.bind(actual) as unknown as (
		...args: unknown[]
	) => fsSync.WriteStream
	return {
		...actual,
		createWriteStream: ((...args: unknown[]) => {
			const stream = originalCreateWriteStream(...args)
			const counters = instrumentation.activeCounters
			if (!counters || !trackedPath(args[0])) return stream
			const originalWrite = stream.write.bind(stream) as unknown as (...writeArgs: unknown[]) => boolean
			stream.write = ((...writeArgs: unknown[]) => {
				const byteCount = bytesFor(
					writeArgs[0],
					typeof writeArgs[1] === "string" ? (writeArgs[1] as BufferEncoding) : undefined,
				)
				counters.bytesSerialized += byteCount
				counters.bytesWritten += byteCount
				return originalWrite(...writeArgs)
			}) as typeof stream.write
			return stream
		}) as typeof actual.createWriteStream,
		createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
			const stream = actual.createReadStream(...args)
			const counters = instrumentation.activeCounters
			if (counters && trackedPath(args[0])) {
				stream.on("data", (chunk: unknown) => {
					counters.bytesRead += bytesFor(chunk)
				})
			}
			return stream
		}) as typeof actual.createReadStream,
	}
})

vi.mock("crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("crypto")>()
	const originalCreateHash = actual.createHash.bind(actual) as typeof actual.createHash
	const createHash = ((...args: Parameters<typeof actual.createHash>) => {
		const hash = originalCreateHash(...args)
		const counters = instrumentation.activeCounters
		if (!counters || args[0] !== "sha256") return hash
		// v1 hashes canonical full history; v2 additionally hashes the exact
		// authoritative bytes. Count every SHA-256 operation while a sample is
		// active so the before/after totals include both forms of work.
		counters.fullHistoryHashCalls += 1
		const originalUpdate = hash.update.bind(hash) as unknown as (
			data: crypto.BinaryLike,
			inputEncoding?: BufferEncoding,
		) => crypto.Hash
		hash.update = ((data: crypto.BinaryLike, inputEncoding?: BufferEncoding) => {
			counters.fullHistoryHashUpdates += 1
			counters.fullHistoryHashBytes += bytesFor(data, inputEncoding)
			return originalUpdate(data, inputEncoding)
		}) as typeof hash.update
		return hash
	}) as typeof actual.createHash
	const defaultCrypto = (actual as unknown as { default?: Record<string, unknown> }).default
	return {
		...actual,
		createHash,
		default: { ...(defaultCrypto ?? actual), createHash },
	}
})

function bytesFor(value: unknown, encoding?: BufferEncoding): number {
	if (typeof value === "string") return Buffer.byteLength(value, encoding)
	if (Buffer.isBuffer(value)) return value.byteLength
	if (value instanceof ArrayBuffer) return value.byteLength
	if (ArrayBuffer.isView(value)) return value.byteLength
	return 0
}

function trackedPath(value: unknown): boolean {
	if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return false
	const text = value instanceof URL ? value.pathname : value.toString()
	return text.includes(GlobalFileNames.apiConversationHistory) || text.includes(GlobalFileNames.providerTranscript)
}

function isTranscriptSerialization(value: unknown): boolean {
	if (Array.isArray(value)) {
		return (
			value.length === 0 || value.some((entry) => entry !== null && typeof entry === "object" && "role" in entry)
		)
	}
	if (value === null || typeof value !== "object") return false
	const record = value as Record<string, unknown>
	return (
		(typeof record.taskId === "string" && ("messages" in record || "revision" in record || "digest" in record)) ||
		("messages" in record && Array.isArray(record.messages))
	)
}

function isIncrementalLegacyReceipt(value: unknown): value is IncrementalLegacyReceipt {
	if (value === null || typeof value !== "object") return false
	const receipt = value as Record<string, unknown>
	return (
		typeof receipt.taskId === "string" &&
		typeof receipt.filePath === "string" &&
		typeof receipt.digest === "string" &&
		/^[a-f0-9]{64}$/.test(receipt.digest) &&
		typeof receipt.byteLength === "number" &&
		Number.isSafeInteger(receipt.byteLength) &&
		receipt.byteLength >= 0 &&
		typeof receipt.commitId === "string" &&
		receipt.commitId.length > 0
	)
}

const originalJsonStringify = JSON.stringify

/** A skipped benchmark must not replace a global function merely by importing this file. */
async function withSerializationCounter<T>(operation: () => Promise<T>): Promise<T> {
	const previousStringify = JSON.stringify
	JSON.stringify = ((...args: unknown[]) => {
		const result = (previousStringify as (...values: unknown[]) => string | undefined)(...args)
		const counters = instrumentation.activeCounters
		if (counters && result !== undefined && isTranscriptSerialization(args[0])) {
			counters.bytesSerialized += Buffer.byteLength(result)
		}
		return result
	}) as typeof JSON.stringify
	try {
		return await operation()
	} finally {
		JSON.stringify = previousStringify
	}
}

function percentile(values: readonly number[], percentileValue: number): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)
	return sorted[index] ?? null
}

function summarize(values: readonly number[]): Nor29BenchmarkMetricSummary {
	return {
		count: values.length,
		mean: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
		median: percentile(values, 50),
		p95: percentile(values, 95),
		max: values.length === 0 ? null : Math.max(...values),
	}
}

function eventLoopSummary(histogram: ReturnType<typeof monitorEventLoopDelay>, timerDelays: readonly number[]) {
	const finiteHistogram = histogram.count > 0
	return {
		mean: finiteHistogram && Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : null,
		p99: finiteHistogram ? histogram.percentile(99) / 1e6 : null,
		max: finiteHistogram && Number.isFinite(histogram.max) ? histogram.max / 1e6 : null,
		timerMax: timerDelays.length === 0 ? null : Math.max(...timerDelays),
	}
}

function makeHistory(turns: number, payloadBytes: number): ApiMessage[][] {
	const snapshots: ApiMessage[][] = []
	const history: ApiMessage[] = []
	const payload = "x".repeat(payloadBytes)

	for (let turn = 0; turn < turns; turn++) {
		const toolUseId = `nor29-tool-${turn}`
		history.push({
			id: `nor29-user-${turn}`,
			ts: turn * 3,
			role: "user",
			content: `<user_message>Inspect fixture ${turn}. ${payload}</user_message>`,
		})
		history.push({
			id: `nor29-assistant-${turn}`,
			ts: turn * 3 + 1,
			role: "assistant",
			content: [
				{ type: "text", text: `I will inspect fixture ${turn}. ${payload}` },
				{ type: "tool_use", id: toolUseId, name: "read_file", input: { path: "src/fixture.ts", payload } },
			],
			reasoning_content: `Reasoning metadata for turn ${turn}: ${payload}`,
		})
		history.push({
			id: `nor29-result-${turn}`,
			ts: turn * 3 + 2,
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: `fixture.ts: ${payload}`,
				},
			],
		})
		snapshots.push(structuredClone(history))
	}

	return snapshots
}

async function fileSize(filePath: string): Promise<number> {
	try {
		return (await fs.stat(filePath)).size
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
		throw error
	}
}

async function persistSnapshot(
	store: ProviderTranscriptStore,
	storagePath: string,
	taskId: string,
	messages: ApiMessage[],
	counters: IoCounters,
	mode: "baseline" | "incremental",
): Promise<{ flushLatencyMs: number; fenceLatencyMs: number }> {
	const flushStarted = performance.now()
	// Include the same immutable snapshot capture performed by Task before its save queue.
	const capturedMessages = structuredClone(messages)
	const saved = (await saveApiMessages({
		messages: capturedMessages,
		taskId,
		globalStoragePath: storagePath,
	})) as unknown
	let receipt: unknown
	if (mode === "incremental") {
		if (!isIncrementalLegacyReceipt(saved)) {
			throw new Error("Incremental benchmark requires saveApiMessages to return an authoritative receipt")
		}
		const incrementalStore = store as unknown as IncrementalTranscriptStore
		if (typeof incrementalStore.commitAuthoritativeTranscript !== "function") {
			throw new Error("Incremental benchmark requires commitAuthoritativeTranscript")
		}
		receipt = await incrementalStore.commitAuthoritativeTranscript(saved)
		counters.sidecarCommitCount += 1
	} else {
		const expectedDigest = digestProviderTranscript(capturedMessages)
		const current = await store.read()
		receipt = store.getLastCommitReceipt()
		if (current.revision === 0 || current.digest !== expectedDigest) {
			receipt = await store.commit({ messages: capturedMessages, expectedRevision: current.revision })
			counters.sidecarCommitCount += 1
		}
	}
	if (!receipt) throw new Error("Current transcript sequence did not produce a commit receipt")
	if (mode === "incremental") {
		await (store as unknown as IncrementalTranscriptStore).assertCommitReceipt(receipt)
	} else {
		await store.verifyCommitReceipt(receipt as Parameters<typeof store.verifyCommitReceipt>[0])
	}
	const flushLatencyMs = performance.now() - flushStarted

	const fenceStarted = performance.now()
	const fenceExpectedDigest = digestProviderTranscript(messages)
	if (
		receipt === null ||
		typeof receipt !== "object" ||
		!("digest" in receipt) ||
		receipt.digest !== fenceExpectedDigest
	) {
		throw new Error("Fixture receipt is stale before effect fence")
	}
	if (mode === "incremental") {
		await (store as unknown as IncrementalTranscriptStore).assertCommitReceipt(receipt)
	} else {
		const fencedEnvelope = await store.verifyCommitReceipt(
			receipt as Parameters<typeof store.verifyCommitReceipt>[0],
		)
		if (fencedEnvelope.digest !== fenceExpectedDigest) throw new Error("Fixture sidecar changed at effect fence")
	}
	return { flushLatencyMs, fenceLatencyMs: performance.now() - fenceStarted }
}

async function runSample(
	workload: Workload,
	repetition: number,
	mode: "baseline" | "incremental",
): Promise<Nor29BenchmarkSample> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${TASK_ID_PREFIX}-`))
	const taskId = `${TASK_ID_PREFIX}-${workload.name}-${repetition}`
	const counters = createIoCounters()
	const flushLatencies: number[] = []
	const fenceLatencies: number[] = []
	const snapshots = makeHistory(workload.turns, workload.payloadBytes)
	const store = new ProviderTranscriptStore(taskId, directory)
	const histogram = monitorEventLoopDelay({ resolution: 1 })
	const timerDelays: number[] = []
	let previousTick = performance.now()
	let finalLegacyBytes = 0
	let finalSidecarBytes = 0
	const timer = setInterval(() => {
		const now = performance.now()
		timerDelays.push(Math.max(0, now - previousTick - 1))
		previousTick = now
	}, 1)

	instrumentation.activeCounters = counters
	histogram.enable()
	const started = performance.now()
	let completedAt = started
	try {
		let queue: Promise<void> = Promise.resolve()
		for (const snapshot of snapshots) {
			const queued = queue.then(async () => {
				const result = await persistSnapshot(store, directory, taskId, snapshot, counters, mode)
				counters.legacyWriteCount += 1
				flushLatencies.push(result.flushLatencyMs)
				fenceLatencies.push(result.fenceLatencyMs)
			})
			queue = queued.then(
				() => undefined,
				() => undefined,
			)
			await queued
		}
		const finalSnapshot = snapshots.at(-1) ?? []
		for (let index = 0; index < workload.noOpSaves; index++) {
			const queued = queue.then(async () => {
				const result = await persistSnapshot(store, directory, taskId, finalSnapshot, counters, mode)
				counters.legacyWriteCount += 1
				flushLatencies.push(result.flushLatencyMs)
				fenceLatencies.push(result.fenceLatencyMs)
			})
			queue = queued.then(
				() => undefined,
				() => undefined,
			)
			await queued
		}

		// Include the actual legacy and sidecar reload reads in the baseline. These
		// are the first operations after a task restart, not a second authority.
		const reloadedLegacy = await readApiMessages({ taskId, globalStoragePath: directory })
		if (!isDeepStrictEqual(reloadedLegacy, finalSnapshot)) throw new Error("Legacy reload changed the fixture")
		const restartedStore = new ProviderTranscriptStore(taskId, directory)
		const reloadedSidecar = await restartedStore.read()
		if (!isDeepStrictEqual(reloadedSidecar.messages, finalSnapshot))
			throw new Error("Sidecar reload changed the fixture")
		if (!restartedStore.getLastCommitReceipt()) throw new Error("Sidecar reload did not expose its receipt")
		const taskDirectory = path.join(directory, taskId)
		finalLegacyBytes = await fileSize(path.join(taskDirectory, GlobalFileNames.apiConversationHistory))
		finalSidecarBytes = await fileSize(path.join(taskDirectory, GlobalFileNames.providerTranscript))
		await new Promise<void>((resolve) => setImmediate(resolve))
		completedAt = performance.now()
	} finally {
		clearInterval(timer)
		histogram.disable()
		instrumentation.activeCounters = undefined
		await fs.rm(directory, { recursive: true, force: true })
	}
	const finalHistoryBytes = Buffer.byteLength(JSON.stringify(snapshots.at(-1) ?? []))
	const eventLoopDelayMs = eventLoopSummary(histogram, timerDelays)
	return {
		workload: workload.name,
		repetition,
		turns: workload.turns,
		payloadBytes: workload.payloadBytes,
		finalMessageCount: snapshots.at(-1)?.length ?? 0,
		finalHistoryBytes,
		finalLegacyBytes,
		finalSidecarBytes,
		flushCount: snapshots.length + workload.noOpSaves,
		legacyWriteCount: counters.legacyWriteCount,
		sidecarReadCount: counters.sidecarReadCount,
		sidecarCommitCount: counters.sidecarCommitCount,
		fenceCount: fenceLatencies.length,
		bytesSerialized: counters.bytesSerialized,
		bytesRead: counters.bytesRead,
		bytesWritten: counters.bytesWritten,
		fullHistoryHashCalls: counters.fullHistoryHashCalls,
		fullHistoryHashUpdates: counters.fullHistoryHashUpdates,
		fullHistoryHashBytes: counters.fullHistoryHashBytes,
		flushLatencyMs: summarize(flushLatencies),
		fenceLatencyMs: summarize(fenceLatencies),
		eventLoopDelayMs,
		elapsedMs: completedAt - started,
	}
}

function mean(
	samples: readonly Nor29BenchmarkSample[],
	selector: (sample: Nor29BenchmarkSample) => number,
): number | null {
	if (samples.length === 0) return null
	return samples.reduce((sum, sample) => sum + selector(sample), 0) / samples.length
}

function meanNullable<T>(samples: readonly T[], selector: (sample: T) => number | null): number | null {
	const values = samples.map(selector).filter((value): value is number => value !== null)
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

export async function runNor29Benchmark(options: Nor29BenchmarkOptions = {}): Promise<Nor29BenchmarkReport> {
	const repetitions = options.repetitions ?? Number(process.env.NOR29_REPETITIONS ?? DEFAULT_REPETITIONS)
	const warmup = options.warmup ?? Number(process.env.NOR29_WARMUP ?? DEFAULT_WARMUP)
	const requestedMode = options.mode ?? process.env.NOR29_BENCHMARK_MODE ?? "baseline"
	if (requestedMode !== "baseline" && requestedMode !== "incremental") {
		throw new Error("NOR29 benchmark mode must be baseline or incremental")
	}
	const mode = requestedMode
	const workloads = options.workloads ?? DEFAULT_WORKLOADS
	if (!Number.isInteger(repetitions) || repetitions < 1)
		throw new Error("NOR29 repetitions must be a positive integer")
	if (!Number.isInteger(warmup) || warmup < 0) throw new Error("NOR29 warmup must be a non-negative integer")

	return withSerializationCounter(async () => {
		for (const workload of workloads) {
			for (let repetition = 0; repetition < warmup; repetition++)
				await runSample(workload, -(repetition + 1), mode)
		}

		const reportWorkloads = []
		for (const workload of workloads) {
			const samples: Nor29BenchmarkSample[] = []
			for (let repetition = 0; repetition < repetitions; repetition++) {
				samples.push(await runSample(workload, repetition, mode))
			}
			reportWorkloads.push({
				definition: workload,
				samples,
				means: {
					flushLatencyMs: meanNullable(samples, (sample) => sample.flushLatencyMs.mean),
					fenceLatencyMs: meanNullable(samples, (sample) => sample.fenceLatencyMs.mean),
					bytesSerialized: mean(samples, (sample) => sample.bytesSerialized),
					bytesRead: mean(samples, (sample) => sample.bytesRead),
					bytesWritten: mean(samples, (sample) => sample.bytesWritten),
					fullHistoryHashCalls: mean(samples, (sample) => sample.fullHistoryHashCalls),
					fullHistoryHashUpdates: mean(samples, (sample) => sample.fullHistoryHashUpdates),
					fullHistoryHashBytes: mean(samples, (sample) => sample.fullHistoryHashBytes),
					eventLoopDelayP99Ms: meanNullable(samples, (sample) => sample.eventLoopDelayMs.p99),
				},
			})
		}

		return {
			format: "nor-29-benchmark-v2",
			hashMeasurement: "all-active-sha256",
			mode,
			generatedAt: new Date().toISOString(),
			node: process.version,
			platform: process.platform,
			repetitions,
			warmup,
			workloads: reportWorkloads,
		}
	})
}

describe("NOR-29 transcript persistence benchmark", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		instrumentation.activeCounters = undefined
		vi.restoreAllMocks()
	})

	it("counts every SHA-256 instance and string/buffer update through both import styles", () => {
		const counters = createIoCounters()
		instrumentation.activeCounters = counters
		try {
			crypto
				.createHash("sha256")
				.update("é", "utf8")
				.update(Buffer.from([1, 2, 3]))
				.digest("hex")
			defaultCrypto
				.createHash("sha256")
				.update(new Uint8Array([4, 5, 6, 7]))
				.digest("hex")
			crypto.createHash("sha1").update("not measured").digest("hex")
		} finally {
			instrumentation.activeCounters = undefined
		}
		expect(counters.fullHistoryHashCalls).toBe(2)
		expect(counters.fullHistoryHashUpdates).toBe(3)
		expect(counters.fullHistoryHashBytes).toBe(9)
	})

	it("leaves global serialization unchanged when skipped and restores it after failure", async () => {
		expect(JSON.stringify).toBe(originalJsonStringify)
		await expect(
			withSerializationCounter(async () => {
				throw new Error("fixture failure")
			}),
		).rejects.toThrow("fixture failure")
		expect(JSON.stringify).toBe(originalJsonStringify)
	})

	it("does not impute missing latency samples as zero", () => {
		expect(summarize([]).mean).toBeNull()
		expect(meanNullable([null, 12, null], (value) => value)).toBe(12)
		expect(meanNullable([null, null], (value) => value)).toBeNull()
	})

	it.skipIf(!BENCHMARK_ENABLED)("runs the real async disk persistence fixture", async () => {
		const report = await runNor29Benchmark()
		for (const workload of report.workloads) {
			expect(workload.samples).toHaveLength(report.repetitions)
			expect(workload.samples.every((sample) => sample.bytesRead > 0)).toBe(true)
			expect(workload.samples.every((sample) => sample.bytesWritten > 0)).toBe(true)
			expect(workload.samples.every((sample) => sample.fullHistoryHashCalls > 0)).toBe(true)
			expect(workload.samples.every((sample) => sample.fullHistoryHashBytes > 0)).toBe(true)
			expect(
				workload.samples.every((sample) => sample.fullHistoryHashUpdates >= sample.fullHistoryHashCalls),
			).toBe(true)
			for (const sample of workload.samples) {
				expect(sample.flushLatencyMs.count).toBe(sample.flushCount)
				expect(sample.fenceLatencyMs.count).toBe(sample.fenceCount)
				expect(sample.legacyWriteCount).toBe(sample.flushCount)
			}
		}
		expect(JSON.stringify).toBe(originalJsonStringify)
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	})
})
