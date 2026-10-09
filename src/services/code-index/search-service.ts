import type { CodeIndexSearchResponse, VectorStoreSearchResult } from "./interfaces"
import { CODEBASE_INDEX_SEARCH_LIMITS, normalizeCodeIndexSearchMaxResults } from "@alpha-code/types"
import type { IEmbedder } from "./interfaces/embedder"
import type { IVectorStore } from "./interfaces/vector-store"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import { relativeIndexPath, validateEmbeddingBatch } from "./shared/embedding-input"
import { fuseSearchResults, packSearchResultsWithDiagnostics } from "./shared/retrieval"
import { CurrentSource, type SearchSource } from "./shared/current-source"
import { withIndexingCancellation } from "./shared/file-indexing"
import { t } from "../../i18n"

const RETRIEVAL_WAIT_MS = 1500
const SEMANTIC_WAIT_MS = 8000

export class CodeIndexSearchService {
	private readonly pending = new Set<AbortController>()
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly source?: SearchSource,
	) {}

	public async searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
		return (await this.searchIndexWithDiagnostics(query, directoryPrefix)).results
	}

	public async searchIndexWithDiagnostics(query: string, directoryPrefix?: string): Promise<CodeIndexSearchResponse> {
		const controller = new AbortController()
		this.pending.add(controller)
		try {
			return await this.retrieve(query, directoryPrefix, controller)
		} finally {
			this.pending.delete(controller)
		}
	}

	public cancelPending(): void {
		for (const controller of this.pending) controller.abort(new DOMException("Code search stopped", "AbortError"))
	}

	private async retrieve(
		query: string,
		directoryPrefix: string | undefined,
		controller: AbortController,
	): Promise<CodeIndexSearchResponse> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}
		const state = this.stateManager.getCurrentStatus().systemStatus
		if (state !== "Indexed" && state !== "Indexing" && state !== "Error")
			throw new Error("Code index is not ready for search. Current state: " + state)
		const maxResults = normalizeCodeIndexSearchMaxResults(this.configManager.currentSearchMaxResults)
		const minScore = this.configManager.currentSearchMinScore
		// Preserve the default search breadth when the user asks for less output context.
		const candidates = CODEBASE_INDEX_SEARCH_LIMITS.CANDIDATES_PER_CHANNEL
		const searchDiagnostics = {
			candidateLimit: candidates,
			semanticCandidates: 0,
			lexicalCandidates: 0,
			fusedCandidates: 0,
			effectiveMaxResults: maxResults,
			contextTokenBudget: CODEBASE_INDEX_SEARCH_LIMITS.CONTEXT_TOKEN_BUDGET,
			indexFreshness:
				state === "Indexed"
					? ("current" as const)
					: state === "Indexing"
						? ("catching-up" as const)
						: ("error" as const),
		}
		if (!query.trim()) {
			const packed = await packSearchResultsWithDiagnostics([], maxResults)
			return { results: [], diagnostics: { ...searchDiagnostics, ...packed.diagnostics } }
		}
		if (query.length > 8192) throw new Error("Code search query exceeds 8192 characters")
		const prefix = directoryPrefix
			? relativeIndexPath(directoryPrefix, this.source?.workspacePath ?? process.cwd())
			: undefined
		const started = Date.now()
		const timeout = () => controller.abort(new DOMException(t("embeddings:searchTimeout"), "TimeoutError"))
		let timer = setTimeout(timeout, SEMANTIC_WAIT_MS)
		let localDeadline = false
		const limitWaiting = () => {
			if (localDeadline || controller.signal.aborted) return
			localDeadline = true
			clearTimeout(timer)
			timer = setTimeout(timeout, Math.max(0, started + RETRIEVAL_WAIT_MS - Date.now()))
		}
		const signal = controller.signal
		let current: CurrentSource | undefined
		const fresh = async () => {
			if (!this.source) return []
			const opened = await CurrentSource.open(this.source)
			signal.throwIfAborted()
			current = opened
			return current.searchFresh(query, prefix, candidates, signal, limitWaiting)
		}
		const semantic = async () => {
			const response = await this.embedder.createEmbeddings([query], undefined, "query", signal)
			signal.throwIfAborted()
			validateEmbeddingBatch(response.embeddings, 1)
			return this.vectorStore.search(response.embeddings[0], prefix, minScore, candidates)
		}
		let channels: PromiseSettledResult<VectorStoreSearchResult[]>[]
		try {
			channels = await Promise.allSettled(
				[
					semantic(),
					this.vectorStore.searchLexical?.(query, prefix, candidates) ?? Promise.resolve([]),
					fresh(),
				].map((channel) =>
					withIndexingCancellation(
						Promise.resolve(channel).then((matches) => {
							if (matches.length) limitWaiting()
							return matches
						}),
						signal,
					),
				),
			)
		} finally {
			clearTimeout(timer)
		}
		const assertActive = () => {
			if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"))
				signal.throwIfAborted()
		}
		assertActive()
		// A transient search failure must not change the indexing lifecycle or disable future searches.
		const matches = channels.map((channel) => (channel.status === "fulfilled" ? channel.value : []))
		if (channels[2].status === "rejected" && signal.aborted && channels[2].reason === signal.reason)
			matches[2] = current?.getFreshMatches() ?? []
		const available = matches.some((matches) => matches.length > 0)
		const failed = channels.find((channel) => channel.status === "rejected")
		if (!available && failed?.status === "rejected") throw failed.reason
		if (failed) console.warn("[CodeIndexSearchService] One retrieval channel failed; returning available matches")
		const seen = new Set<string>()
		const lexical = [...matches[2], ...matches[1]]
			.filter((match) => {
				const id = String(match.id)
				if (seen.has(id)) return false
				seen.add(id)
				return true
			})
			.slice(0, candidates)
		const freshById = new Map(matches[2].map((match) => [String(match.id), match]))
		// An old vector with the same chunk ID must not hide current lexical evidence behind its stale file hash.
		const semanticMatches = matches[0].filter((match) => {
			const fresh = freshById.get(String(match.id))
			return !fresh || match.payload?.fileHash === fresh.payload?.fileHash
		})
		const ranked = fuseSearchResults([semanticMatches, lexical])
		// Source may have changed while the cloud request was pending. Validate again before returning evidence.
		current?.clear()
		const validatedSource = current
		const packed = await packSearchResultsWithDiagnostics(
			ranked,
			maxResults,
			undefined,
			this.source
				? (result) => {
						assertActive()
						return validatedSource?.accept(result, prefix) ?? Promise.resolve(false)
					}
				: undefined,
		)
		assertActive()
		if (!packed.results.length && failed?.status === "rejected") throw failed.reason
		return {
			results: packed.results,
			diagnostics: {
				...searchDiagnostics,
				semanticCandidates: matches[0].length,
				lexicalCandidates: lexical.length,
				freshCandidates: matches[2].length,
				semanticStatus:
					channels[0].status === "fulfilled"
						? "complete"
						: channels[0].reason === signal.reason
							? "timeout"
							: "error",
				lexicalStatus:
					channels[1].status === "fulfilled"
						? "complete"
						: channels[1].reason === signal.reason
							? "timeout"
							: "error",
				freshStatus:
					channels[2].status === "fulfilled"
						? "complete"
						: channels[2].reason === signal.reason
							? "timeout"
							: "error",
				fusedCandidates: ranked.length,
				...packed.diagnostics,
			},
		}
	}
}
