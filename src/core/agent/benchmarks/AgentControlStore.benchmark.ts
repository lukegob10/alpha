/** Run with pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --help. */
import { fork, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { isDeepStrictEqual, parseArgs } from "node:util"

import { agentControlStateSchema, type AgentControlState } from "@alpha-code/types"

import { AgentControlStore, FileAgentControlPersistence } from "../AgentControlStore"
import type { AgentControlTransactionDiagnostic, AgentControlTransactionOptions } from "../AgentControlTransaction"
import { BenchmarkWorkerCleanupError, runBenchmarkWorkers } from "./AgentControlBenchmarkWorkers"
import { compareAgentControlBenchmarkReports } from "./AgentControlBenchmarkReport"
import {
	buildAgentControlBenchmarkFixture,
	type AgentControlBenchmarkFixture,
} from "../__tests__/fixtures/agentControlBenchmarkFixture"

type Command = "snapshot-read" | "noop-update" | "reserve-settle" | "owner-recovery"
type Phases = Record<"read" | "jsonParse" | "validation" | "copy" | "write", number>
interface TransactionSample {
	wait: number
	body: number
	releaseAndFence: number
	phases: Phases
	writes: number
	diagnostic?: AgentControlTransactionDiagnostic
}
interface CommandSample {
	command: Command
	iteration: number
	worker: number
	total: number
	error?: string
	transactions: TransactionSample[]
}
interface WorkerOptions {
	storage: string
	worker: number
	writers: number
	retainedAgentCount: number
	samples: number
	warmups: number
	commands: Command[]
	harnessTimeoutMs: number
}
interface WorkerResult {
	samples: CommandSample[]
	eventLoop: { p50: number; p95: number; max: number; count: number } | null
}
type WorkerMessage = { type: "ready" | "warmed" } | { type: "result"; value: WorkerResult }

const ownerId = (worker: number) => `benchmark-process-${worker}`
const phases = (): Phases => ({ read: 0, jsonParse: 0, validation: 0, copy: 0, write: 0 })
let currentCommand: CommandSample | undefined
let currentTransaction: TransactionSample | undefined
let currentAttempt: TransactionSample | undefined
let readingState = false

async function cleanupPreservingFailure(cleanup: () => Promise<void>, failure: unknown): Promise<void> {
	try {
		await cleanup()
	} catch (cleanupError) {
		if (failure !== undefined)
			throw new AggregateError([failure, cleanupError], "Benchmark failed and cleanup failed", { cause: failure })
		throw cleanupError
	}
}

/** Benchmark-only wrappers leave validation, serialization and all lock fences active. */
function instrumentSynchronousPhases(): () => void {
	const parse = agentControlStateSchema.parse
	const copy = globalThis.structuredClone
	const jsonParse = JSON.parse
	agentControlStateSchema.parse = (...args) => {
		const start = performance.now()
		try {
			return parse(...args)
		} finally {
			if (currentTransaction) currentTransaction.phases.validation += performance.now() - start
		}
	}
	globalThis.structuredClone = (value, options) => {
		const start = performance.now()
		try {
			return Reflect.apply(copy, globalThis, [value, options])
		} finally {
			if (currentTransaction) currentTransaction.phases.copy += performance.now() - start
		}
	}
	JSON.parse = (text, reviver) => {
		const start = performance.now()
		try {
			return jsonParse(text, reviver)
		} finally {
			if (currentTransaction && readingState) currentTransaction.phases.jsonParse += performance.now() - start
		}
	}
	return () => {
		agentControlStateSchema.parse = parse
		globalThis.structuredClone = copy
		JSON.parse = jsonParse
	}
}

class MeasuredPersistence extends FileAgentControlPersistence {
	constructor(storage: string) {
		super(storage, {
			onTransactionDiagnostic: (diagnostic) => {
				if (currentAttempt) currentAttempt.diagnostic = diagnostic
			},
		})
	}

	override async withTransaction<T>(
		operation: () => Promise<T>,
		options?: AgentControlTransactionOptions,
	): Promise<T> {
		if (!currentCommand) return super.withTransaction(operation, options)
		const transaction: TransactionSample = { wait: 0, body: 0, releaseAndFence: 0, phases: phases(), writes: 0 }
		currentCommand.transactions.push(transaction)
		currentAttempt = transaction
		const start = performance.now()
		let bodyEnd: number | undefined
		try {
			return await super.withTransaction(async () => {
				const bodyStart = performance.now()
				transaction.wait = bodyStart - start
				currentTransaction = transaction
				try {
					return await operation()
				} finally {
					bodyEnd = performance.now()
					transaction.body = bodyEnd - bodyStart
					currentTransaction = undefined
				}
			}, options)
		} finally {
			currentAttempt = undefined
			if (bodyEnd === undefined) transaction.wait = performance.now() - start
			else transaction.releaseAndFence = performance.now() - bodyEnd
		}
	}

	override async read(): Promise<unknown | undefined> {
		const start = performance.now()
		readingState = true
		try {
			return await super.read()
		} finally {
			readingState = false
			if (currentTransaction) currentTransaction.phases.read += performance.now() - start
		}
	}

	override async write(state: AgentControlState): Promise<void> {
		const start = performance.now()
		if (currentTransaction) currentTransaction.writes++
		try {
			await super.write(state)
		} finally {
			if (currentTransaction) currentTransaction.phases.write += performance.now() - start
		}
	}
}

const parentBarrier = (expected: string, outgoing: WorkerMessage) =>
	new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			process.off("message", listener)
			process.off("disconnect", disconnected)
		}
		const fail = (error: Error) => {
			cleanup()
			reject(error)
		}
		const disconnected = () => fail(new Error(`Benchmark parent disconnected while waiting for ${expected}`))
		const listener = (message: unknown) => {
			if (message !== expected) return
			cleanup()
			resolve()
		}
		process.on("message", listener)
		process.once("disconnect", disconnected)
		if (!process.connected) disconnected()
		else {
			try {
				process.send!(outgoing, (error: Error | null) => {
					if (error) fail(error)
				})
			} catch (error) {
				fail(error as Error)
			}
		}
	})

