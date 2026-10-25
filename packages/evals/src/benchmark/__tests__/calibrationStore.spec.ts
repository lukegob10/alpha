import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { calibrationReportSchema, type CalibrationReport } from "../contracts"
import { mergeModelCalibration, type ModelCalibrationTrial } from "../modelCalibration"
import { CalibrationReportValidationError, readCalibrationReport, updateCalibrationReport } from "../calibrationStore"

const roots: string[] = []
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const lockPath = (file: string) => `${file}.calibration.lock`

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function report(): CalibrationReport {
	return calibrationReportSchema.parse({
		schemaVersion: 1,
		taskIdentity: "task@1",
		fixtureInitiallyFails: true,
		gold: { repetitions: 20, passed: 20 },
		broken: ["a", "b", "c"].map((id) => ({ id, repetitions: 20, rejected: 20, expectedCode: "wrong-output" })),
		determinism: { repetitions: 50, distinctDigests: 1 },
		models: [],
		humanReview: { unresolvedFalsePositivePasses: 0, reviewedTrialIds: [], reviewer: "", qualityApproved: false },
		admitted: false,
	})
}

function trials(model: ModelCalibrationTrial["model"]): ModelCalibrationTrial[] {
	return Array.from({ length: 5 }, (_, index) => ({
		id: `${model}-${index}`,
		taskIdentity: "task@1",
		model,
		passed: true,
		unexpected: false,
		safetyFailed: false,
		reviewed: false,
	}))
}

async function fixture(value = report()) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "calibration-store-")))
	roots.push(root)
	const file = path.join(root, "task.keyless.json")
	const bytes = JSON.stringify(value) + "\n"
	await fs.writeFile(file, bytes)
	return { root, file, bytes }
}

afterEach(async () => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) {
		const relative = path.relative(await fs.realpath(os.tmpdir()), path.resolve(root))
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Refusing cleanup outside the owned temporary directory")
		await fs.rm(root, { recursive: true, force: true })
	}
})

