import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

const entrypoint = fileURLToPath(new URL("../cli.ts", import.meta.url))

function signal() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 2_000)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

async function runCli({
	commandFails = false,
	cleanupFailures = [],
	holdCleanup = false,
}: {
	commandFails?: boolean
	cleanupFailures?: string[]
	holdCleanup?: boolean
} = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "benchmark-cli-lifecycle-"))
	const evidence = path.join(directory, "evidence.json")
	const fixture = path.join(directory, "fixture.mjs")
	const preload = path.join(directory, "preload.mjs")
	const sockets = new Set<net.Socket>()
	const events: string[] = []
	const disposing = signal()
	const server = net.createServer({ allowHalfOpen: true }, (socket) => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
		let pending = ""
		socket.on("data", (chunk) => {
			pending += chunk.toString()
			for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
				const event = pending.slice(0, index)
				pending = pending.slice(index + 1)
				events.push(event)
				if (event.endsWith(":dispose")) {
					if (!holdCleanup) socket.end()
					if (events.filter((value) => value.endsWith(":dispose")).length === 2) disposing.resolve()
				}
			}
		})
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener")
	const unusedExports = [
		"findRun",
		"findTrialForTask",
		"getTasks",
		"buildPairedExperimentReport",
		"reportCampaignPair",
		"renderCampaignPair",
		"exportHostCampaign",
		"declareCampaignPair",
		"evaluateAdmission",
		"runKeylessCalibration",
		"syncVisibleKeylessReports",
		"mergeModelCalibration",
		"calibrationReportSchema",
		"readCalibrationReport",
		"resolveCalibrationReportPath",
		"updateCalibrationReport",
		"buildReviewSample",
		"auditFrontierRelease",
		"releaseFrontierSuite",
		"evaluateFrontierConvergence",
		"loadPrivateGraderBundle",
		"runAuthoringCheck",
		"writeTaskTemplate",
		"applySubsetMeasurements",
		"certifyInitialFixtureStates",
		"stringify",
		"CalibrationReportValidationError",
	]
	await fs.writeFile(
		fixture,
		`import { createConnection } from "node:net"
import { once } from "node:events"
import fs from "node:fs/promises"
const sockets = new Map()
async function connect(name) {
	const socket = createConnection({ host: "127.0.0.1", port: ${address.port} })
	await once(socket, "connect")
	socket.write(name + ":open\\n")
	sockets.set(name, socket)
}
async function close(name) {
	const socket = sockets.get(name)
	if (socket) {
		const closed = once(socket, "close")
		socket.end(name + ":dispose\\n")
		await closed
	}
	if (${JSON.stringify(cleanupFailures)}.includes(name)) throw new Error(name + " cleanup failure")
}
export const disconnect = () => close("database")
export const disconnectRedis = () => close("redis")
export async function runBenchmarkModelCampaign() {
	await connect("database")
	await connect("redis")
	await fs.writeFile(${JSON.stringify(evidence)}, JSON.stringify({ exported: true }))
	console.log("fixture campaign exported")
	if (${commandFails}) throw new Error("fixture command failure")
	return 42
}
export const EVALS_REPO_PATH = ${JSON.stringify(directory)}
export const DEFAULT_BENCHMARK_SUBSET_FILE = "frontier-t1-v6.yaml"
export const loadBenchmarkCatalog = async () => ({})
export const loadBenchmarkSubset = async () => ({ taskReservationUsd: 0.06, hardCapUsd: 0.5 })
export const selectBenchmarkSubset = () => ({ tasks: [{ id: "fixture-task" }], estimatedCostUsd: 0.04 })
export const estimateTierBudget = () => ({ maximumReservedUsd: 0.06 })
export const assertCampaignBudgetAuthorized = () => {}
const unused = () => { throw new Error("Unexpected CLI dependency call") }
export default unused
${unusedExports.map((name) => `export const ${name} = unused`).join("\n")}
`,
	)
	// Intercept only this entry point's imports. Node still executes the actual command and top-level finalizer.
	await fs.writeFile(
		preload,
		`import { registerHooks } from "node:module"
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL === ${JSON.stringify(pathToFileURL(entrypoint).href)} && !specifier.startsWith("node:"))
			return { url: ${JSON.stringify(pathToFileURL(fixture).href)}, shortCircuit: true }
		return nextResolve(specifier, context)
	}
})
`,
	)
	const child = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(preload).href,
			entrypoint,
			"run-model",
			"--role",
			"luna-high",
			"--model-id",
			"fixture-model",
			"--tier",
			"t1",
			"--partition",
			"visible",
		],
		{
			env: { SystemRoot: process.env.SystemRoot, NODE_NO_WARNINGS: "1" },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	)
	let stdout = ""
	let stderr = ""
	const exported = signal()
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString()
		if (stdout.includes("fixture campaign exported")) exported.resolve()
	})
	child.stderr.on("data", (chunk) => (stderr += chunk.toString()))
	const closed = once(child, "close")
	try {
		await within(
			Promise.race([
				exported.promise,
				closed.then(() => {
					throw new Error(`CLI exited before fixture export: ${stderr}`)
				}),
			]),
			"completed campaign export",
		)
		expect(JSON.parse(await fs.readFile(evidence, "utf8"))).toEqual({ exported: true })
		if (holdCleanup) {
			await within(disposing.promise, "both connection cleanup operations")
			expect(child.exitCode).toBeNull()
			for (const socket of sockets) socket.end()
		}
		const [exitCode, signal] = await within(closed, "natural CLI exit after export")
		return { exitCode, signal, stdout, stderr, events }
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill()
		for (const socket of sockets) socket.destroy()
		await within(closed, "owned fixture subprocess cleanup")
		await new Promise<void>((resolve) => server.close(() => resolve()))
		await fs.rm(directory, { recursive: true, force: true })
	}
}