async function runWorker(options: WorkerOptions): Promise<void> {
	const persistence = new MeasuredPersistence(options.storage)
	const store = new AgentControlStore(persistence, Date.now, {
		ownerId: ownerId(options.worker),
		recoveryScanIntervalMs: 0,
	})
	const rootTaskId = `benchmark-root-${options.worker + 1}`
	const workspacePath = `/benchmark/project-${options.worker + 1}`
	const restore = instrumentSynchronousPhases()
	const delay = monitorEventLoopDelay({ resolution: 10 })
	const result: WorkerResult = { samples: [], eventLoop: null }
	let failure: unknown
	// If the parent disappears during persistence, bound worker lifetime even when shutdown cannot finish.
	let disconnectedTimer: ReturnType<typeof setTimeout> | undefined
	const disconnected = () => {
		disconnectedTimer = setTimeout(() => process.exit(1), 1_000)
	}
	process.once("disconnect", disconnected)
	try {
		// All process leases must exist before any initialization recovery scan.
		await persistence.acquireOwnerLease(ownerId(options.worker), {
			staleMs: 60_000,
			updateMs: 10_000,
			onCompromised: (error) => {
				throw error
			},
		})
		await parentBarrier("initialize", { type: "ready" })
		await store.initialize()
		for (let iteration = -options.warmups; iteration < options.samples; iteration++) {
			if (iteration === 0) {
				await parentBarrier("measure", { type: "warmed" })
				delay.enable()
			}
			for (const command of options.commands) {
				const sample: CommandSample = { command, iteration, worker: options.worker, total: 0, transactions: [] }
				currentCommand = sample
				const start = performance.now()
				try {
					switch (command) {
						case "snapshot-read":
							store.getSnapshot()
							break
						case "noop-update":
							await store.ensureRoot({ taskId: rootTaskId })
							break
						case "reserve-settle": {
							const token = `reservation-${options.worker}-${iteration}`
							await store.reservePrimaryMutation(rootTaskId, rootTaskId, workspacePath, token)
							await store.releasePrimaryMutation(rootTaskId, rootTaskId, token)
							break
						}
						case "owner-recovery":
							if ((await store.recoverAbandonedOwners()) !== 0)
								throw new Error("A live fixture owner was recovered")
							break
					}
				} catch (error) {
					// Preserve every failed sample in the denominator; never retry a benchmark command.
					sample.error = error instanceof Error ? error.message : String(error)
				} finally {
					sample.total = performance.now() - start
					currentCommand = undefined
				}
				if (iteration >= 0) result.samples.push(sample)
				else if (sample.error) throw new Error(`Warmup ${command} failed: ${sample.error}`)
			}
		}
		delay.disable()
		result.eventLoop =
			delay.count === 0
				? null
				: {
						p50: delay.percentile(50) / 1e6,
						p95: delay.percentile(95) / 1e6,
						max: delay.max / 1e6,
						count: delay.count,
					}
		// Keep leases live until every sibling has completed its final recovery scan.
		await parentBarrier("finish", { type: "result", value: result })
	} catch (error) {
		failure = error
		throw error
	} finally {
		delay.disable()
		restore()
		try {
			await cleanupPreservingFailure(() => store.shutdown(), failure)
		} finally {
			process.off("disconnect", disconnected)
			clearTimeout(disconnectedTimer)
			if (process.connected) process.disconnect!()
		}
	}
}

