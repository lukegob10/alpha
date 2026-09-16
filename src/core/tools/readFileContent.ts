import { createHash } from "crypto"
import type { FileEntry } from "@alpha-code/types"
import { readWithIndentation } from "../../integrations/misc/indentation-reader"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"

type Range = [number, number]
interface Cursor {
	v: 1
	file: string
	version: string
	ranges: Range[]
	column: number
	limit: number
}

export interface FileReadContent {
	path: string
	lines: string[]
	cursor: Cursor
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0

function decode(value: string): Cursor {
	if (value.length > 8192) throw new Error("Invalid read continuation: too large.")
	let cursor: Cursor
	try {
		cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor
	} catch {
		throw new Error("Invalid read continuation.")
	}
	if (
		!cursor ||
		cursor.v !== 1 ||
		typeof cursor.file !== "string" ||
		typeof cursor.version !== "string" ||
		!positive(cursor.limit) ||
		!Number.isSafeInteger(cursor.column) ||
		cursor.column < 0 ||
		!Array.isArray(cursor.ranges) ||
		cursor.ranges.length === 0 ||
		cursor.ranges.length > 64 ||
		cursor.ranges.some(
			(range, i) =>
				!Array.isArray(range) ||
				range.length !== 2 ||
				!positive(range[0]) ||
				!positive(range[1]) ||
				range[0] > range[1] ||
				(i > 0 && range[0] <= cursor.ranges[i - 1]![1]),
		)
	) {
		throw new Error("Invalid read continuation.")
	}
	return cursor
}

/** Source selection is separate from rendering so every file shares the actual result allowance. */
export function prepareFileRead(content: string, identity: string, entry: FileEntry): FileReadContent {
	const lines =
		content === "" ? [] : content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
	const version = hash(content)
	const file = hash(identity)
	if (entry.continuation) {
		const cursor = decode(entry.continuation)
		if (cursor.file !== file) throw new Error("This read continuation belongs to a different file.")
		if (cursor.version !== version)
			throw new Error(
				"File changed since the previous read. Read the relevant section again without the continuation.",
			)
		if (
			cursor.ranges.some(([, end]) => end > lines.length) ||
			cursor.column > lines[cursor.ranges[0]![0] - 1]!.length
		)
			throw new Error("Invalid read continuation position.")
		return { path: entry.path, lines, cursor }
	}
	let ranges: Range[]
	const requested = entry.lineRanges ?? entry.line_ranges
	if (requested?.length) {
		ranges = requested
			.map(({ start, end }) => [start, Math.min(end, lines.length)] as Range)
			.filter(([start, end]) => start <= end)
			.sort((a, b) => a[0] - b[0])
		const merged: Range[] = []
		for (const range of ranges) {
			const previous = merged.at(-1)
			if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1])
			else merged.push(range)
		}
		ranges = merged
	} else if (entry.mode === "indentation" && lines.length) {
		const anchorLine = entry.indentation?.anchor_line ?? entry.offset ?? 1
		if (anchorLine > lines.length) throw new Error(`anchor_line ${anchorLine} is out of range (1-${lines.length}).`)
		const result = readWithIndentation(content, {
			anchorLine,
			maxLevels: entry.indentation?.max_levels,
			includeSiblings: entry.indentation?.include_siblings,
			includeHeader: entry.indentation?.include_header,
			limit: lines.length,
			maxLines: lines.length,
		})
		ranges = result.includedRanges.map(([start, end]) => [start, end])
	} else {
		const offset = entry.offset ?? 1
		if (lines.length && offset > lines.length)
			throw new Error(`offset ${offset} is beyond file end (${lines.length} lines).`)
		ranges = lines.length ? [[offset, lines.length]] : []
	}
	return {
		path: entry.path,
		lines,
		cursor: {
			v: 1,
			file,
			version,
			ranges,
			column: 0,
			limit: Math.min(
				entry.limit ?? DEFAULT_LINE_LIMIT,
				entry.mode === "indentation" ? (entry.indentation?.max_lines ?? Infinity) : Infinity,
			),
		},
	}
}

/** Render complete source lines, with a within-line cursor only when a single line cannot fit. */
export function renderFileRead(read: FileReadContent, maxChars: number): { content: string; observedContent: string } {
	const cursor: Cursor = { ...read.cursor, ranges: read.cursor.ranges.map(([start, end]) => [start, end]) }
	const header = `File: ${read.path}\n`
	if (!cursor.ranges.length)
		return {
			content:
				header + (read.lines.length ? "Note: No lines matched the requested ranges" : "Note: File is empty"),
			observedContent: "",
		}
	// A complete selection needs no continuation envelope (important for small allowances).
	const completeRows: string[] = []
	let completeSize = header.length
	complete: for (const [start, end] of cursor.ranges) {
		for (let line = start; line <= end; line++) {
			const column = completeRows.length ? 0 : cursor.column
			const row = `${line}${column ? `:${column + 1}` : ""} | ${read.lines[line - 1]!.slice(column)}`
			completeSize += row.length + (completeRows.length ? 1 : 0)
			if (completeSize > maxChars || completeRows.length >= cursor.limit) break complete
			completeRows.push(row)
			if (line === cursor.ranges.at(-1)![1]) {
				const observedContent = completeRows.join("\n")
				return { content: header + observedContent, observedContent }
			}
		}
	}
	const footer = () =>
		cursor.ranges.length
			? `\n\n[Partial read: next unread position is line ${cursor.ranges[0]![0]}${cursor.column ? `, column ${cursor.column + 1}` : ""}. Total file lines: ${read.lines.length}. Continue only if needed.]\nContinuation: ${JSON.stringify({ path: read.path, continuation: encode(cursor) })}`
			: ""
	// Leave room for position digit growth and the longest continuation (before ranges are consumed).
	const available = Math.floor(maxChars) - header.length - footer().length - 64
	if (available < 32)
		throw new Error(
			"Read output allowance is too small for content and a safe continuation. Retry this file alone.",
		)
	const rows: string[] = []
	let used = 0
	while (cursor.ranges.length && rows.length < cursor.limit) {
		const [lineNumber, end] = cursor.ranges[0]!
		const source = read.lines[lineNumber - 1]!
		const label = cursor.column ? `${lineNumber}:${cursor.column + 1} | ` : `${lineNumber} | `
		const remaining = source.slice(cursor.column)
		const row = label + remaining
		if (used + row.length + 1 > available) {
			if (rows.length) break
			const fragmentLabel = `${lineNumber}:${cursor.column + 1} | `
			let length = available - fragmentLabel.length - " [partial line]".length - 1
			// Never split a UTF-16 surrogate pair between pages.
			if (length > 0 && /[\uD800-\uDBFF]/.test(remaining[length - 1]!)) length--
			if (length <= 0) throw new Error("Read output allowance cannot fit a source fragment.")
			rows.push(fragmentLabel + remaining.slice(0, length) + " [partial line]")
			cursor.column += length
			break
		}
		rows.push(row)
		used += row.length + 1
		cursor.column = 0
		if (lineNumber === end) cursor.ranges.shift()
		else cursor.ranges[0]![0]++
	}
	const observedContent = rows.join("\n")
	const content = header + observedContent + footer()
	if (content.length > maxChars) throw new Error("Read output allowance cannot fit its continuation.")
	return { content, observedContent }
}
