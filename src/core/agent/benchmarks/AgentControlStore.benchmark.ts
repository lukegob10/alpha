/** Run with pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --help. */
import { fork, execFileSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { isDeepStrictEqual, parseArgs } from "node:util"

import { agentControlStateSchema, type AgentControlState } from "@alpha-code/types"

import { AgentControlStore, FileAgentControlPersistence } from "../AgentControlStore"
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
}
interface WorkerResult {
	samples: CommandSample[]
	eventLoop: { p50: number; p95: number; max: number; count: number }
}
type WorkerMessage = { type: "ready" | "warmed" } | { type: "result"; value: WorkerResult }

const ownerId = (worker: number) => `benchmark-process-${worker}`
const phases = (): Phases => ({ read: 0, jsonParse: 0, validation: 0, copy: 0, write: 0 })
let currentCommand: CommandSample | undefined
let currentTransaction: TransactionSample | undefined
let readingState = false

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
	override async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
		if (!currentCommand) return super.withTransaction(operation)
		const transaction: TransactionSample = { wait: 0, body: 0, releaseAndFence: 0, phases: phases(), writes: 0 }
		currentCommand.transactions.push(transaction)
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
			})
		} finally {
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

const send = (message: WorkerMessage) => process.send!(message)
const waitForParent = (expected: string) =>
	new Promise<void>((resolve) => {
		const listener = (message: unknown) => {
			if (message !== expected) return
			process.off("message", listener)
			resolve()
		}
		process.on("message", listener)
	})

async function runWorker(options: WorkerOptions): Promise<void> {
	const persistence = new MeasuredPersistence(options.storage)
	const store = new AgentControlStore(persistence, Date.now, { ownerId: ownerId(options.worker) })
	const rootTaskId = `benchmark-root-${options.worker + 1}`
	const workspacePath = `/benchmark/project-${options.worker + 1}`
	const restore = instrumentSynchronousPhases()
	const delay = monitorEventLoopDelay({ resolution: 10 })
	const result: WorkerResult = { samples: [], eventLoop: { p50: 0, p95: 0, max: 0, count: 0 } }
	try {
		// All process leases must exist before any initialization recovery scan.
		await persistence.acquireOwnerLease(ownerId(options.worker), {
			staleMs: 60_000,
			updateMs: 10_000,
			onCompromised: (error) => {
				throw error
			},
		})
		const initialize = waitForParent("initialize")
		send({ type: "ready" })
		await initialize
		await store.initialize()
		for (let iteration = -options.warmups; iteration < options.samples; iteration++) {
			if (iteration === 0) {
				const measure = waitForParent("measure")
				send({ type: "warmed" })
				await measure
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
		result.eventLoop = {
			p50: delay.percentile(50) / 1e6,
			p95: delay.percentile(95) / 1e6,
			max: delay.max / 1e6,
			count: delay.count,
		}
		const finish = waitForParent("finish")
		send({ type: "result", value: result })
		// Keep leases live until every sibling has completed its final recovery scan.
		await finish
	} finally {
		delay.disable()
		restore()
		await store.shutdown()
		process.disconnect?.()
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
		return {
			command,
			commands: selected.length,
			failures: selected.filter((sample) => sample.error !== undefined).length,
			failureRate: selected.filter((sample) => sample.error !== undefined).length / selected.length,
			transactions: transactions.length,
			transactionsPerCommand: transactions.length / selected.length,
			writes: transactions.reduce((total, transaction) => total + transaction.writes, 0),
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

async function runProcesses(options: Omit<WorkerOptions, "worker">): Promise<WorkerResult[]> {
	const children: ChildProcess[] = []
	let ready = 0
	let warmed = 0
	let finished = 0
	try {
		return await Promise.all(
			Array.from(
				{ length: options.writers },
				(_, worker) =>
					new Promise<WorkerResult>((resolve, reject) => {
						const child = fork(__filename, ["--worker", JSON.stringify({ ...options, worker })], {
							execArgv: ["--import", "tsx"],
							stdio: ["ignore", "ignore", "pipe", "ipc"],
						})
						children.push(child)
						let result: WorkerResult | undefined
						let stderr = ""
						child.stderr!.on("data", (chunk: Buffer) => {
							stderr = (stderr + chunk.toString()).slice(-8_000)
						})
						child.on("error", reject)
						child.on("message", (message: WorkerMessage) => {
							if (message.type === "ready" && ++ready === options.writers)
								children.forEach((process) => process.send("initialize"))
							if (message.type === "warmed" && ++warmed === options.writers)
								children.forEach((process) => process.send("measure"))
							if (message.type === "result") {
								result = message.value
								if (++finished === options.writers)
									children.forEach((process) => process.send("finish"))
							}
						})
						child.on("exit", (code) => {
							if (code !== 0 || !result)
								reject(new Error(`Benchmark worker ${worker} exited ${code}: ${stderr}`))
							else resolve(result)
						})
					}),
			),
		)
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill()
	}
}

async function runCase(options: Omit<WorkerOptions, "worker" | "storage">) {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-control-benchmark-"))
	try {
		const fixture: AgentControlBenchmarkFixture = buildAgentControlBenchmarkFixture(options)
		for (let index = 0; index < fixture.projects.length; index++) {
			fixture.state.agents[index].runtimeOwnerId = ownerId(index % options.writers)
		}
		agentControlStateSchema.parse(fixture.state)
		const persistence = new FileAgentControlPersistence(storage)
		await persistence.write(fixture.state)
		const initialBytes = (await fs.stat(persistence.filePath)).size
		const workers = await runProcesses({ ...options, storage })
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
	} finally {
		// mkdtemp returns this process's exact temporary directory, never a caller-selected tree.
		await fs.rm(storage, { recursive: true, force: true })
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
		},
	})
	if (values.help) {
		console.log(
			"pnpm exec tsx src/core/agent/benchmarks/AgentControlStore.benchmark.ts --output <report.json> [--sizes 1,1000,5000] [--writers 1,2] [--samples 60] [--warmups 5] [--commands snapshot-read,noop-update,reserve-settle,owner-recovery] [--label baseline] [--quiet-window <granted window>]",
		)
		return
	}
	if (values.worker) return runWorker(JSON.parse(values.worker) as WorkerOptions)
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
					"src/core/agent/ParentVerification.ts",
					"src/utils/safeWriteJson.ts",
					"src/core/agent/benchmarks/AgentControlStore.benchmark.ts",
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
		},
		cases: [] as Awaited<ReturnType<typeof runCase>>[],
	}
	for (const retainedAgentCount of sizes)
		for (const count of writers) {
			console.log(`Measuring ${retainedAgentCount} retained agents, ${count} process(es)`)
			report.cases.push(await runCase({ retainedAgentCount, writers: count, samples, warmups, commands }))
			if (!isDeepStrictEqual(report.sourceIdentity, await sourceIdentity()))
				throw new Error("Benchmark source changed during measurement")
			await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true })
			await fs.writeFile(values.output, JSON.stringify(report, null, 2) + "\n")
		}
	if (report.cases.some((result) => result.summary.some((command) => command.failures > 0))) process.exitCode = 1
	console.log(`Raw samples and summaries saved to ${path.resolve(values.output)}`)
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
