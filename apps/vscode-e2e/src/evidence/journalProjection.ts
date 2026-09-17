import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"

import { rejectSymlinkComponents } from "./paths"

type TaskSourceWarning =
	| "TASK_SOURCE_LIMIT"
	| "TASK_SOURCE_CHANGED"
	| "JOURNAL_LINE_LIMIT"
	| "JOURNAL_EVENT_LIMIT"
	| "JOURNAL_MALFORMED"

/** Closed codes only: never publish filesystem errors or offending record contents. */
export class TaskSourceError extends Error {
	constructor(readonly warning: TaskSourceWarning) {
		super(warning)
	}
}

function bounded(value: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("Invalid task source limit")
}

function sameSource(left: BigIntStats, right: BigIntStats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	)
}

/** Hash every raw byte while retaining only a chunk and the consumer's bounded projection. */
async function visitSource(filePath: string, maxBytes: number, visit: (chunk: Buffer) => void) {
	bounded(maxBytes, 64 * 1_024 * 1_024)
	await rejectSymlinkComponents(filePath)
	const before = await fs.lstat(filePath, { bigint: true })
	if (!before.isFile()) throw new TaskSourceError("TASK_SOURCE_CHANGED")
	if (before.size > BigInt(maxBytes)) throw new TaskSourceError("TASK_SOURCE_LIMIT")
	const handle = await fs.open(filePath, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new TaskSourceError("TASK_SOURCE_CHANGED")
		throw error
	})
	try {
		const opened = await handle.stat({ bigint: true })
		if (!sameSource(before, opened)) throw new TaskSourceError("TASK_SOURCE_CHANGED")
		const hash = createHash("sha256")
		const buffer = Buffer.alloc(Math.min(64 * 1_024, maxBytes + 1))
		let bytes = 0
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), bytes)
			if (bytesRead === 0) break
			bytes += bytesRead
			if (bytes > maxBytes) throw new TaskSourceError("TASK_SOURCE_LIMIT")
			const chunk = buffer.subarray(0, bytesRead)
			hash.update(chunk)
			visit(chunk)
		}
		const after = await handle.stat({ bigint: true })
		await rejectSymlinkComponents(filePath)
		const named = await fs.lstat(filePath, { bigint: true })
		if (BigInt(bytes) !== opened.size || !sameSource(opened, after) || !sameSource(opened, named)) {
			throw new TaskSourceError("TASK_SOURCE_CHANGED")
		}
		return { sourceBytes: bytes, sourceSha256: hash.digest("hex") }
	} catch (error) {
		// Once observed, a disappearing transcript is unstable evidence, not a pre-provider absence.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TaskSourceError("TASK_SOURCE_CHANGED")
		throw error
	} finally {
		await handle.close()
	}
}

/** Non-JSONL task/control sources still have an explicit whole-source allocation/parse ceiling. */
export async function readTaskSource(filePath: string, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = []
	const source = await visitSource(filePath, maxBytes, (chunk) => chunks.push(Buffer.from(chunk)))
	return Buffer.concat(chunks, source.sourceBytes)
}

export async function projectJournalSource(
	filePath: string,
	limits: { maxSourceBytes: number; maxLineBytes: number; maxEvents: number },
	project: (raw: unknown) => unknown,
) {
	bounded(limits.maxLineBytes, 4 * 1_024 * 1_024)
	bounded(limits.maxEvents, 10_000)
	const events: unknown[] = []
	let records = 0
	let pending: Buffer = Buffer.alloc(0)
	const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
	const consume = (line: Buffer) => {
		if (line.length > limits.maxLineBytes) throw new TaskSourceError("JOURNAL_LINE_LIMIT")
		if (line.at(-1) === 13) line = line.subarray(0, -1)
		if (line.length === 0) return
		// Count unknown records too; an unrecognized event cannot bypass the work bound.
		if (++records > limits.maxEvents) throw new TaskSourceError("JOURNAL_EVENT_LIMIT")
		let raw: unknown
		try {
			raw = JSON.parse(decode.decode(line))
		} catch {
			throw new TaskSourceError("JOURNAL_MALFORMED")
		}
		const value = project(raw)
		if (value !== undefined) events.push(value)
	}
	const source = await visitSource(filePath, limits.maxSourceBytes, (chunk) => {
		const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
		let start = 0
		for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
			consume(data.subarray(start, end))
			start = end + 1
		}
		if (data.length - start > limits.maxLineBytes) throw new TaskSourceError("JOURNAL_LINE_LIMIT")
		// The underlying read buffer is reused; retain only the unfinished bounded record.
		pending = Buffer.from(data.subarray(start))
	})
	if (pending.length) consume(pending)
	return { ...source, projection: { events, complete: true } }
}