describe("calibration report publication", () => {
	it("reads legacy schema without adding persisted revisions and binds exact retained bytes", async () => {
		const { file, bytes } = await fixture()
		const snapshot = await readCalibrationReport(file)
		expect(snapshot.report).toEqual(report())
		expect(snapshot.revision).toBe(digest(bytes))
		await fs.writeFile(file, JSON.stringify(report(), null, 2))
		expect((await readCalibrationReport(file)).revision).not.toBe(snapshot.revision)
		expect(await fs.readFile(file, "utf8")).not.toContain('"revision"')
	})

	it("returns missing without creating absent parent directories", async () => {
		const { root } = await fixture()
		const missing = path.join(root, "absent", "report.json")
		expect(await readCalibrationReport(missing)).toEqual({ report: undefined, revision: null })
		await expect(fs.stat(path.dirname(missing))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("creates a schema-valid report under a missing revision and cleans publication resources", async () => {
		const { root } = await fixture()
		const file = path.join(root, "new", "report.json")
		const saved = await updateCalibrationReport(file, () => report(), { expectedRevision: null })
		expect(saved).toEqual(await readCalibrationReport(file))
		expect(await fs.readdir(path.dirname(file))).toEqual(["report.json"])
		await expect(updateCalibrationReport(file, () => report(), { expectedRevision: null })).rejects.toMatchObject({
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "revision",
		})
	})

	it("rejects stale revisions before invoking a callback", async () => {
		const { file, bytes } = await fixture()
		const stale = await readCalibrationReport(file)
		const newer = { ...report(), humanReview: { ...report().humanReview, reviewer: "newer" } }
		await updateCalibrationReport(file, () => newer)
		const updater = vi.fn(() => report())
		await expect(
			updateCalibrationReport(file, updater, { expectedRevision: stale.revision }),
		).rejects.toMatchObject({
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "revision",
		})
		expect(updater).not.toHaveBeenCalled()
		expect((await readCalibrationReport(file)).report).toEqual(newer)
		expect(await fs.readFile(file, "utf8")).not.toBe(bytes)
	})

	it("treats an undefined result as no-op even when its private input was mutated", async () => {
		const { root, file, bytes } = await fixture()
		const before = await readCalibrationReport(file)
		const after = await updateCalibrationReport(file, (current) => {
			current!.humanReview.reviewer = "discarded mutation"
			return undefined
		})
		expect(after).toEqual(before)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
		expect(await fs.readdir(root)).toEqual([path.basename(file)])
	})

	it.each(["throw", "schema", "async"])("preserves retained bytes after an invalid %s updater", async (kind) => {
		const { root, file, bytes } = await fixture()
		const updater =
			kind === "throw"
				? () => {
						throw new Error("owned callback failed")
					}
				: kind === "schema"
					? () => ({ ...report(), admitted: "false" })
					: async () => report()
		await expect(updateCalibrationReport(file, updater as never)).rejects.toThrow()
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
		expect(await fs.readdir(root)).toEqual([path.basename(file)])
	})

	it("merges independent model arms against the latest locked report without retrying either callback", async () => {
		const { root, file } = await fixture()
		const entered = barrier()
		const release = barrier()
		const contended = barrier()
		const realRename = fs.rename.bind(fs)
		const realOpen = fs.open.bind(fs)
		vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
			entered.resolve()
			await release.promise
			await realRename(...args)
		})
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			try {
				return await realOpen(...args)
			} catch (error) {
				if (String(args[0]) === lockPath(file) && (error as NodeJS.ErrnoException).code === "EEXIST")
					contended.resolve()
				throw error
			}
		})
		const first = vi.fn((current) => mergeModelCalibration(current, trials("luna-high")))
		const second = vi.fn((current) => mergeModelCalibration(current, trials("sol-high")))
		const firstWrite = updateCalibrationReport(file, first)
		await entered.promise
		const secondWrite = updateCalibrationReport(file, second)
		await contended.promise
		release.resolve()
		await Promise.all([firstWrite, secondWrite])
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)
		expect((await readCalibrationReport(file)).report!.models.map(({ model }) => model).sort()).toEqual([
			"luna-high",
			"sol-high",
		])
		expect(await fs.readdir(root)).toEqual([path.basename(file)])
	})

	it("does not age-steal an orphan lock or invoke the updater", async () => {
		const { file, bytes } = await fixture()
		const metadata = JSON.stringify({ schemaVersion: 1, pid: 0, nonce: "retained-orphan" })
		await fs.writeFile(lockPath(file), metadata)
		await fs.utimes(lockPath(file), new Date(0), new Date(0))
		const updater = vi.fn(() => report())
		await expect(updateCalibrationReport(file, updater, { lockTimeoutMs: 0 })).rejects.toMatchObject({
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "locked",
		})
		expect(updater).not.toHaveBeenCalled()
		expect(await fs.readFile(lockPath(file), "utf8")).toBe(metadata)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
	})

	it("continues acquisition when a contending lock disappears before inspection", async () => {
		const { root, file } = await fixture()
		const realOpen = fs.open.bind(fs)
		let attempts = 0
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]) === lockPath(file) && attempts++ === 0)
				throw Object.assign(new Error("Contender released its lock"), { code: "EEXIST" })
			return realOpen(...args)
		})
		const updater = vi.fn(() => report())
		await updateCalibrationReport(file, updater)
		expect(attempts).toBe(2)
		expect(updater).toHaveBeenCalledTimes(1)
		expect(await fs.readdir(root)).toEqual([path.basename(file)])
	})

	it("closes the acquired lock handle if its identity cannot be inspected", async () => {
		const { file, bytes } = await fixture()
		const failure = new Error("Owned fstat failed")
		const realOpen = fs.open.bind(fs)
		const closed = vi.fn()
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args)
			if (String(args[0]) === lockPath(file)) {
				vi.spyOn(handle, "stat").mockRejectedValueOnce(failure)
				const realClose = handle.close.bind(handle)
				vi.spyOn(handle, "close").mockImplementation(async () => {
					closed()
					await realClose()
				})
			}
			return handle
		})
		await expect(updateCalibrationReport(file, () => report())).rejects.toBe(failure)
		expect(closed).toHaveBeenCalledTimes(1)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
		// No identity is available to justify unlinking the path; retain it for explicit orphan recovery.
		expect((await fs.lstat(lockPath(file))).isFile()).toBe(true)
	})

	it("does not unlink another writer's replacement lock during cleanup", async () => {
		const { file, bytes } = await fixture()
		const replacement = "a different writer owns this lock"
		const realOpen = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args)
			if (String(args[0]).endsWith(".partial")) {
				await fs.rename(lockPath(file), `${file}.owned-lock-backup`)
				await fs.writeFile(lockPath(file), replacement)
			}
			return handle
		})
		await expect(updateCalibrationReport(file, () => report())).rejects.toThrow(/cleanup/i)
		expect(await fs.readFile(lockPath(file), "utf8")).toBe(replacement)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
	})

	it("refuses to publish or unlink a replaced temporary file", async () => {
		const { file, bytes } = await fixture()
		const realOpen = fs.open.bind(fs)
		let temporaryPath: string | undefined
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args)
			if (String(args[0]).endsWith(".partial")) {
				temporaryPath = String(args[0])
				const realSync = handle.sync.bind(handle)
				vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
					await realSync()
					await fs.rename(temporaryPath!, `${temporaryPath}.owned-backup`)
					await fs.writeFile(temporaryPath!, "foreign temporary bytes")
				})
			}
			return handle
		})
		await expect(updateCalibrationReport(file, () => report())).rejects.toThrow(/cleanup/i)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
		expect(await fs.readFile(temporaryPath!, "utf8")).toBe("foreign temporary bytes")
		await expect(fs.stat(lockPath(file))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("exposes bounded schema diagnostics without received private values", async () => {
		const { file } = await fixture()
		const secret = "private-report-value-must-not-leak"
		await fs.writeFile(file, JSON.stringify({ ...report(), schemaVersion: secret }))
		try {
			await readCalibrationReport(file)
			throw new Error("Expected invalid schema")
		} catch (error) {
			expect(error).toBeInstanceOf(CalibrationReportValidationError)
			const validation = error as CalibrationReportValidationError
			expect(validation.code).toBe("CALIBRATION_REPORT_INVALID")
			expect(validation.issues).toEqual([
				{ message: "Invalid calibration field schemaVersion (invalid_literal)" },
			])
			expect(JSON.stringify(validation)).not.toContain(secret)
		}
	})

	it.each(["sync", "rename"])(
		"preserves the original report and cleans owned resources after failed %s",
		async (phase) => {
			const { root, file, bytes } = await fixture()
			const failure = new Error(`owned ${phase} failed`)
			if (phase === "rename") vi.spyOn(fs, "rename").mockRejectedValueOnce(failure)
			else {
				const realOpen = fs.open.bind(fs)
				vi.spyOn(fs, "open").mockImplementation(async (...args) => {
					const handle = await realOpen(...args)
					if (String(args[0]).endsWith(".partial")) vi.spyOn(handle, "sync").mockRejectedValueOnce(failure)
					return handle
				})
			}
			await expect(updateCalibrationReport(file, () => report())).rejects.toBe(failure)
			expect(await fs.readFile(file, "utf8")).toBe(bytes)
			expect(await fs.readdir(root)).toEqual([path.basename(file)])
		},
	)

	it("detects a noncooperating edit made after the updater without overwriting it", async () => {
		const { root, file } = await fixture()
		const externalBytes = JSON.stringify({
			...report(),
			humanReview: { ...report().humanReview, reviewer: "external" },
		})
		const realOpen = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args)
			if (String(args[0]).endsWith(".partial")) await fs.writeFile(file, externalBytes)
			return handle
		})
		await expect(updateCalibrationReport(file, () => report())).rejects.toMatchObject({
			code: "CALIBRATION_REPORT_CONFLICT",
			reason: "revision",
		})
		expect(await fs.readFile(file, "utf8")).toBe(externalBytes)
		expect(await fs.readdir(root)).toEqual([path.basename(file)])
	})

	it("snapshots the expected revision before filesystem awaits", async () => {
		const { file, bytes } = await fixture()
		const options = { expectedRevision: "sha256:stale" }
		const entered = barrier()
		const release = barrier()
		const realOpen = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (String(args[0]) === lockPath(file)) {
				entered.resolve()
				await release.promise
			}
			return realOpen(...args)
		})
		const write = updateCalibrationReport(file, () => report(), options)
		await entered.promise
		options.expectedRevision = digest(bytes)
		release.resolve()
		await expect(write).rejects.toMatchObject({ reason: "revision" })
	})

	it("rejects hard-linked report aliases before invoking an updater", async () => {
		const { root, file, bytes } = await fixture()
		const alias = path.join(root, "alias.json")
		await fs.link(file, alias)
		await expect(readCalibrationReport(alias)).rejects.toThrow(/hard.link/i)
		const updater = vi.fn(() => report())
		await expect(updateCalibrationReport(file, updater)).rejects.toThrow(/hard.link/i)
		expect(updater).not.toHaveBeenCalled()
		expect(await fs.readFile(alias, "utf8")).toBe(bytes)
	})

	it("rejects symlinked parent paths and lock paths", async () => {
		const { root, file, bytes } = await fixture()
		const alias = path.join(root, "alias")
		const actual = path.join(root, "actual")
		await fs.mkdir(actual)
		await fs.writeFile(path.join(actual, "report.json"), bytes)
		await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
		await expect(readCalibrationReport(path.join(alias, "report.json"))).rejects.toThrow(/symlink/i)
		await expect(updateCalibrationReport(path.join(alias, "report.json"), () => report())).rejects.toThrow(
			/symlink/i,
		)
		await fs.symlink(actual, lockPath(file), process.platform === "win32" ? "junction" : "dir")
		await expect(updateCalibrationReport(file, () => report(), { lockTimeoutMs: 0 })).rejects.toThrow(/unaliased/i)
		expect(await fs.readFile(file, "utf8")).toBe(bytes)
	})

	it("bounds report reads and rejects invalid lock deadlines before creating resources", async () => {
		const { root, file } = await fixture()
		await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1))
		await expect(readCalibrationReport(file)).rejects.toThrow(/bounded/i)
		for (const lockTimeoutMs of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 30_001])
			await expect(
				updateCalibrationReport(path.join(root, "absent", "report.json"), () => report(), { lockTimeoutMs }),
			).rejects.toThrow(/timeout/i)
		await expect(fs.stat(path.join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects unsafe target names before creating directories or opening sidecars", async () => {
		const { root } = await fixture()
		const open = vi.spyOn(fs, "open")
		const mkdir = vi.spyOn(fs, "mkdir")
		for (const name of [
			"report.json:stream",
			"NUL",
			"COM1.json",
			"aux .json",
			"report.json.",
			"report.json ",
			"bad\0name",
		])
			await expect(
				updateCalibrationReport(path.join(root, "not-created", name), () => report()),
			).rejects.toThrow()
		for (const file of ["", ".", "..", `${root}${path.sep}`])
			await expect(updateCalibrationReport(file, () => report())).rejects.toThrow()
		expect(open).not.toHaveBeenCalled()
		expect(mkdir).not.toHaveBeenCalled()
		await expect(fs.stat(path.join(root, "not-created"))).rejects.toMatchObject({ code: "ENOENT" })
	})
})
