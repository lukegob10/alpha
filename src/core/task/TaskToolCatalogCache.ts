import type OpenAI from "openai"
import { discoverToolsParamsSchema, discoverToolsResultSchema, toolSearchParamsSchema } from "@alpha-code/types"

import { digestValue } from "../agent/StepContext"
import { getToolOutputLimit } from "../agent/ToolPolicy"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { createTaskToolSurface, type TaskToolSurface } from "../tools/TaskToolSurface"

const MAX_SELECTED_TOOLS = 32
const MAX_HISTORY_MESSAGES = 512
const MAX_MESSAGE_BLOCKS = 128
const MAX_QUERY_TERMS = 16
const MAX_QUERY_SYNONYMS_PER_TERM = 5
const MAX_SEARCH_DESCRIPTION_CHARS = 8_000
const MAX_SEARCH_SCHEMA_DEPTH = 8
const MAX_SEARCH_SCHEMA_NODES = 512
const MAX_SEARCH_SCHEMA_CHARS = 8_000
const MAX_SEARCH_SCHEMA_NAME_CHARS = MAX_SEARCH_SCHEMA_CHARS / 2
const MAX_SEARCH_SCHEMA_DESCRIPTION_CHARS = MAX_SEARCH_SCHEMA_CHARS - MAX_SEARCH_SCHEMA_NAME_CHARS - 1
export const DISCOVERY_OUTPUT_LIMIT = 24_000
// Calibrated against the effective request fixtures, not the raw native catalog.
export const DEFERRED_CATALOG_MIN_TOOLS = 8
export const DEFERRED_CATALOG_MIN_BYTES = 16_000

type FunctionSchema = OpenAI.Chat.ChatCompletionFunctionTool
export type ToolSearch = (params: { query: string; limit: number }, signal?: AbortSignal) => string

const SEARCH_STOP_WORDS = new Set(
	(
		"a an and are as at be been being by can could did do does for from had has have he her hers him his how i if in " +
		"into is it its may me might my of on or our ours please she should so than that the their them then there " +
		"these they this those through to was we were what when where which who why will with would you your yours mcp tool tools"
	).split(/\s+/),
)

const SYNONYM_GROUPS = [
	["find", "search", "lookup", "retrieve", "fetch", "get", "list"],
	["read", "open", "view", "load", "inspect"],
	["create", "add", "insert", "new", "make"],
	["update", "edit", "modify", "change", "set"],
	["delete", "remove", "archive", "destroy"],
	["send", "post", "submit", "deliver"],
	["event", "meeting", "appointment", "calendar", "schedule"],
	["book", "reserve", "schedule", "appointment"],
	["issue", "ticket", "bug", "case"],
	["email", "mail", "message"],
	["file", "document"],
	["folder", "directory"],
	["user", "person", "contact"],
	["comment", "reply", "response"],
	["task", "todo", "reminder", "action"],
] as const

const SEARCH_SYNONYMS = (() => {
	const groups = new Map<string, Set<string>>()
	for (const group of SYNONYM_GROUPS) {
		const normalized = group.map(normalizeSearchToken)
		for (const token of normalized) {
			let alternatives = groups.get(token)
			if (!alternatives) {
				alternatives = new Set()
				groups.set(token, alternatives)
			}
			for (const alternative of normalized) {
				if (alternative !== token) alternatives.add(alternative)
			}
		}
	}
	return groups
})()

interface SearchDocument {
	schema: FunctionSchema
	canonicalName: string
	nameSequence: readonly string[]
	nameTerms: ReadonlyMap<string, number>
	descriptionTerms: ReadonlyMap<string, number>
	nameLength: number
	descriptionLength: number
}

