import { createHash } from "crypto"
import path from "path"
import { z } from "zod"

import type { AlphaSayTool } from "@alpha-code/types"
import { extractUserRequestText } from "../agent/requestWorkClass"
import type { MemoryStore } from "../../services/memory/MemoryStore"
import { MEMORY_TOOL_NAMES } from "../prompts/tools/native-tools/memories"
import type { ToolExecutionContext } from "./ToolRegistry"

const relativePath = z.string().max(4096)
const cursor = z.string().max(128).optional()
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const listArgs = z
	.object({ path: relativePath.optional(), cursor, max_results: positiveInteger.max(2000).optional() })
	.strict()
const readArgs = z
	.object({
		path: relativePath,
		line_offset: positiveInteger.optional(),
		max_lines: positiveInteger.max(2000).optional(),
	})
	.strict()
const matchMode = z.discriminatedUnion("type", [
	z.object({ type: z.literal("any") }).strict(),
	z.object({ type: z.literal("all_on_same_line") }).strict(),
	z.object({ type: z.literal("all_within_lines"), line_count: positiveInteger.max(100) }).strict(),
])
const searchArgs = z
	.object({
		queries: z
			.array(
				z
					.string()
					.min(1)
					.max(1000)
					.refine((query) => query.trim().length > 0),
			)
			.min(1)
			.max(10),
		match_mode: matchMode.optional(),
		path: relativePath.optional(),
		cursor,
		context_lines: z.number().int().min(0).max(20).optional(),
		case_sensitive: z.boolean().optional(),
		normalized: z.boolean().optional(),
		max_results: positiveInteger.max(200).optional(),
	})
	.strict()
const noteArgs = z.object({ note: z.string().min(1).max(16_000) }).strict()

/** No model-supplied path can select a workspace file, state database, or another home namespace. */
function memoryPath(value: string | undefined, rootAllowed = false): string {
	if (rootAllowed && (value === undefined || value === "" || value === ".")) return ""
	if (
		!value ||
		/[\\:\0]/.test(value) ||
		value.startsWith("/") ||
		value
			.split("/")
			.some((component) => !component || component === "." || component === ".." || component.startsWith("."))
	) {
		throw new Error("Invalid relative memory path.")
	}
	return value
}

function scopeDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)
}

function pageOffset(value: string | undefined, scope: string): number {
	if (!value) return 0
	const match = /^([a-f0-9]{24}):([0-9]{1,7})$/.exec(value)
	if (!match || match[1] !== scope) throw new Error("Invalid memory pagination cursor.")
	return Number(match[2])
}

function page<T>(items: readonly T[], offset: number, limit: number, scope: string) {
	if (offset > items.length) throw new Error("Memory pagination cursor exceeds the available results.")
	const end = Math.min(items.length, offset + limit)
	return { items: items.slice(offset, end), next_cursor: end < items.length ? `${scope}:${end}` : null }
}

async function listMemories(store: MemoryStore, input: z.infer<typeof listArgs>, signal?: AbortSignal) {
	const parent = memoryPath(input.path, true)
	const files = await store.listFiles(signal)
	const prefix = parent ? `${parent}/` : ""
	const entries = new Map<string, { path: string; entry_type: "file" | "directory" }>()
	for (const file of files) {
		if (file === parent) {
			entries.set(file, { path: file, entry_type: "file" })
			continue
		}
		if (!file.startsWith(prefix)) continue
		const remainder = file.slice(prefix.length)
		const separator = remainder.indexOf("/")
		const relative = `${prefix}${separator < 0 ? remainder : remainder.slice(0, separator)}`
		entries.set(relative, { path: relative, entry_type: separator < 0 ? "file" : "directory" })
	}
	const ordered = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))
	const scope = scopeDigest(["list", parent])
	const result = page(ordered, pageOffset(input.cursor, scope), input.max_results ?? 2000, scope)
	return {
		path: parent || null,
		entries: result.items,
		next_cursor: result.next_cursor,
		truncated: result.next_cursor !== null || files.length >= 2000,
	}
}

interface SearchMatch {
	path: string
	match_line_number: number
	content_start_line_number: number
	content: string
	matched_queries: string[]
}

