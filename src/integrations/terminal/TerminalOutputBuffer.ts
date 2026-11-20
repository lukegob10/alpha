import { MAX_TERMINAL_OUTPUT_BUFFER_BYTES } from "./types"

const TAIL_CHUNK_CHARACTERS = 4_096
const unpairedSurrogate = /[\uD800-\uDFFF]/u

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
	private tail: { output: string; bytes: number }[] = []
	private headBytes = 0
	private tailBytes = 0
	private omittedBytes = 0
	private headClosed = false
	private tailHasUnpairedSurrogates = false
	private readonly headBudget = Math.floor(MAX_TERMINAL_OUTPUT_BUFFER_BYTES / 2)
	private readonly tailBudget = MAX_TERMINAL_OUTPUT_BUFFER_BYTES - this.headBudget

	append(chunk: string): void {
		const prefix = this.headClosed ? "" : terminalOutputPrefix(chunk, this.headBudget - this.headBytes)
		this.head += prefix
		this.headBytes += Buffer.byteLength(prefix, "utf8")
		if (prefix.length < chunk.length || this.headBytes >= this.headBudget) this.headClosed = true
		let output = chunk.slice(prefix.length)
		if (!output) return
		if (this.tailHasUnpairedSurrogates) {
			const combinedTail = this.tailOutput() + output
			output = terminalOutputSuffix(combinedTail, this.tailBudget)
			this.omittedBytes += Buffer.byteLength(combinedTail, "utf8") - Buffer.byteLength(output, "utf8")
			this.tail = []
			this.tailBytes = 0
			this.tailHasUnpairedSurrogates = unpairedSurrogate.test(output)
		} else if (unpairedSurrogate.test(output)) {
			this.tailHasUnpairedSurrogates = this.tailBytes + Buffer.byteLength(output, "utf8") <= this.tailBudget
			if (!this.tailHasUnpairedSurrogates) output = Buffer.from(output, "utf8").toString("utf8")
		}
		for (let start = 0; start < output.length; ) {
			let end = Math.min(start + TAIL_CHUNK_CHARACTERS, output.length)
			const next = output.charCodeAt(end)
			if (next >= 0xdc00 && next <= 0xdfff) end--
			this.appendTailChunk(copyTerminalOutput(output.slice(start, end)))
			start = end
		}
	}

	private appendTailChunk(output: string): void {
		const bytes = Buffer.byteLength(output, "utf8")
		const last = this.tail.at(-1)
		if (last && last.output.length + output.length <= TAIL_CHUNK_CHARACTERS) {
			last.output += output
			last.bytes += bytes
		} else {
			this.tail.push({ output, bytes })
		}
		this.tailBytes += bytes
		while (this.tailBytes > this.tailBudget) {
			const first = this.tail[0]
			const available = first.bytes - (this.tailBytes - this.tailBudget)
			const remaining = available > 0 ? terminalOutputSuffix(first.output, available) : ""
			const bytes = Buffer.byteLength(remaining, "utf8")
			const omitted = first.bytes - bytes
			this.tailBytes -= omitted
			this.omittedBytes += omitted
			if (remaining) this.tail[0] = { output: remaining, bytes }
			else this.tail.shift()
		}
	}

	private tailOutput(): string {
		return this.tail.map(({ output }) => output).join("")
	}

	parts(): ReadonlyArray<{ output: string; omitted: boolean }> {
		return [
			{ output: this.head, omitted: false },
			...(this.omittedBytes > 0
				? [{ output: terminalOutputOmissionMarker(this.omittedBytes), omitted: true }]
				: []),
			{ output: this.tailOutput(), omitted: false },
		]
	}

	clear(): void {
		this.head = ""
		this.tail = []
		this.headBytes = 0
		this.tailBytes = 0
		this.omittedBytes = 0
		this.headClosed = false
		this.tailHasUnpairedSurrogates = false
	}
}