describe("benchmark CLI connection ownership", () => {
	it("naturally exits after exporting a successful campaign and closing both sockets", async () => {
		const result = await runCli()
		expect(result.exitCode).toBe(0)
		expect(result.signal).toBeNull()
		expect(result.stdout).toContain('"runId": 42')
		expect(result.stderr).toBe("")
		expect(result.events.filter((event) => event.endsWith(":dispose")).sort()).toEqual([
			"database:dispose",
			"redis:dispose",
		])
	})

	it("closes both sockets after preserving a failed command's error", async () => {
		const result = await runCli({ commandFails: true })
		expect(result.exitCode).toBe(1)
		expect(result.signal).toBeNull()
		expect(result.stderr).toContain("fixture command failure")
		expect(result.events.filter((event) => event.endsWith(":dispose"))).toHaveLength(2)
	})

	it.each([["database"], ["redis"], ["database", "redis"]])(
		"attempts both cleanups and fails if cleanup rejects: %j",
		async (...cleanupFailures) => {
			const result = await runCli({ cleanupFailures })
			expect(result.exitCode).toBe(1)
			expect(result.signal).toBeNull()
			for (const name of cleanupFailures) expect(result.stderr).toContain(`${name} cleanup failure`)
			expect(result.events.filter((event) => event.endsWith(":dispose"))).toHaveLength(2)
		},
	)

	it("retains the original command error when both cleanups also reject", async () => {
		const result = await runCli({ commandFails: true, cleanupFailures: ["database", "redis"] })
		expect(result.exitCode).toBe(1)
		expect(result.signal).toBeNull()
		expect(result.stderr).toContain("fixture command failure")
		expect(result.stderr).toContain("database cleanup failure")
		expect(result.stderr).toContain("redis cleanup failure")
	})

	it("awaits both cleanup operations before the subprocess exits", async () => {
		const result = await runCli({ holdCleanup: true })
		expect(result.exitCode).toBe(0)
		expect(result.signal).toBeNull()
	})
})