async function searchMemories(
	store: MemoryStore,
	input: z.infer<typeof searchArgs>,
	check: () => void,
	signal?: AbortSignal,
) {
	const target = memoryPath(input.path, true)
	const mode = input.match_mode ?? { type: "any" as const }
	const normalize = (text: string) => {
		const separators = input.normalized ? text.replace(/[^\p{L}\p{N}]/gu, "") : text
		return input.case_sensitive === false ? separators.toLowerCase() : separators
	}
	const queryTexts = input.queries.map((query) => query.trim())
	const queries = queryTexts.map(normalize)
	if (queries.some((query) => query.length === 0)) throw new Error("Memory queries cannot normalize to empty text.")
	const context = input.context_lines ?? 0
	const scope = scopeDigest(["search", target, input.queries, mode, context, input.case_sensitive, input.normalized])
	const offset = pageOffset(input.cursor, scope)
	const maximum = input.max_results ?? 200
	const files = await store.listFiles(signal)
	const matches: SearchMatch[] = []
	let inspectedCharacters = 0
	let seenMatches = 0
	let bounded = files.length >= 2000
	for (const file of files) {
		check()
		if (target && file !== target && !file.startsWith(`${target}/`)) continue
		const read = await store.readFileDetails(file, 1, 2000, signal)
		const content = read.content
		bounded ||= read.truncated
		check()
		inspectedCharacters += content.length
		if (inspectedCharacters > 8_000_000) {
			bounded = true
			break
		}
		const lines = content.split(/\r?\n/)
		// Manual edits can exceed generated artifacts. Make the scan boundary observable.
		if (lines.length >= 2000 || content.length >= 80_000) bounded = true
		const normalized = lines.map(normalize)
		const windows: Array<{ first: number; last: number; matched: boolean[] }> = []
		for (let index = 0; index < lines.length; index++) {
			if (index % 128 === 0) check()
			let matched = queries.map((query) => normalized[index].includes(query))
			if (!matched.some(Boolean)) continue
			let last = index
			if (mode.type === "all_within_lines") {
				while (!matched.every(Boolean) && last + 1 < Math.min(lines.length, index + mode.line_count)) {
					last++
					matched = queries.map(
						(query, queryIndex) => matched[queryIndex] || normalized[last].includes(query),
					)
				}
			}
			if (mode.type !== "any" && !matched.every(Boolean)) continue
			windows.push({ first: index, last, matched })
		}
		// A larger window adds no match evidence when a later, shorter window covers every query.
		let earliestLaterEnd = Number.POSITIVE_INFINITY
		const minimal = [...windows]
		if (mode.type === "all_within_lines") {
			for (let index = windows.length - 1; index >= 0; index--) {
				const window = windows[index]
				if (earliestLaterEnd <= window.last) minimal.splice(index, 1)
				earliestLaterEnd = Math.min(earliestLaterEnd, window.last)
			}
		}
		for (const window of minimal) {
			if (seenMatches++ < offset) continue
			const first = Math.max(0, window.first - context)
			const last = Math.min(lines.length, window.last + 1 + context)
			matches.push({
				path: file,
				match_line_number: window.first + 1,
				content_start_line_number: first + 1,
				content: lines.slice(first, last).join("\n"),
				matched_queries: queryTexts.filter((_, queryIndex) => window.matched[queryIndex]),
			})
			if (matches.length > maximum) break
		}
		if (matches.length > maximum) break
	}
	if (seenMatches < offset) throw new Error("Memory pagination cursor exceeds the available results.")
	const nextCursor = matches.length > maximum ? `${scope}:${offset + maximum}` : null
	return {
		queries: queryTexts,
		match_mode: mode,
		path: target || null,
		matches: matches.slice(0, maximum),
		next_cursor: nextCursor,
		truncated: bounded || nextCursor !== null,
	}
}