const quantiles = (values: number[]) => {
	const sorted = [...values].sort((left, right) => left - right)
	const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
	return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0 }
}

function summarize(samples: CommandSample[]) {
	return [...new Set(samples.map((sample) => sample.command))].map((command) => {
		const selected = samples.filter((sample) => sample.command === command)
		const transactions = selected.flatMap((sample) => sample.transactions)
		const diagnostics = transactions.flatMap((sample) => (sample.diagnostic ? [sample.diagnostic] : []))
		return {
			command,
			commands: selected.length,
			failures: selected.filter((sample) => sample.error !== undefined).length,
			failureRate: selected.filter((sample) => sample.error !== undefined).length / selected.length,
			transactions: transactions.length,
			transactionsPerCommand: transactions.length / selected.length,
			writes: transactions.reduce((total, transaction) => total + transaction.writes, 0),
			transactionFailures: diagnostics.filter(
				(diagnostic) => diagnostic.outcome !== "success" || diagnostic.releaseFailed,
			).length,
			contendedTransactions: diagnostics.filter((diagnostic) => diagnostic.attempts > 1).length,
			contentionRate:
				diagnostics.length === 0
					? null
					: diagnostics.filter((diagnostic) => diagnostic.attempts > 1).length / diagnostics.length,
			lock: {
				queueWait: quantiles(diagnostics.map((sample) => sample.queueWaitMs)),
				acquisitionWait: quantiles(diagnostics.map((sample) => sample.acquisitionWaitMs)),
				hold: quantiles(diagnostics.map((sample) => sample.holdMs)),
				release: quantiles(diagnostics.map((sample) => sample.releaseMs)),
				attempts: quantiles(diagnostics.map((sample) => sample.attempts)),
			},
			total: quantiles(selected.map((sample) => sample.total)),
			wait: quantiles(transactions.map((sample) => sample.wait)),
			body: quantiles(transactions.map((sample) => sample.body)),
			releaseAndFence: quantiles(transactions.map((sample) => sample.releaseAndFence)),
			phases: Object.fromEntries(
				Object.keys(phases()).map((phase) => [
					phase,
					quantiles(transactions.map((sample) => sample.phases[phase as keyof Phases])),
				]),
			),
			unattributedBody: quantiles(
				transactions.map(
					({ body, phases: phase }) => body - phase.read - phase.validation - phase.copy - phase.write,
				),
			),
		}
	})
}

