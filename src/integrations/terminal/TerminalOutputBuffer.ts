import { MAX_TERMINAL_OUTPUT_BUFFER_BYTES } from "./types"

/** V8 substrings can retain a much larger backing string; own retained units. */
export function copyTerminalOutput(value: string): string {
	return Buffer.from(value, "utf16le").toString("utf16le")
}

/** Keep byte limits at UTF-8 character boundaries, including surrogate pairs. */
export function terminalOutputPrefix(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8")
	if (bytes.length <= maxBytes) return value
	let end = Math.max(0, Math.floor(maxBytes))
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
	return bytes.subarray(0, end).toString("utf8")
}

export function terminalOutputSuffix(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8")
	if (bytes.length <= maxBytes) return value
	let start = Math.max(0, bytes.length - Math.max(0, Math.floor(maxBytes)))
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
	return bytes.subarray(start).toString("utf8")
}

export function terminalOutputOmissionMarker(bytes: number): string {
	return `\n[...${bytes} bytes omitted...]\n`
}

/** Bounded completion evidence, independent of the unread output cursor. */
export class TerminalOutputBuffer {
	private head = ""
	private tail = ""
	private headBytes = 0
	private omittedBytes = 0
	private headClosed = false
	private readonly headBudget = Math.floor(MAX_TERMINAL_OUTPUT_BUFFER_BYTES / 2)
	private readonly tailBudget = MAX_TERMINAL_OUTPUT_BUFFER_BYTES - this.headBudget

	append(chunk: string): void {
		const prefix = this.headClosed ? "" : terminalOutputPrefix(chunk, this.headBudget - this.headBytes)
		this.head += prefix
		this.headBytes += Buffer.byteLength(prefix, "utf8")
		if (prefix.length < chunk.length || this.headBytes >= this.headBudget) this.headClosed = true
		const combinedTail = this.tail + chunk.slice(prefix.length)
		this.tail = terminalOutputSuffix(combinedTail, this.tailBudget)
		this.omittedBytes += Buffer.byteLength(combinedTail, "utf8") - Buffer.byteLength(this.tail, "utf8")
	}

	parts(): ReadonlyArray<{ output: string; omitted: boolean }> {
		return [
			{ output: this.head, omitted: false },
			...(this.omittedBytes > 0
				? [{ output: terminalOutputOmissionMarker(this.omittedBytes), omitted: true }]
				: []),
			{ output: this.tail, omitted: false },
		]
	}

	clear(): void {
		this.head = ""
		this.tail = ""
		this.headBytes = 0
		this.omittedBytes = 0
		this.headClosed = false
	}
}
