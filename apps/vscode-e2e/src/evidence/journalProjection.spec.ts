import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"

import { joinProjectedEvidence, projectJournalSource, readTaskSource, TaskSourceError } from "./journalProjection"

let root: string
let file: string
const underlying = createRequire(__filename)("node:fs/promises") as typeof fs
const limits = { maxSourceBytes: 4 * 1_024 * 1_024, maxLineBytes: 256 * 1_024, maxEvents: 2_000 }
const project = (raw: unknown) => raw

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-journal-test-")))
	file = path.join(root, "journal.jsonl")
})
afterEach(async () => {
	mock.restoreAll()
	await fs.rm(root, { recursive: true, force: true })
})

function code(warning: TaskSourceError["warning"]) {
	return (error: unknown) => error instanceof TaskSourceError && error.warning === warning
}

function observeHandles(onHandle?: (handle: Awaited<ReturnType<typeof fs.open>>) => void) {
	let opened = 0
	let closed = 0
	const open = underlying.open
	mock.method(underlying, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args)
		opened++
		const close = handle.close.bind(handle)
		handle.close = async () => {
			closed++
			await close()
		}
		onHandle?.(handle)
		return handle
	})
	return () => ({ opened, closed })
}

test("streams arbitrary short reads, split UTF-8, CRLF, blank lines and final unterminated record exactly", async () => {
	const content = '\r\n{"value":"é🍋"}\r\n\n{"status":"completed"}'
	await fs.writeFile(file, content)
	const handles = observeHandles((handle) => {
		const read = handle.read.bind(handle)
		handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
			read(buffer, offset, Math.min(length, 1), position)) as typeof handle.read
	})
	const result = await projectJournalSource(file, limits, project)
	assert.equal(result.sourceBytes, Buffer.byteLength(content))
	assert.equal(result.sourceSha256, createHash("sha256").update(content).digest("hex"))
	assert.deepEqual(result.projection, {
		events: [{ value: "é🍋" }, { status: "completed" }],
		captureStatus: "captured",
		validationStatus: "unverified",
		warnings: ["JOURNAL_VALIDATION_UNVERIFIED"],
		complete: false,
	})
	assert.equal((await readTaskSource(file, limits.maxSourceBytes)).toString("utf8"), content)
	assert.deepEqual(handles(), { opened: 2, closed: 2 })
})

test("enforces exact source and line byte boundaries without treating a prefix as complete", async () => {
	const content = JSON.stringify({ type: "turn_terminal", status: "completed" })
	await fs.writeFile(file, content)
	const bytes = Buffer.byteLength(content)
	assert.equal(
		(await projectJournalSource(file, { ...limits, maxSourceBytes: bytes, maxLineBytes: bytes }, project))
			.projection.complete,
		false,
	)
	const handles = observeHandles()
	await assert.rejects(
		projectJournalSource(file, { ...limits, maxSourceBytes: bytes - 1 }, project),
		code("TASK_SOURCE_LIMIT"),
	)
	assert.deepEqual(handles(), { opened: 0, closed: 0 })
	await assert.rejects(readTaskSource(file, bytes - 1), code("TASK_SOURCE_LIMIT"))
	await assert.rejects(
		projectJournalSource(file, { ...limits, maxLineBytes: bytes - 1 }, project),
		code("JOURNAL_LINE_LIMIT"),
	)
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
	assert.equal(await fs.readFile(file, "utf8"), content)
})

