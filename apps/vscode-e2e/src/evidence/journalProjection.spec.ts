import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"

import { projectJournalSource, readTaskSource, TaskSourceError } from "./journalProjection"

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
	assert.deepEqual(result.projection, { events: [{ value: "é🍋" }, { status: "completed" }], complete: true })
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
		true,
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
