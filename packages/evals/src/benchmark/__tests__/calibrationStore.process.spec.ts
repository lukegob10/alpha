import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { calibrationReportSchema } from "../contracts"
import type { CalibrationStoreProcessMessage, CalibrationStoreProcessUpdate } from "./fixtures/calibrationStoreProcess"

type Result = Extract<CalibrationStoreProcessMessage, { type: "result" }>
type Waiter = {
	matches: (message: CalibrationStoreProcessMessage) => boolean
	resolve: (message: CalibrationStoreProcessMessage) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout>
}

const require = createRequire(import.meta.url)
const loader = pathToFileURL(require.resolve("tsx/esm")).href
const entrypoint = fileURLToPath(new URL("./fixtures/calibrationStoreProcess.ts", import.meta.url))
const actors: Actor[] = []
const roots: Array<{ parent: string; root: string }> = []

class Actor {
	readonly child: ChildProcess
	readonly closed: Promise<void>
	private messages: CalibrationStoreProcessMessage[] = []
	private waiters = new Set<Waiter>()
	private stderr = ""
	private exited = false
	private sequence = 0

	constructor(file: string) {
		this.child = spawn(process.execPath, ["--import", loader, entrypoint, file], {
			cwd: path.dirname(file),
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			windowsHide: true,
			timeout: 12_000,
			killSignal: "SIGKILL",
		})
		this.child.on("error", (error) => {
			this.stderr = (this.stderr + error.message).slice(-4096)
		})
		this.child.stderr?.on("data", (data: Buffer) => {
			this.stderr = (this.stderr + data.toString("utf8")).slice(-4096)
		})
		this.child.on("message", (message: CalibrationStoreProcessMessage) => {
			for (const waiter of this.waiters) {
				if (!waiter.matches(message)) continue
				clearTimeout(waiter.timer)
				this.waiters.delete(waiter)
				waiter.resolve(message)
				return
			}
			this.messages.push(message)
		})
		this.closed = new Promise((resolve) => {
			this.child.once("close", () => {
				this.exited = true
				for (const waiter of this.waiters) {
					clearTimeout(waiter.timer)
					waiter.reject(new Error(`Calibration child exited: ${this.stderr}`))
				}
				this.waiters.clear()
				resolve()
			})
		})
	}

	waitFor(type: CalibrationStoreProcessMessage["type"], id?: number): Promise<CalibrationStoreProcessMessage> {
		const matches = (message: CalibrationStoreProcessMessage) =>
			message.type === type && (id === undefined || ("id" in message && message.id === id))
		const index = this.messages.findIndex(matches)
		if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]!)
		if (this.exited) return Promise.reject(new Error(`Calibration child exited: ${this.stderr}`))
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				matches,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter)
					reject(new Error(`Calibration child did not report ${type}: ${this.stderr}`))
				}, 10_000),
			}
			this.waiters.add(waiter)
		})
	}

	async update(request: Omit<CalibrationStoreProcessUpdate, "op" | "id">): Promise<Result> {
		const id = ++this.sequence
		const result = this.waitFor("result", id)
		this.child.send({ ...request, op: "update", id })
		try {
			const message = await result
			if (message.type !== "result") throw new Error("Unexpected calibration child response")
			return message
		} catch (error) {
			return {
				type: "result",
				id,
				ok: false,
				callbackCount: 0,
				code: "CHILD_EXITED",
				message: error instanceof Error ? error.message : String(error),
			}
		}
	}

	release(): void {
		this.child.send({ op: "release" })
	}

	async terminate(): Promise<void> {
		if (!this.exited) this.child.kill("SIGKILL")
		await this.closed
	}
}

async function actor(file: string): Promise<Actor> {
	const result = new Actor(file)
	actors.push(result)
	await result.waitFor("ready")
	return result
}

async function fixture() {
	const parent = await fs.realpath(os.tmpdir())
	const root = await fs.mkdtemp(path.join(parent, "calibration-process-"))
	roots.push({ parent, root })
	const file = path.join(root, "task.keyless.json")
	const report = calibrationReportSchema.parse({
		schemaVersion: 1,
		taskIdentity: "task@1",
		fixtureInitiallyFails: true,
		gold: { repetitions: 20, passed: 20 },
		broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [],
		humanReview: { unresolvedFalsePositivePasses: 0, reviewedTrialIds: [] },
		admitted: false,
	})
	const bytes = JSON.stringify(report, null, 2) + "\n"
	await fs.writeFile(file, bytes)
	return { root, file, report, bytes, revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
}

afterEach(async () => {
	await Promise.all(actors.splice(0).map((process) => process.terminate()))
	for (const { root, parent } of roots.splice(0)) {
		const relative = path.relative(parent, await fs.realpath(root))
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Calibration fixture cleanup escaped its temporary directory")
		await fs.rm(root, { recursive: true, force: true })
	}
})

describe("calibration report transactions across processes", () => {
	it("retains both independently written model arms after observed lock contention", async () => {
		const { file, root } = await fixture()
		const [first, second] = await Promise.all([actor(file), actor(file)])
		const firstUpdate = first.update({ model: "luna-high", prefix: "luna", holdPublication: true })
		await first.waitFor("held", 1)
		const secondUpdate = second.update({ model: "sol-high", prefix: "sol" })
		await second.waitFor("contended", 1)
		first.release()
		expect(await firstUpdate).toMatchObject({ ok: true, callbackCount: 1 })
		expect(await secondUpdate).toMatchObject({ ok: true, callbackCount: 1 })
		const saved = calibrationReportSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
		expect(saved.models.map(({ model }) => model).sort()).toEqual(["luna-high", "sol-high"])
		expect(saved.models.flatMap(({ trialIds }) => trialIds).sort()).toEqual(
			["luna", "sol"].flatMap((prefix) => Array.from({ length: 5 }, (_, index) => `${prefix}-${index}`)),
		)
		expect(await fs.readdir(root)).toEqual(["task.keyless.json"])
	}, 15_000)

	it("rejects a stale raw-byte revision in another process before invoking its updater", async () => {
		const { file, root, revision } = await fixture()
		const [first, stale] = await Promise.all([actor(file), actor(file)])
		expect(await first.update({ model: "luna-high", prefix: "fresh" })).toMatchObject({ ok: true })
		const current = await fs.readFile(file, "utf8")
		expect(await stale.update({ model: "sol-high", prefix: "stale", expectedRevision: revision })).toMatchObject({
			ok: false,
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "revision",
			callbackCount: 0,
		})
		expect(await fs.readFile(file, "utf8")).toBe(current)
		expect(await fs.readdir(root)).toEqual(["task.keyless.json"])
	}, 15_000)

	it("retains the original report after a writer is killed before publication and refuses its orphan lock", async () => {
		const { file, bytes, report } = await fixture()
		const interrupted = await actor(file)
		const interruptedUpdate = interrupted.update({ model: "luna-high", prefix: "aborted", holdPublication: true })
		await interrupted.waitFor("held", 1)
		await interrupted.terminate()
		expect(await interruptedUpdate).toMatchObject({ ok: false, code: "CHILD_EXITED" })
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
		expect(calibrationReportSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))).toEqual(report)
		const lock = `${file}.calibration.lock`
		const orphan = await fs.readFile(lock, "utf8")
		const contender = await actor(file)
		expect(await contender.update({ model: "sol-high", prefix: "later", lockTimeoutMs: 0 })).toMatchObject({
			ok: false,
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "locked",
			callbackCount: 0,
		})
		expect(await fs.readFile(lock, "utf8")).toBe(orphan)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
	}, 15_000)
})
