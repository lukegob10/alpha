import {
	listProviderProfilesParamsSchema,
	isProviderName,
	MODELS_BY_PROVIDER,
	type ListProviderProfilesParams,
	type ProviderSettingsEntry,
} from "@alpha-code/types"

import { digestValue } from "../agent/StepContext"
import type { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"

interface ProfileReader {
	listProviderProfiles(): Promise<ProviderSettingsEntry[]>
}

class ProfileCatalogError extends Error {}

function matchesProviderLabel(provider: string | null, query: string): boolean {
	if (!provider) return false
	// Product labels aid discovery only; they never rewrite a returned provider or select a route.
	const labels =
		provider === "openai"
			? ["OpenAI Compatible"]
			: isProviderName(provider) && provider !== "openai"
				? [MODELS_BY_PROVIDER[provider].label, ...(MODELS_BY_PROVIDER[provider].aliases ?? [])]
				: []
	const normalizedQuery = query.replace(/[\s-]+/g, "")
	return (
		normalizedQuery.length > 0 &&
		labels.some((label) =>
			label
				.toLowerCase()
				.replace(/[\s-]+/g, "")
				.includes(normalizedQuery),
		)
	)
}

function parseCursor(value: string | null | undefined): { digest: string; offset: number } | undefined {
	if (value === undefined || value === null) return undefined
	const match = /^v1:([a-f0-9]{64}):(0|[1-9][0-9]{0,9})$/.exec(value)
	if (!match) throw new ProfileCatalogError("Invalid profile cursor. Restart list_provider_profiles without cursor.")
	return { digest: match[1], offset: Number(match[2]) }
}

function catalogPage(
	entries: readonly ProviderSettingsEntry[],
	query: string,
	cursor: ReturnType<typeof parseCursor>,
	remainingChars: number,
): string {
	const profiles = entries
		.map((entry) => ({
			id: entry.id,
			name: entry.name,
			provider: entry.apiProvider ?? null,
			model: entry.modelId ?? null,
			...(entry.availability ? { availability: entry.availability } : {}),
		}))
		.filter(
			({ id, name, provider, model }) =>
				[id, name, provider, model].some(
					(value) => typeof value === "string" && value.toLowerCase().includes(query),
				) || matchesProviderLabel(provider, query),
		)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const digest = digestValue({ query, profiles })
	if (cursor && (cursor.digest !== digest || cursor.offset > profiles.length)) {
		throw new ProfileCatalogError("Saved profiles or query changed. Restart list_provider_profiles without cursor.")
	}
	let offset = cursor?.offset ?? 0
	const selected: typeof profiles = []
	let omittedOversized = 0
	const serialize = (next: number) =>
		JSON.stringify({
			profiles: selected,
			next_cursor: next < profiles.length ? `v1:${digest}:${next}` : null,
			omitted_oversized: omittedOversized,
		})
	const charBudget = Number.isNaN(remainingChars) ? 0 : Math.max(0, Math.floor(remainingChars))
	const fits = (value: string) => value.length <= charBudget && Buffer.byteLength(value, "utf8") <= 8_192
	if (!fits(serialize(offset))) throw new ProfileCatalogError("Profile listing requires more tool output space.")
	const start = offset
	while (offset < profiles.length && selected.length < 50 && offset - start < 100) {
		selected.push(profiles[offset])
		if (!fits(serialize(offset + 1))) {
			selected.pop()
			if (selected.length) break
			omittedOversized++
		}
		offset++
	}
	const result = serialize(offset)
	if (!fits(result)) throw new ProfileCatalogError("Profile listing requires more tool output space.")
	return result
}

async function readProfiles(provider: ProfileReader, signal?: AbortSignal): Promise<ProviderSettingsEntry[]> {
	signal?.throwIfAborted()
	const pending = provider.listProviderProfiles()
	if (!signal) return pending
	let onAbort: () => void = () => undefined
	try {
		return await new Promise((resolve, reject) => {
			onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
			pending.then(resolve, reject)
			if (signal.aborted) onAbort()
		})
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

/** Reads saved metadata on demand; listing never activates or modifies a connection. */
export class ListProviderProfilesTool extends BaseTool<"list_provider_profiles"> {
	readonly name = "list_provider_profiles" as const

	async execute(params: ListProviderProfilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			callbacks.signal?.throwIfAborted()
			const parsed = listProviderProfilesParamsSchema.safeParse(params)
			if (!parsed.success) {
				throw new ProfileCatalogError(
					"list_provider_profiles accepts only query (up to 256 characters) and cursor.",
				)
			}
			const cursor = parseCursor(parsed.data.cursor)
			const provider = task.providerRef.deref() as Partial<ProfileReader> | undefined
			if (typeof provider?.listProviderProfiles !== "function") {
				throw new ProfileCatalogError("Saved provider profile discovery is unavailable in this host.")
			}
			const entries = await readProfiles(provider as ProfileReader, callbacks.signal)
			callbacks.signal?.throwIfAborted()
			const result = catalogPage(
				entries,
				parsed.data.query?.toLowerCase() ?? "",
				cursor,
				callbacks.getRemainingOutputChars?.() ?? 8_192,
			)
			callbacks.setResultMetadata?.({ status: "success" })
			callbacks.pushToolResult(result)
		} catch (error) {
			if (callbacks.signal?.aborted) {
				callbacks.setResultMetadata?.({ status: "cancelled" })
				callbacks.pushToolResult(JSON.stringify({ status: "cancelled", tool: this.name }))
				return
			}
			const message =
				error instanceof ProfileCatalogError
					? error.message
					: "Could not read saved provider profiles. Check provider settings and try again."
			task.recordToolError(this.name, message)
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult(`Error: ${message}`)
		}
	}
}

export const listProviderProfilesTool = new ListProviderProfilesTool()