test("bounds unfinished records across chunks and closes the descriptor on overflow", async () => {
	await fs.writeFile(file, JSON.stringify({ payload: "X".repeat(300_000) }))
	const handles = observeHandles()
	await assert.rejects(projectJournalSource(file, limits, project), code("JOURNAL_LINE_LIMIT"))
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("counts unknown records toward the event budget and preserves the final event at the exact boundary", async () => {
	await fs.writeFile(file, '{"type":"unknown"}\n{"type":"turn_terminal"}\n')
	const handles = observeHandles()
	assert.deepEqual((await projectJournalSource(file, { ...limits, maxEvents: 2 }, project)).projection.events, [
		{ type: "unknown" },
		{ type: "turn_terminal" },
	])
	await assert.rejects(
		projectJournalSource(file, { ...limits, maxEvents: 1 }, () => undefined),
		code("JOURNAL_EVENT_LIMIT"),
	)
	assert.deepEqual(handles(), { opened: 2, closed: 2 })
})

test("rejects malformed, truncated and invalid UTF-8 records without leaking raw bytes", async () => {
	const secret = "private-malformed-payload"
	const handles = observeHandles()
	for (const content of [
		Buffer.from("{}\n" + secret),
		Buffer.from('{}\n{"unfinished":'),
		Buffer.from([123, 34, 255, 34, 58, 49, 125]),
	]) {
		await fs.writeFile(file, content)
		await assert.rejects(projectJournalSource(file, limits, project), (error: unknown) => {
			assert.ok(code("JOURNAL_MALFORMED")(error))
			assert.ok(!String(error).includes(secret))
			return true
		})
	}
	assert.deepEqual(handles(), { opened: 3, closed: 3 })
})

test("detects same-file mutation after a read and never emits a stable-source hash", async () => {
	await fs.writeFile(file, '{"status":"completed"}')
	let changed = false
	const handles = observeHandles((handle) => {
		const read = handle.read.bind(handle)
		handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
			const result = await read(buffer, offset, length, position)
			if (!changed) {
				changed = true
				await fs.appendFile(file, "\n{}")
			}
			return result
		}) as typeof handle.read
	})
	await assert.rejects(projectJournalSource(file, limits, project), code("TASK_SOURCE_CHANGED"))
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("stops a growing source at the byte ceiling and releases its handle", async () => {
	await fs.writeFile(file, "{}")
	let changed = false
	const handles = observeHandles((handle) => {
		const read = handle.read.bind(handle)
		handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
			const result = await read(buffer, offset, length, position)
			if (!changed) {
				changed = true
				await fs.appendFile(file, "\n{}")
			}
			return result
		}) as typeof handle.read
	})
	await assert.rejects(
		projectJournalSource(file, { ...limits, maxSourceBytes: 2 }, project),
		code("TASK_SOURCE_LIMIT"),
	)
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("rejects a deleted source, including Windows delete-pending paths, rather than reporting original absence", async () => {
	await fs.writeFile(file, "{}")
	let removed = false
	const handles = observeHandles((handle) => {
		const read = handle.read.bind(handle)
		handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
			const result = await read(buffer, offset, length, position)
			if (!removed) {
				removed = true
				await fs.unlink(file)
			}
			return result
		}) as typeof handle.read
	})
	await assert.rejects(
		readTaskSource(file, limits.maxSourceBytes),
		(error: unknown) =>
			code("TASK_SOURCE_CHANGED")(error) ||
			(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM"),
	)
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
	await assert.rejects(readTaskSource(file, limits.maxSourceBytes), { code: "ENOENT" })
})

test("translates ENOENT after observation into unstable evidence instead of benign transcript absence", async () => {
	await fs.writeFile(file, "{}")
	const handles = observeHandles()
	const lstat = underlying.lstat
	let fileStats = 0
	mock.method(underlying, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === file && ++fileStats >= 3) throw Object.assign(new Error("missing"), { code: "ENOENT" })
		return lstat(...args)
	})
	await assert.rejects(readTaskSource(file, limits.maxSourceBytes), code("TASK_SOURCE_CHANGED"))
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("rejects descriptor identity drift before reading and closes the opened handle", async () => {
	await fs.writeFile(file, "{}")
	const handles = observeHandles((handle) => {
		const stat = handle.stat.bind(handle)
		handle.stat = (async () => {
			const value = await stat({ bigint: true })
			value.ino++
			return value
		}) as typeof handle.stat
	})
	await assert.rejects(projectJournalSource(file, limits, project), code("TASK_SOURCE_CHANGED"))
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("rejects replacement of the named path even if the open descriptor remained stable", async () => {
	await fs.writeFile(file, "{}")
	const handles = observeHandles()
	const lstat = underlying.lstat
	let fileStats = 0
	mock.method(underlying, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		const value = await lstat(...args)
		if (String(args[0]) === file && ++fileStats >= 3) {
			value.ino = typeof value.ino === "bigint" ? value.ino + 1n : value.ino + 4_096
		}
		return value
	})
	await assert.rejects(projectJournalSource(file, limits, project), code("TASK_SOURCE_CHANGED"))
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
})

test("rejects linked source components and invalid hard ceilings before opening a file", async () => {
	const target = path.join(root, "target")
	await fs.mkdir(target)
	await fs.writeFile(path.join(target, "journal.jsonl"), "{}")
	await fs.symlink(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
	const handles = observeHandles()
	await assert.rejects(projectJournalSource(path.join(root, "link", "journal.jsonl"), limits, project), /symlink/)
	for (const override of [
		{ maxSourceBytes: 64 * 1_024 * 1_024 + 1 },
		{ maxLineBytes: 4 * 1_024 * 1_024 + 1 },
		{ maxEvents: 10_001 },
		{ maxEvents: 0 },
	]) {
		await assert.rejects(
			projectJournalSource(file, { ...limits, ...override }, project),
			/Invalid task source limit/,
		)
	}
	assert.deepEqual(handles(), { opened: 0, closed: 0 })
})

test("closes a source handle when reading fails or projection rejects a record", async () => {
	await fs.writeFile(file, "{}")
	const failure = new Error("read failure")
	const handles = observeHandles((handle) => {
		handle.read = (async () => {
			throw failure
		}) as typeof handle.read
	})
	await assert.rejects(readTaskSource(file, limits.maxSourceBytes), (error) => error === failure)
	assert.deepEqual(handles(), { opened: 1, closed: 1 })
	mock.restoreAll()
	const projectionHandles = observeHandles()
	await assert.rejects(
		projectJournalSource(file, limits, () => {
			throw failure
		}),
		(error) => error === failure,
	)
	assert.deepEqual(projectionHandles(), { opened: 1, closed: 1 })
})

test("validates lifecycle sequence resets per turn while additive logs stay per run", async () => {
	const rows = [
		{ runIdSha256: "run", turnIdSha256: "turn-a", sequence: 1, type: "turn_started" },
		{ runIdSha256: "run", turnIdSha256: "turn-a", sequence: 2, type: "turn_terminal" },
		{ runIdSha256: "run", turnIdSha256: "turn-b", sequence: 1, type: "turn_started" },
		{ runIdSha256: "run", turnIdSha256: "turn-b", sequence: 2, type: "turn_terminal" },
	]
	await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n"))
	const lifecycle = await projectJournalSource(file, limits, (row) => row, "turn")
	assert.equal(lifecycle.projection.validationStatus, "validated")
	assert.equal(lifecycle.projection.complete, true)
	const additive = await projectJournalSource(file, limits, (row) => row)
	assert.equal(additive.projection.validationStatus, "incomplete")
	assert.equal(additive.projection.complete, false)
})

test("joins hashed lifecycle and additive identities while preserving missing markers", () => {
	const lifecycle = {
		taskIdSha256: "task",
		runIdSha256: "run",
		turnIdSha256: "turn",
		stepIdSha256: "step",
		sequence: 2,
		type: "turn_terminal",
	}
	const eventLog = {
		taskIdSha256: "task",
		runIdSha256: "run",
		turnIdSha256: "turn",
		stepIdSha256: "step",
		requestIdSha256: "request",
		attemptIdSha256: "attempt",
		sequence: 7,
		type: "response_terminal",
	}
	const result = joinProjectedEvidence({ lifecycle: [lifecycle], eventLog: [eventLog] })
	assert.deepEqual(result.missing, ["lifecycle:attemptIdSha256", "lifecycle:requestIdSha256"])
	assert.deepEqual(result.records, [
		{
			identity: {
				taskIdSha256: "task",
				runIdSha256: "run",
				turnIdSha256: "turn",
				stepIdSha256: "step",
				requestIdSha256: "request",
				attemptIdSha256: "attempt",
			},
			lifecycleSequences: [2],
			eventLogSequences: [7],
			eventTypes: ["turn_terminal", "response_terminal"],
			identityConflicts: [],
			status: "joined",
		},
	])
})

test("joins matching task turns and steps when producer-local run IDs differ", () => {
	const common = { taskIdSha256: "task", turnIdSha256: "turn", stepIdSha256: "step" }
	const result = joinProjectedEvidence({
		lifecycle: [{ ...common, runIdSha256: "lifecycle-run", sequence: 2, type: "tool_call_accepted" }],
		eventLog: [{ ...common, runIdSha256: "event-log-run", sequence: 7, type: "tool_result" }],
	})
	assert.equal(result.records[0]?.status, "joined")
	assert.equal(result.records[0]?.identity.runIdSha256, undefined)
	assert.deepEqual(result.records[0]?.sourceRunIds, {
		lifecycle: ["lifecycle-run"],
		eventLog: ["event-log-run"],
	})
})

test("retains an identity conflict marker after contradictory optional IDs", () => {
	const base = { taskIdSha256: "task", runIdSha256: "run", turnIdSha256: "turn", stepIdSha256: "step" }
	const result = joinProjectedEvidence({
		lifecycle: [
			{ ...base, requestIdSha256: "request-a", sequence: 1, type: "turn_started" },
			{ ...base, requestIdSha256: "request-b", sequence: 2, type: "phase_changed" },
		],
		eventLog: [{ ...base, requestIdSha256: "request-a", sequence: 1, type: "progress" }],
	})
	assert.deepEqual(result.records[0]?.identityConflicts, ["requestIdSha256"])
	assert.equal(result.records[0]?.identity.requestIdSha256, undefined)
})

test("keeps rows without stable task-step identity partial", () => {
	const result = joinProjectedEvidence({
		lifecycle: [{ sequence: 1, type: "turn_started" }],
		eventLog: [{ sequence: 1, type: "progress" }],
	})
	assert.equal(result.records[0]?.status, "partial")
	assert.ok(result.missing.includes("lifecycle:taskIdSha256"))
	assert.ok(result.missing.includes("eventLog:stepIdSha256"))
})

test("marks dropped rows and sequence gaps incomplete despite a stable byte capture", async () => {
	await fs.writeFile(
		file,
		[
			JSON.stringify({ runIdSha256: "run", sequence: 1, type: "turn_started" }),
			JSON.stringify({ runIdSha256: "run", sequence: 3, type: "turn_terminal" }),
			JSON.stringify({ runIdSha256: "run", sequence: 3, type: "turn_terminal" }),
			JSON.stringify({ runIdSha256: "run", sequence: 99, type: "progress" }),
		].join("\n"),
	)
	const result = await projectJournalSource(file, limits, (raw) => {
		if ((raw as { sequence?: number }).sequence === 99) return undefined
		return raw
	})
	assert.equal(result.sourceBytes > 0, true)
	assert.equal(result.projection.complete, false)
	assert.equal(result.projection.validationStatus, "incomplete")
	assert.deepEqual(result.projection.warnings, ["JOURNAL_EVENT_DROPPED", "JOURNAL_SEQUENCE_INVALID"])
})
