import type { ApiMessage } from "../../core/task-persistence/apiMessages"
import { countMemoryTokens, limitMemoryTokens, redactMemoryText, truncateMemoryText } from "./MemoryStore"

const SOURCE_BYTES = 8 * 1024 * 1024
const RECORD_BYTES = 1024 * 1024
const ROW_BYTES = 9_904
const MESSAGE_BYTES = 8_900
const MAX_ROWS = 16_384
const MAX_SCANNED_BLOCKS = MAX_ROWS * 4
const OMITTED = "[earlier or lower-priority evidence omitted]\n"

type Tier = "human user" | "assistant final" | "other agent" | "assistant commentary" | "harness context" | "tool"
type Row = { tier: Tier; text: string; sourceBytes: number; questionId?: string; toolId?: string }
const TIERS: Tier[] = [
	"human user",
	"assistant final",
	"other agent",
	"assistant commentary",
	"harness context",
	"tool",
]

export interface MemoryEvidenceOptions {
	contextWindow?: number
	reservedTokens?: number
	signal?: AbortSignal
}

/** Preserve original user requests, rather than learning injected instructions as preferences. */
function visibleText(value: string): string {
	return value
		.replace(/^\s*# AGENTS\.md instructions[^\n]*[\s\S]*?<\/INSTRUCTIONS>/gim, "")
		.replace(
			/<(skill|system|developer|system[-_]reminder|system_instructions|developer_instructions|environment_details|environment_context|custom_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi,
			"",
		)
		.replace(/<(?:image|audio|video)\b[^>]*>[\s\S]*?<\/(?:image|audio|video)>/gi, "")
		.trim()
}

function rowTier(message: ApiMessage, text: string): Tier {
	const legacyAgentMessage =
		/^\s*<subagent_notification>/.test(text) ||
		/^\s*Message Type:[^\n]*\r?\nTask name:[^\n]*\r?\nSender:[^\n]*\r?\nPayload:/.test(text)
	if (message.input_origin === "agent" || message.agent_message_id || legacyAgentMessage) return "other agent"
	return message.role === "assistant"
		? message.phase === "commentary"
			? "assistant commentary"
			: "assistant final"
		: "human user"
}

function boundedArguments(value: unknown): string {
	let remaining = 256
	try {
		return truncateMemoryText(
			JSON.stringify(value, (_key, item: unknown) => {
				if (--remaining < 0) throw new Error("Memory argument limit")
				if (typeof item === "string" && Buffer.byteLength(item, "utf8") > RECORD_BYTES) {
					throw new Error("Memory argument size limit")
				}
				return typeof item === "string" ? truncateMemoryText(redactMemoryText(item), ROW_BYTES) : item
			}) ?? "",
			ROW_BYTES,
		)
	} catch {
		return "[arguments omitted]"
	}
}

function* messageRows(message: ApiMessage): Generator<Row | undefined> {
	// Opaque state and reasoning are never evidence, even when accompanied by a text projection.
	if (message.type === "reasoning" || message.isSummary || message.isTruncationMarker || message.hook_prompt) return
	if (typeof message.content === "string") {
		const sourceBytes = Buffer.byteLength(message.content, "utf8")
		if (sourceBytes > RECORD_BYTES) return
		const text = visibleText(message.content)
		if (text) yield { tier: rowTier(message, text), text, sourceBytes }
		return
	}
	for (let index = message.content.length - 1; index >= 0; index--) {
		// Even skipped media/reasoning blocks count toward bounded scanning and cancellation checkpoints.
		yield undefined
		const block = message.content[index]
		if (block.type === "text") {
			const sourceBytes = Buffer.byteLength(block.text, "utf8")
			if (sourceBytes > RECORD_BYTES) continue
			const text = visibleText(block.text)
			if (text) yield { tier: rowTier(message, text), text, sourceBytes }
		} else if (block.type === "tool_use") {
			const text = `${block.name}: ${boundedArguments(block.input)}`
			yield {
				tier: "tool",
				text,
				sourceBytes: Buffer.byteLength(text, "utf8"),
				...(block.name === "ask_followup_question" || block.name === "request_user_input"
					? { questionId: block.id }
					: {}),
			}
		} else if (block.type === "tool_result") {
			const content = typeof block.content === "string" ? [block.content] : (block.content ?? [])
			let remaining = ROW_BYTES
			const parts: string[] = []
			for (const part of content) {
				yield undefined
				const value = typeof part === "string" ? part : part.type === "text" ? part.text : undefined
				if (value === undefined || Buffer.byteLength(value, "utf8") > RECORD_BYTES) continue
				const text = truncateMemoryText(redactMemoryText(visibleText(value)), remaining)
				if (text) parts.push(text)
				remaining -= Buffer.byteLength(text, "utf8")
				if (remaining <= 0) break
			}
			const text = parts.join("\n")
			if (text)
				yield { tier: "tool", text, sourceBytes: Buffer.byteLength(text, "utf8"), toolId: block.tool_use_id }
		}
	}
}

/**
 * Codex v2 evidence contract: openai/codex@970111f6 (2026-10-25).
 * Alpha uses its canonical transcript and tokenizer; bounded batches yield to the extension host.
 */
export async function prepareMemoryEvidence(
	messages: ApiMessage[],
	options: MemoryEvidenceOptions = {},
): Promise<string[]> {
	options.signal?.throwIfAborted()
	const rows: Row[] = []
	let remainingBytes = SOURCE_BYTES
	let scanned = 0
	let scannedMessages = 0
	sources: for (
		let index = messages.length - 1;
		index >= 0 && remainingBytes > 0 && rows.length < MAX_ROWS && scannedMessages++ < MAX_ROWS;
		index--
	) {
		if (index % 32 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve))
			options.signal?.throwIfAborted()
		}
		for (const row of messageRows(messages[index])) {
			if (++scanned > MAX_SCANNED_BLOCKS) break sources
			if (scanned % 16 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve))
				options.signal?.throwIfAborted()
			}
			if (!row) continue
			if (rows.length >= MAX_ROWS || row.sourceBytes > remainingBytes) break sources
			remainingBytes -= row.sourceBytes
			row.text = truncateMemoryText(redactMemoryText(row.text), ROW_BYTES)
			if (row.text) rows.push(row)
			if (remainingBytes <= 0) break
		}
	}
	rows.reverse()
	const questions = new Map<string, string>()
	for (const row of rows) {
		if (row.questionId) questions.set(row.questionId, row.text)
		const question = row.toolId ? questions.get(row.toolId) : undefined
		if (question) {
			row.tier = "human user"
			row.text = truncateMemoryText(`Assistant question: ${question}\nHuman reply: ${row.text}`, ROW_BYTES)
		}
	}
	const context = options.contextWindow
	const available = Number.isFinite(context) && context! > 0 ? Math.floor(context! * 0.7) : 150_000
	let remaining = Math.max(0, available - (options.reservedTokens ?? 2_048) - 32)
	const selected = new Map<number, string>()
	let counted = 0
	for (const tier of TIERS) {
		for (let index = rows.length - 1; index >= 0 && remaining > 32; index--) {
			const row = rows[index]
			if (row.tier !== tier) continue
			if (++counted % 16 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve))
				options.signal?.throwIfAborted()
			}
			let text = `[${row.tier}]\n${row.text}\n`
			if (tier === "tool") text = await limitMemoryTokens(text, 2_000, options.signal)
			let tokens = await countMemoryTokens(text, options.signal)
			if (tokens > remaining - 16) {
				text = await limitMemoryTokens(text, remaining - 16, options.signal)
				tokens = await countMemoryTokens(text, options.signal)
			}
			if (text) {
				selected.set(index, text)
				remaining -= tokens + 16 // Covers message framing, truncation markers, and chunk boundaries.
			}
		}
	}
	const parts: string[] = []
	let gap = false
	for (let index = 0; index < rows.length; index++) {
		const text = selected.get(index)
		if (text) {
			parts.push(text)
			gap = false
		} else if (!gap && parts.length) {
			parts.push(OMITTED)
			gap = true
		}
	}
	options.signal?.throwIfAborted()
	const rendered = parts.join("")
	const chunks: string[] = []
	let offset = 0
	while (offset < rendered.length) {
		// Slice at most MESSAGE_BYTES UTF-16 units before allocating UTF-8 to keep this linear.
		let end = Math.min(rendered.length, offset + MESSAGE_BYTES)
		const last = rendered.charCodeAt(end - 1)
		if (last >= 0xd800 && last <= 0xdbff && end < rendered.length) end--
		const chunk = truncateMemoryText(rendered.slice(offset, end), MESSAGE_BYTES)
		chunks.push(chunk)
		offset += chunk.length
	}
	return chunks
}
