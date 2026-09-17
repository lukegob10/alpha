import { createHash } from "crypto"
import type { CodeBlock } from "../interfaces/file-processor"
import { tiktoken } from "../../../utils/tiktoken"

// Conservative shared tokenizer units, including the existing 1.5 safety factor.
export const CHUNK_TOKEN_BUDGET = 768
export const CHUNK_CHARACTER_LIMIT = 4096
const MIN_PACKED_TOKENS = 128
const CONTEXT_CHARACTER_LIMIT = 1000
export const CONTEXT_TOKEN_BUDGET = 256

export interface CodeScope {
	startLine: number
	endLine: number
	name: string
	signature: string
	type: string
}

export async function countCodeTokens(text: string): Promise<number> {
	return tiktoken([{ type: "text", text }])
}

/** Partitions exact source once; syntax scopes annotate chunks without duplicating source. */
export async function chunkSource(
	filePath: string,
	content: string,
	fileHash: string,
	scopes: CodeScope[] = [],
	fallbackType = "code_chunk",
	signal?: AbortSignal,
): Promise<CodeBlock[]> {
	signal?.throwIfAborted()
	if (!content.trim()) return []
	const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const starts = new Set(scopes.map((scope) => scope.startLine))
	const orderedScopes = [...scopes].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
	const chunks: CodeBlock[] = []
	let text = ""
	let tokens = 0
	let startLine = 1
	let startOffset = 0
	let offset = 0
	let active: CodeScope[] = []
	let nextScope = 0
	let chunkScopes: CodeScope[] = []

	const finalize = async (endLine: number) => {
		if (!text) return
		// Later declarations are visible in the source itself. Carry the scopes active
		// at the fragment's start, avoiding repeated metadata for every packed sibling.
		const contextScopes = chunkScopes.filter((scope) => scope.startLine <= startLine && scope.endLine >= startLine)
		// Put symbol identity ahead of documentation so truncation keeps the enclosing names.
		const names = [...new Set(contextScopes.map((scope) => scope.name).filter(Boolean))].join(" > ")
		let context = [names, ...new Set(contextScopes.map((scope) => scope.signature))]
			.filter(Boolean)
			.join("\n")
			.slice(0, CONTEXT_CHARACTER_LIMIT)
		while ((await countCodeTokens(context)) > CONTEXT_TOKEN_BUDGET) {
			context = context.slice(0, Math.floor(context.length * 0.75))
		}
		if (/[\uD800-\uDBFF]$/.test(context)) context = context.slice(0, -1)
		const scope = contextScopes.at(-1) ?? chunkScopes[0]
		chunks.push({
			file_path: filePath,
			identifier: scope?.name || null,
			type: scope?.type ?? fallbackType,
			start_line: startLine,
			end_line: endLine,
			startOffset,
			endOffset: offset,
			content: text,
			context,
			tokenCount: tokens,
			segmentHash: createHash("sha256").update(`${filePath}\0${startOffset}\0${text}`).digest("hex"),
			fileHash,
		})
		text = ""
		tokens = 0
		chunkScopes = []
		startOffset = offset
	}

	for (let index = 0; index < lines.length; index++) {
		const lineNumber = index + 1
		active = active.filter((scope) => scope.endLine >= lineNumber)
		while (nextScope < orderedScopes.length && orderedScopes[nextScope].startLine <= lineNumber) {
			active.push(orderedScopes[nextScope++])
		}
		if (text && starts.has(lineNumber) && tokens >= MIN_PACKED_TOKENS) await finalize(lineNumber - 1)
		let remaining = lines[index]
		while (remaining) {
			signal?.throwIfAborted()
			let length = Math.min(remaining.length, CHUNK_CHARACTER_LIMIT)
			// Never split a UTF-16 surrogate pair.
			if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1])) length--
			let part = remaining.slice(0, length)
			let partTokens = await countCodeTokens(part)
			while (partTokens > CHUNK_TOKEN_BUDGET) {
				length = Math.max(2, Math.floor(length / 2))
				if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1])) length--
				part = remaining.slice(0, length)
				partTokens = await countCodeTokens(part)
			}
			if (
				text &&
				(tokens + partTokens > CHUNK_TOKEN_BUDGET || text.length + part.length > CHUNK_CHARACTER_LIMIT)
			) {
				await finalize(remaining === lines[index] ? lineNumber - 1 : lineNumber)
			}
			if (!text) {
				startLine = lineNumber
				chunkScopes = [...active]
			} else {
				for (const scope of active) if (!chunkScopes.includes(scope)) chunkScopes.push(scope)
			}
			text += part
			tokens += partTokens
			offset += part.length
			remaining = remaining.slice(part.length)
			if (remaining) await finalize(lineNumber)
		}
		// Give cancellation and UI events a turn even on very large source files.
		if (index % 64 === 63) await new Promise<void>((resolve) => setImmediate(resolve))
	}
	await finalize(lines.length)
	return chunks
}