interface SearchIndex {
	documents: readonly SearchDocument[]
	inverseDocumentFrequency: ReadonlyMap<string, number>
	averageNameLength: number
	averageDescriptionLength: number
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const NAME_FIELD_WEIGHT = 3.5
const DESCRIPTION_FIELD_WEIGHT = 1
const SYNONYM_WEIGHT = 0.45

function deferredSchema(schema: OpenAI.Chat.ChatCompletionTool, surface: TaskToolSurface): schema is FunctionSchema {
	return schema.type === "function" && surface.registry.resolve(schema.function.name)?.exposure === "deferred"
}

function reference(schema: FunctionSchema) {
	return { name: schema.function.name, schemaDigest: digestValue(schema), schema }
}

function success(tools: ReturnType<typeof reference>[], message?: string) {
	return { version: 1 as const, status: "success" as const, activation: "next_step" as const, tools, message }
}

function normalizeSearchToken(token: string): string {
	const lower = token.toLowerCase()
	if (lower.length > 4 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`
	if (
		lower.length > 4 &&
		lower.endsWith("s") &&
		!lower.endsWith("ss") &&
		!lower.endsWith("us") &&
		!lower.endsWith("is")
	)
		return lower.slice(0, -1)
	return lower
}

function tokenizeSearchText(value: string): string[] {
	return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeSearchToken)
}

function searchableTerms(value: string): string[] {
	return tokenizeSearchText(value).filter((term) => !SEARCH_STOP_WORDS.has(term))
}

function isSearchSchemaRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function extractSchemaSearchText(schema: unknown): string {
	if (!isSearchSchemaRecord(schema)) return ""

	const propertyNames: string[] = []
	const descriptions: string[] = []
	let propertyNameLength = 0
	let descriptionLength = 0
	let propertyEntriesVisited = 0
	const queue: Array<{ schema: Record<string, unknown>; depth: number }> = [{ schema, depth: 0 }]
	const seen = new WeakSet<object>()
	let cursor = 0

	const appendName = (value: string) => {
		const separatorLength = propertyNames.length > 0 ? 1 : 0
		const remaining = MAX_SEARCH_SCHEMA_NAME_CHARS - propertyNameLength - separatorLength
		if (remaining <= 0) return
		const fragment = value.slice(0, remaining)
		if (!fragment) return
		propertyNames.push(fragment)
		propertyNameLength += separatorLength + fragment.length
	}
	const appendDescription = (value: string) => {
		const separatorLength = descriptions.length > 0 ? 1 : 0
		const remaining = MAX_SEARCH_SCHEMA_DESCRIPTION_CHARS - descriptionLength - separatorLength
		if (remaining <= 0) return
		const fragment = value.slice(0, remaining)
		if (!fragment) return
		descriptions.push(fragment)
		descriptionLength += separatorLength + fragment.length
	}
	const enqueue = (value: unknown, depth: number) => {
		if (depth <= MAX_SEARCH_SCHEMA_DEPTH && isSearchSchemaRecord(value) && queue.length < MAX_SEARCH_SCHEMA_NODES)
			queue.push({ schema: value, depth })
	}
	const appendNamedChildren = (value: unknown, depth: number) => {
		if (!isSearchSchemaRecord(value)) return
		for (const name in value) {
			if (!Object.hasOwn(value, name)) continue
			if (propertyEntriesVisited++ >= MAX_SEARCH_SCHEMA_NODES) return
			appendName(name)
			enqueue(value[name], depth + 1)
			if (propertyNameLength >= MAX_SEARCH_SCHEMA_NAME_CHARS) return
		}
	}

	while (cursor < queue.length && cursor < MAX_SEARCH_SCHEMA_NODES) {
		const current = queue[cursor++]
		if (seen.has(current.schema)) continue
		seen.add(current.schema)

		if (typeof current.schema.description === "string") appendDescription(current.schema.description)
		if (current.depth >= MAX_SEARCH_SCHEMA_DEPTH || propertyEntriesVisited >= MAX_SEARCH_SCHEMA_NODES) continue

		for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
			appendNamedChildren(current.schema[key], current.depth)
			if (propertyEntriesVisited >= MAX_SEARCH_SCHEMA_NODES || propertyNameLength >= MAX_SEARCH_SCHEMA_NAME_CHARS)
				break
		}
		if (propertyEntriesVisited >= MAX_SEARCH_SCHEMA_NODES) continue

		for (const key of [
			"items",
			"additionalProperties",
			"contains",
			"not",
			"if",
			"then",
			"else",
			"propertyNames",
			"unevaluatedProperties",
			"unevaluatedItems",
		]) {
			enqueue(current.schema[key], current.depth + 1)
		}
		for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
			const variants = current.schema[key]
			if (!Array.isArray(variants)) continue
			for (const variant of variants) enqueue(variant, current.depth + 1)
		}
	}

	return [...propertyNames, ...descriptions].join(" ")
}

function canonicalName(value: string): string {
	return tokenizeSearchText(value).join(" ")
}

function countTerms(terms: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>()
	for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
	return counts
}

function buildSearchIndex(schemas: readonly FunctionSchema[]): SearchIndex {
	const documents = schemas.map((schema): SearchDocument => {
		const nameSequence = searchableTerms(schema.function.name)
		const descriptionTerms = countTerms([
			...searchableTerms((schema.function.description ?? "").slice(0, MAX_SEARCH_DESCRIPTION_CHARS)),
			...searchableTerms(extractSchemaSearchText(schema.function.parameters)),
		])
		const nameTerms = countTerms(nameSequence)
		return {
			schema,
			canonicalName: canonicalName(schema.function.name),
			nameSequence,
			nameTerms,
			descriptionTerms,
			nameLength: nameSequence.length,
			descriptionLength: [...descriptionTerms.values()].reduce((sum, count) => sum + count, 0),
		}
	})
	const documentFrequency = new Map<string, number>()
	for (const document of documents) {
		for (const term of new Set([...document.nameTerms.keys(), ...document.descriptionTerms.keys()])) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
		}
	}
	const inverseDocumentFrequency = new Map(
		[...documentFrequency].map(([term, frequency]) => [
			term,
			Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)),
		]),
	)
	const average = (length: (document: SearchDocument) => number) =>
		documents.length === 0
			? 1
			: Math.max(1, documents.reduce((sum, document) => sum + length(document), 0) / documents.length)
	return {
		documents,
		inverseDocumentFrequency,
		averageNameLength: average((document) => document.nameLength),
		averageDescriptionLength: average((document) => document.descriptionLength),
	}
}

function bm25FieldScore(
	termFrequency: number,
	fieldLength: number,
	averageFieldLength: number,
	inverseDocumentFrequency: number,
): number {
	if (termFrequency === 0) return 0
	const normalization = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLength / averageFieldLength))
	return (inverseDocumentFrequency * (termFrequency * (BM25_K1 + 1))) / normalization
}

function scoreSearchTerm(document: SearchDocument, term: string, index: SearchIndex): number {
	const inverseDocumentFrequency = index.inverseDocumentFrequency.get(term)
	if (inverseDocumentFrequency === undefined) return 0
	return (
		NAME_FIELD_WEIGHT *
			bm25FieldScore(
				document.nameTerms.get(term) ?? 0,
				document.nameLength,
				index.averageNameLength,
				inverseDocumentFrequency,
			) +
		DESCRIPTION_FIELD_WEIGHT *
			bm25FieldScore(
				document.descriptionTerms.get(term) ?? 0,
				document.descriptionLength,
				index.averageDescriptionLength,
				inverseDocumentFrequency,
			)
	)
}

function queryTerms(query: string): string[] {
	return [...new Set(searchableTerms(query))].slice(0, MAX_QUERY_TERMS)
}

function containsPhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
	if (phrase.length < 2 || phrase.length > haystack.length) return false
	for (let start = 0; start <= haystack.length - phrase.length; start++) {
		if (phrase.every((term, offset) => haystack[start + offset] === term)) return true
	}
	return false
}

function scoreDocument(document: SearchDocument, query: string, terms: readonly string[], index: SearchIndex): number {
	let score = 0
	for (const term of terms) {
		let best = scoreSearchTerm(document, term, index)
		const synonyms = SEARCH_SYNONYMS.get(term)
		if (synonyms) {
			let considered = 0
			for (const synonym of synonyms) {
				if (considered++ === MAX_QUERY_SYNONYMS_PER_TERM) break
				best = Math.max(best, scoreSearchTerm(document, synonym, index) * SYNONYM_WEIGHT)
			}
		}
		score += best
	}
	if (document.canonicalName === canonicalName(query)) score += 64
	else if (containsPhrase(document.nameSequence, terms)) score += 8 + terms.length
	return score
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function searchableSchemas(surface: TaskToolSurface): FunctionSchema[] {
	const limit = Math.min(DISCOVERY_OUTPUT_LIMIT, getToolOutputLimit(surface.policy, "tool_search"))
	return surface.schemas.filter(
		(schema): schema is FunctionSchema =>
			deferredSchema(schema, surface) &&
			surface.isCallable(schema.function.name) &&
			// Oversized individual schemas remain eager so output bounds cannot make a tool unreachable.
			JSON.stringify(success([reference(schema)])).length <= limit,
	)
}

interface CatalogEntry {
	key: string
	full: TaskToolSurface
	deferred: readonly FunctionSchema[]
	searchIndex: SearchIndex
	schemaDigests: ReadonlyMap<string, string>
	projected?: TaskToolSurface
	selectionKey?: string
}

/** Task-owned, bounded cache. Selections are hints; the captured policy is always the authority. */
export class TaskToolCatalogCache {
	private entry?: CatalogEntry
	private readonly identities = new WeakMap<object, number>()
	private nextIdentity = 0
	private selected = new Map<string, string>()

	/** Distinguish replaced connections/custom executables without retaining their live objects. */
	identity(value: object): number {
		let id = this.identities.get(value)
		if (id === undefined) {
			id = ++this.nextIdentity
			this.identities.set(value, id)
		}
		return id
	}

	capture(
		key: string,
		build: (search: ToolSearch) => TaskToolSurface,
		history: readonly ApiMessage[] = [],
	): TaskToolSurface {
		if (this.entry?.key !== key) {
			let captured: CatalogEntry
			const full = build((params, signal) => this.search(captured, params, signal))
			const candidates = full.isCallable("tool_search") ? searchableSchemas(full) : []
			const deferred =
				candidates.length >= DEFERRED_CATALOG_MIN_TOOLS &&
				Buffer.byteLength(JSON.stringify(candidates), "utf8") >= DEFERRED_CATALOG_MIN_BYTES
					? candidates
					: []
			captured = {
				key,
				full,
				deferred,
				searchIndex: buildSearchIndex(deferred),
				schemaDigests: new Map(
					full.schemas
						.filter((schema) => deferredSchema(schema, full))
						.filter((schema) => full.isCallable(schema.function.name))
						.map((schema) => [schema.function.name, digestValue(schema)]),
				),
			}
			this.entry = captured
		}

		const entry = this.entry
		this.restoreSelections(entry.schemaDigests, history)
		const deferredNames = new Set(entry.deferred.map((schema) => schema.function.name))
		const selectionKey = JSON.stringify([...this.selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
		if (entry.projected && entry.selectionKey === selectionKey) return entry.projected

		const schemas = entry.full.schemas.filter((schema) => {
			if (schema.type !== "function") return true
			if (schema.function.name === "discover_tools" || schema.function.name === "tool_search") {
				return deferredNames.size > 0 || entry.full.includeAllToolsWithRestrictions
			}
			return !deferredNames.has(schema.function.name) || this.selected.has(schema.function.name)
		})
		entry.projected = createTaskToolSurface({
			registry: entry.full.registry,
			schemas,
			policy: entry.full.policy,
			readGrant: entry.full.readGrant,
			profile: entry.full.profile,
			diagnosticSession: entry.full.diagnosticSession,
			diagnosticSourceTaskId: entry.full.diagnosticSourceTaskId,
			includeAllToolsWithRestrictions: entry.full.includeAllToolsWithRestrictions,
			applyProfile: false,
		})
		entry.selectionKey = selectionKey
		return entry.projected
	}

	private search(entry: CatalogEntry, params: { query: string; limit: number }, signal?: AbortSignal): string {
		if (signal?.aborted) return JSON.stringify({ status: "cancelled", message: "Tool discovery cancelled." })
		const parsed = toolSearchParamsSchema.safeParse(params)
		if (!parsed.success) return JSON.stringify({ status: "error", message: "Invalid tool discovery arguments." })
		const { query, limit } = parsed.data
		const terms = queryTerms(query)
		if (terms.length === 0) return JSON.stringify(success([], "Use a server, tool name, or capability keyword."))
		const ranked = entry.searchIndex.documents
			.map((document, index) => ({
				document,
				index,
				score: scoreDocument(document, query, terms, entry.searchIndex),
			}))
			.filter(({ score }) => score > 0)
			.sort(
				(a, b) =>
					b.score - a.score ||
					compareNames(a.document.schema.function.name, b.document.schema.function.name) ||
					a.index - b.index,
			)
		const tools: ReturnType<typeof reference>[] = []
		const outputLimit = Math.min(DISCOVERY_OUTPUT_LIMIT, getToolOutputLimit(entry.full.policy, "tool_search"))
		for (const { document } of ranked) {
			if (tools.length === limit) break
			const candidate = reference(document.schema)
			if (JSON.stringify(success([...tools, candidate])).length <= outputLimit) tools.push(candidate)
		}
		// Returning a result does not mutate the current surface or queue authority. Only a successful
		// persisted call/result transaction can promote these definitions at the next capture boundary.
		return JSON.stringify(success(tools))
	}

	private restoreSelections(current: ReadonlyMap<string, string>, history: readonly ApiMessage[]): void {
		const restored = new Map<string, string>()
		const lowerBound = Math.max(1, history.length - MAX_HISTORY_MESSAGES)
		for (let index = history.length - 1; index >= lowerBound && restored.size < MAX_SELECTED_TOOLS; index--) {
			const resultMessage = history[index]
			const callMessage = history[index - 1]
			if (
				resultMessage.role !== "user" ||
				callMessage.role !== "assistant" ||
				!Array.isArray(resultMessage.content) ||
				!Array.isArray(callMessage.content) ||
				resultMessage.content.length > MAX_MESSAGE_BLOCKS ||
				callMessage.content.length > MAX_MESSAGE_BLOCKS
			)
				continue
			for (const result of resultMessage.content) {
				if (
					result.type !== "tool_result" ||
					result.is_error ||
					typeof result.content !== "string" ||
					result.content.length > DISCOVERY_OUTPUT_LIMIT
				)
					continue
				const calls = callMessage.content.filter(
					(call) => call.type === "tool_use" && call.id === result.tool_use_id,
				)
				const call = calls[0]
				if (
					calls.length !== 1 ||
					call?.type !== "tool_use" ||
					!(call.name === "discover_tools" || call.name === "tool_search") ||
					!(call.name === "tool_search"
						? toolSearchParamsSchema.safeParse(call.input).success
						: discoverToolsParamsSchema.safeParse(call.input).success) ||
					resultMessage.content.filter(
						(block) => block.type === "tool_result" && block.tool_use_id === call.id,
					).length !== 1
				)
					continue
				try {
					const parsed = discoverToolsResultSchema.safeParse(JSON.parse(result.content))
					if (!parsed.success) continue
					for (const tool of parsed.data.tools) {
						if (restored.size === MAX_SELECTED_TOOLS) break
						if (
							current.get(tool.name) === tool.schemaDigest &&
							digestValue(tool.schema) === tool.schemaDigest
						) {
							restored.set(tool.name, tool.schemaDigest)
						}
					}
				} catch {
					// An old, malformed, or truncated tool result is not a discovery receipt.
				}
			}
		}
		// Keep still-valid task-local selections across context resets, bounded by the same limit.
		for (const [name, schemaDigest] of this.selected) {
			if (restored.size === MAX_SELECTED_TOOLS) break
			if (current.get(name) === schemaDigest && !restored.has(name)) restored.set(name, schemaDigest)
		}
		this.selected = restored
	}
}