/** Only a direct human instruction can become the append-only source note. */
export function explicitMemoryNote(request: string | undefined): string | undefined {
	const text = request?.trim()
	if (!text || text.length > 16_000 || /^(?:message from|tool result:|output from|[>"“`])/i.test(text))
		return undefined
	const direct = text.replace(
		/^(?:(?:okay|ok|hey)[,\s]+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+|i(?:'d|’d| would)\s+like\s+you\s+to\s+)?/i,
		"",
	)
	if (
		!/^(?:(?:remember|forget)\s+\S|(?:update|correct)\s+(?:your|the|my|our)\s+(?:saved\s+)?memor(?:y|ies)\b)/i.test(
			direct,
		) ||
		/\b(?:(?:do not|don't|don’t|never)\s+(?:save|store|remember|record)|scratch that|never mind|forget it)\b/i.test(
			text,
		)
	)
		return undefined
	return text
}

/** Independent TypeScript implementation; memory operations never use generic workspace file tools. */
export async function executeMemoryTool({ task, call, callbacks, signal }: ToolExecutionContext): Promise<void> {
	if (call.partial) return
	signal ??= callbacks.signal
	const stopped = (status: "error" | "denied" | "cancelled", message: string) => {
		callbacks.setResultMetadata?.({ status })
		callbacks.pushToolResult(JSON.stringify({ status, message }))
	}
	const check = () => {
		signal?.throwIfAborted()
		if (task.abort || task.getTaskLifetimeCancellationSignal().aborted)
			throw new Error("Memory operation cancelled.")
	}
	try {
		check()
		const provider = task.providerRef.deref()
		const settings = provider?.getMemorySettings()
		if (
			!provider ||
			!MEMORY_TOOL_NAMES.has(call.name) ||
			task.taskKind !== "primary" ||
			task.parentTaskId ||
			task.orchestrationParentTaskId ||
			task.diagnosticSession ||
			!task.memory.useMemories ||
			!settings?.enabled ||
			!settings.dedicatedTools
		) {
			stopped("denied", "Memory tools are disabled for this conversation.")
			return
		}
		const store = provider.getMemoryStore()
		const recordUsage = async (paths: string[]) => {
			try {
				await provider.recordMemoryUsage(paths)
			} catch {
				// Optional ranking metadata must not discard successfully retrieved evidence.
				provider.log("Memory usage counters are unavailable")
			}
		}
		let result: unknown
		switch (call.name) {
			case "memories_list":
				result = await listMemories(store, listArgs.parse(call.nativeArgs ?? {}), signal)
				break
			case "memories_read": {
				const input = readArgs.parse(call.nativeArgs)
				const relative = memoryPath(input.path)
				const start = input.line_offset ?? 1
				const read = await store.readFileDetails(relative, start, input.max_lines ?? 2000, signal)
				check()
				await recordUsage([relative])
				result = { path: relative, start_line_number: start, content: read.content, truncated: read.truncated }
				break
			}
			case "memories_search": {
				const response = await searchMemories(store, searchArgs.parse(call.nativeArgs), check, signal)
				check()
				await recordUsage([...new Set(response.matches.map((match) => match.path))])
				result = response
				break
			}
			case "memories_add_ad_hoc_note": {
				const input = noteArgs.parse(call.nativeArgs)
				const request = explicitMemoryNote(
					extractUserRequestText(task.apiConversationHistory, task.metadata?.task),
				)
				if (!request || input.note !== request) {
					stopped(
						"denied",
						"A memory note requires the exact, explicit human request to remember, forget, or correct memory.",
					)
					return
				}
				if ((await task.getTaskMode()) !== "code") {
					stopped("denied", "Memory notes cannot be changed in Plan mode.")
					return
				}
				const approved = await callbacks.askApproval(
					"tool",
					JSON.stringify({
						tool: "memory",
						path: path.join(store.rootPath, "extensions", "ad_hoc", "notes"),
						content: request,
					} satisfies AlphaSayTool),
				)
				check()
				if (!approved) {
					stopped("denied", "The memory note was declined.")
					return
				}
				// Recheck host settings and human provenance after the approval wait.
				if (
					!provider.getMemorySettings().enabled ||
					!provider.getMemorySettings().dedicatedTools ||
					(await task.getTaskMode()) !== "code" ||
					explicitMemoryNote(extractUserRequestText(task.apiConversationHistory, task.metadata?.task)) !==
						request
				) {
					stopped("denied", "Memory authorization changed before the note was saved.")
					return
				}
				if ((callbacks.getRemainingOutputChars?.() ?? 1000) < 256)
					throw new Error("Insufficient output space for a memory note receipt.")
				result = { path: await provider.addMemoryNote(request, signal) }
				break
			}
		}
		check()
		const serialized = JSON.stringify(result)
		if (serialized.length > Math.min(100_000, callbacks.getRemainingOutputChars?.() ?? 100_000)) {
			throw new Error("Memory results exceed the output allowance; request fewer results, lines, or context.")
		}
		callbacks.setResultMetadata?.({ status: "success" })
		callbacks.pushToolResult(serialized)
	} catch (error) {
		if (signal?.aborted || task.abort || task.getTaskLifetimeCancellationSignal().aborted) {
			stopped("cancelled", "Memory operation cancelled.")
			return
		}
		callbacks.setResultMetadata?.({ status: "error" })
		await callbacks.handleError(
			"accessing Alpha memories",
			error instanceof Error ? error : new Error(String(error)),
		)
	}
}