async function runCase(options: Omit<WorkerOptions, "worker" | "storage">, signal: AbortSignal) {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-benchmark-"))
	let failure: unknown
	try {
		const fixture: AgentControlBenchmarkFixture = buildAgentControlBenchmarkFixture(options)
		for (let index = 0; index < fixture.projects.length; index++) {
			fixture.state.agents[index].runtimeOwnerId = ownerId(index % options.writers)
		}
		agentControlStateSchema.parse(fixture.state)
		const persistence = new FileAgentControlPersistence(storage)
		await persistence.write(fixture.state)
		const initialBytes = (await fs.stat(persistence.filePath)).size
		const workers = await runBenchmarkWorkers<WorkerResult>({
			writers: options.writers,
			timeoutMs: options.harnessTimeoutMs,
			signal,
			spawn: (worker) =>
				fork(__filename, ["--worker", JSON.stringify({ ...options, storage, worker })], {
					execArgv: ["--import", "tsx"],
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				}),
		})
		const final = agentControlStateSchema.parse(await persistence.read())
		if (
			final.agents.length !== fixture.state.agents.length ||
			final.mailbox.length !== fixture.state.mailbox.length ||
			final.nextSequence !== fixture.state.nextSequence
		) {
			throw new Error("Benchmark changed retained fixture counts or mailbox sequence")
		}
		const samples = workers.flatMap((worker) => worker.samples)
		if (
			!samples.some((sample) => sample.error) &&
			!isDeepStrictEqual(final, { ...fixture.state, updatedAt: final.updatedAt })
		) {
			throw new Error("Successful commands changed retained content or left a durable reservation")
		}
		return {
			options,
			initialBytes,
			finalBytes: (await fs.stat(persistence.filePath)).size,
			fixture: fixture.options,
			summary: summarize(samples),
			workers,
		}
	} catch (error) {
		failure = error
		throw error
	} finally {
		// mkdtemp returns this process's exact temporary directory, never a caller-selected tree.
		if (failure instanceof BenchmarkWorkerCleanupError) console.error(`Retained benchmark fixture: ${storage}`)
		else await cleanupPreservingFailure(() => fs.rm(storage, { recursive: true, force: true }), failure)
	}
}

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean" },
			worker: { type: "string" },
			sizes: { type: "string", default: "1,1000,5000" },
			writers: { type: "string", default: "1,2" },
			samples: { type: "string", default: "60" },
			warmups: { type: "string", default: "5" },
			commands: { type: "string", default: "snapshot-read,noop-update,reserve-settle,owner-recovery" },
			output: { type: "string" },
			label: { type: "string", default: "unspecified" },
			"quiet-window": { type: "string", default: "not granted; diagnostic run only" },
			"harness-timeout-ms": { type: "string", default: "1800000" },
			"compare-baseline": { type: "string" },
			"compare-candidate": { type: "string" },
		},
	})
	if (values.help) {
		console.log(
			"pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --output <report.json> [--sizes 1,1000,5000] [--writers 1,2] [--samples 60] [--warmups 5] [--commands snapshot-read,noop-update,reserve-settle,owner-recovery] [--label baseline] [--quiet-window <granted window>] [--harness-timeout-ms 1800000]\nCompare: --compare-baseline <baseline.json> --compare-candidate <candidate.json> [--output <comparison.json>]",
		)
		return
	}
	if (values.worker) return runWorker(JSON.parse(values.worker) as WorkerOptions)
	if (values["compare-baseline"] || values["compare-candidate"]) {
		if (!values["compare-baseline"] || !values["compare-candidate"])
			throw new Error("Both comparison reports are required")
		const [baseline, candidate] = await Promise.all(
			[values["compare-baseline"], values["compare-candidate"]].map(async (file) =>
				JSON.parse(await fs.readFile(file, "utf8")),
			),
		)
		const comparison = compareAgentControlBenchmarkReports(baseline, candidate)
		if (values.output) {
			await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true })
			await fs.writeFile(values.output, JSON.stringify(comparison, null, 2) + "\n")
		}
		console.log(
			JSON.stringify(
				{
					passed: comparison.passed,
					failures: comparison.failures,
					cases: comparison.cases.map(({ baseline, candidate, ...result }) => ({
						...result,
						baselineBodyP95: baseline.bodyP95,
						candidateBodyP95: candidate.bodyP95,
						baselineTotalP95: baseline.totalP95,
						candidateTotalP95: candidate.totalP95,
					})),
				},
				null,
				2,
			),
		)
		if (!comparison.passed) process.exitCode = 1
		return
	}
	const integers = (name: string, value: string, min: number, max: number) =>
		value.split(",").map((item) => {
			const result = Number(item)
			if (!Number.isSafeInteger(result) || result < min || result > max)
				throw new Error(`Invalid ${name}: ${item}`)
			return result
		})
	const sizes = integers("sizes", values.sizes, 0, 50_000)
	const writers = integers("writers", values.writers, 1, 4)
	const samples = integers("samples", values.samples, 1, 10_000)[0]
	const warmups = integers("warmups", values.warmups, 0, 1_000)[0]
	const harnessTimeoutMs = integers("harness-timeout-ms", values["harness-timeout-ms"], 1_000, 7_200_000)[0]
	const commands = values.commands.split(",") as Command[]
	if (
		commands.some(
			(command) => !["snapshot-read", "noop-update", "reserve-settle", "owner-recovery"].includes(command),
		)
	)
		throw new Error("Unknown command")
	if (!values.output) throw new Error("--output is required to retain raw measurements")
	const sourceIdentity = async () =>
		Object.fromEntries(
			await Promise.all(
				[
					"src/core/agent/AgentControlStore.ts",
					"src/core/agent/AgentControlTransaction.ts",
					"src/core/agent/AgentControlLockWaiter.ts",
					"src/core/agent/ParentVerification.ts",
					"src/shared/globalFileNames.ts",
					"src/utils/safeWriteJson.ts",
					"src/core/agent/benchmarks/AgentControlStore.benchmark.ts",
					"src/core/agent/benchmarks/AgentControlBenchmarkWorkers.ts",
					"src/core/agent/benchmarks/AgentControlBenchmarkReport.ts",
					"src/core/agent/__tests__/fixtures/agentControlBenchmarkFixture.ts",
					"packages/types/dist/index.cjs",
					"packages/types/dist/index.js",
					"pnpm-lock.yaml",
				].map(async (relativePath) => {
					try {
						const bytes = await fs.readFile(path.resolve(__dirname, "../../../..", relativePath))
						return [relativePath, createHash("sha256").update(bytes).digest("hex")]
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return [relativePath, "absent"]
						throw error
					}
				}),
			),
		)
	const report = {
		version: 1,
		label: values.label,
		startedAt: new Date().toISOString(),
		commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		workingTree: execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim(),
		sourceIdentity: await sourceIdentity(),
		runtime: {
			node: process.version,
			packageManager: process.env.npm_config_user_agent ?? "unavailable (invoke through pnpm exec)",
			platform: process.platform,
			arch: process.arch,
			os: os.release(),
			cpu: os.cpus()[0]?.model,
			logicalCpus: os.cpus().length,
			memoryBytes: os.totalmem(),
		},
		conditions: {
			quietWindow: values["quiet-window"],
			cache: "Fresh worker processes; warm filesystem cache after setup and warmup. No OS cache eviction.",
			units: "milliseconds",
			phases: "read includes JSON parse; body includes all internal phases. releaseAndFence includes the post-body owner check plus release. Unattributed body includes equality, mutation, owner lease checks and scheduler overhead. Snapshot reads use the local projection and zero transactions.",
			concurrency:
				"Processes synchronize at initialization and the start of measurement, then run independently. This does not guarantee continuous contention; attempts and acquisition wait describe observed contention.",
			backgroundRecoveryScanIntervalMs: 0,
		},
		cases: [] as Awaited<ReturnType<typeof runCase>>[],
	}
	const interrupted = new AbortController()
	const interrupt = () => interrupted.abort(new Error("Benchmark harness interrupted"))
	process.once("SIGINT", interrupt)
	process.once("SIGTERM", interrupt)
	try {
		for (const retainedAgentCount of sizes)
			for (const count of writers) {
				interrupted.signal.throwIfAborted()
				console.log(`Measuring ${retainedAgentCount} retained agents, ${count} process(es)`)
				report.cases.push(
					await runCase(
						{ retainedAgentCount, writers: count, samples, warmups, commands, harnessTimeoutMs },
						interrupted.signal,
					),
				)
				if (!isDeepStrictEqual(report.sourceIdentity, await sourceIdentity()))
					throw new Error("Benchmark source changed during measurement")
				await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true })
				await fs.writeFile(values.output, JSON.stringify(report, null, 2) + "\n")
			}
	} finally {
		process.off("SIGINT", interrupt)
		process.off("SIGTERM", interrupt)
	}
	if (
		report.cases.some((result) =>
			result.summary.some((command) => command.failures > 0 || command.transactionFailures > 0),
		)
	)
		process.exitCode = 1
	console.log(`Raw samples and summaries saved to ${path.resolve(values.output)}`)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
