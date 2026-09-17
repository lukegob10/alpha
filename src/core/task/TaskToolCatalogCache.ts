import type OpenAI from "openai"
import { discoverToolsParamsSchema, discoverToolsResultSchema, type DiscoverToolsParams } from "@alpha-code/types"

import { digestValue } from "../agent/StepContext"
import { getToolOutputLimit } from "../agent/ToolPolicy"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { createTaskToolSurface, type TaskToolSurface } from "../tools/TaskToolSurface"

const MAX_SELECTED_TOOLS = 32
const MAX_HISTORY_MESSAGES = 512
const MAX_MESSAGE_BLOCKS = 128
export const DISCOVERY_OUTPUT_LIMIT = 24_000
// Calibrated against the effective request fixtures, not the raw native catalog.
export const DEFERRED_CATALOG_MIN_TOOLS = 8
export const DEFERRED_CATALOG_MIN_BYTES = 16_000

type FunctionSchema = OpenAI.Chat.ChatCompletionFunctionTool
export type DiscoverTools = (params: DiscoverToolsParams, signal?: AbortSignal) => string

function optionalSchema(schema: OpenAI.Chat.ChatCompletionTool): schema is FunctionSchema {
	return schema.type === "function" && schema.function.name.startsWith("mcp--")
}

function reference(schema: FunctionSchema) {
	return { name: schema.function.name, schemaDigest: digestValue(schema), schema }
}

function success(tools: ReturnType<typeof reference>[], message?: string) {
	return { version: 1 as const, status: "success" as const, activation: "next_step" as const, tools, message }
}

function searchableSchemas(surface: TaskToolSurface): FunctionSchema[] {
	const limit = Math.min(DISCOVERY_OUTPUT_LIMIT, getToolOutputLimit(surface.policy, "discover_tools"))
	return surface.schemas.filter(
		(schema): schema is FunctionSchema =>
			optionalSchema(schema) &&
			surface.isCallable(schema.function.name) &&
			// Oversized individual schemas remain eager so output bounds cannot make a tool unreachable.
			JSON.stringify(success([reference(schema)])).length <= limit,
	)
}

interface CatalogEntry {
	key: string
	full: TaskToolSurface
	deferred: readonly FunctionSchema[]
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
		build: (discover: DiscoverTools) => TaskToolSurface,
		history: readonly ApiMessage[] = [],
	): TaskToolSurface {
		if (this.entry?.key !== key) {
			let captured: CatalogEntry
			const full = build((params, signal) => this.discover(captured, params, signal))
			const candidates = full.isCallable("discover_tools") ? searchableSchemas(full) : []
			const deferred =
				candidates.length >= DEFERRED_CATALOG_MIN_TOOLS &&
				Buffer.byteLength(JSON.stringify(candidates), "utf8") >= DEFERRED_CATALOG_MIN_BYTES
					? candidates
					: []
			captured = {
				key,
				full,
				deferred,
				schemaDigests: new Map(
					full.schemas
						.filter(optionalSchema)
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
			if (schema.function.name === "discover_tools") {
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
			includeAllToolsWithRestrictions: entry.full.includeAllToolsWithRestrictions,
			applyProfile: false,
		})
		entry.selectionKey = selectionKey
		return entry.projected
	}

	private discover(entry: CatalogEntry, params: DiscoverToolsParams, signal?: AbortSignal): string {
		if (signal?.aborted) return JSON.stringify({ status: "cancelled", message: "Tool discovery cancelled." })
		const parsed = discoverToolsParamsSchema.safeParse(params)
		if (!parsed.success) return JSON.stringify({ status: "error", message: "Invalid tool discovery arguments." })
		const { query, limit = 3 } = parsed.data
		const terms = query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean)
		if (terms.length === 0) return JSON.stringify(success([], "Use a server, tool name, or capability keyword."))
		const ranked = entry.deferred
			.map((schema) => {
				const name = schema.function.name.toLowerCase()
				const description = (schema.function.description ?? "").slice(0, 8_000).toLowerCase()
				const score = terms.reduce(
					(sum, term) => sum + (name.includes(term) ? 3 : description.includes(term) ? 1 : 0),
					0,
				)
				return { schema, score }
			})
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score || (a.schema.function.name < b.schema.function.name ? -1 : 1))
		const tools: ReturnType<typeof reference>[] = []
		const outputLimit = Math.min(DISCOVERY_OUTPUT_LIMIT, getToolOutputLimit(entry.full.policy, "discover_tools"))
		for (const { schema } of ranked) {
			if (tools.length === limit) break
			const candidate = reference(schema)
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
					call.name !== "discover_tools" ||
					!discoverToolsParamsSchema.safeParse(call.input).success ||
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
