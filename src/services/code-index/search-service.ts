import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import type { VectorStoreSearchResult } from "./interfaces"
import type { IEmbedder } from "./interfaces/embedder"
import type { IVectorStore } from "./interfaces/vector-store"
import type { CodeIndexConfigManager } from "./config-manager"
import type { CodeIndexStateManager } from "./state-manager"
import { MAX_FILE_SIZE_BYTES } from "./constants"
import { relativeIndexPath, validateEmbeddingBatch } from "./shared/embedding-input"
import { fuseSearchResults, packSearchResults } from "./shared/retrieval"

export class CodeIndexSearchService {
	constructor(
		private readonly configManager: CodeIndexConfigManager,
		private readonly stateManager: CodeIndexStateManager,
		private readonly embedder: IEmbedder,
		private readonly vectorStore: IVectorStore,
		private readonly source?: { workspacePath: string; validateAccess: (filePath: string) => boolean },
	) {}

	public async searchIndex(query: string, directoryPrefix?: string): Promise<VectorStoreSearchResult[]> {
		if (!this.configManager.isFeatureEnabled || !this.configManager.isFeatureConfigured) {
			throw new Error("Code index feature is disabled or not configured.")
		}
		const state = this.stateManager.getCurrentStatus().systemStatus
		if (state !== "Indexed" && state !== "Indexing")
			throw new Error("Code index is not ready for search. Current state: " + state)
		if (!query.trim()) return []
		if (query.length > 8192) throw new Error("Code search query exceeds 8192 characters")
		const prefix = directoryPrefix
			? relativeIndexPath(directoryPrefix, this.source?.workspacePath ?? process.cwd())
			: undefined
		const maxResults = Math.max(1, Math.min(100, this.configManager.currentSearchMaxResults))
		const candidates = Math.min(200, Math.max(40, maxResults * 4))
		const semantic = async () => {
			const response = await this.embedder.createEmbeddings([query], undefined, "query")
			validateEmbeddingBatch(response.embeddings, 1)
			return this.vectorStore.search(
				response.embeddings[0],
				prefix,
				this.configManager.currentSearchMinScore,
				candidates,
			)
		}
		const channels = await Promise.allSettled([
			semantic(),
			this.vectorStore.searchLexical?.(query, prefix, candidates) ?? Promise.resolve([]),
		])
		// A transient search failure must not change the indexing lifecycle or disable future searches.
		const available = channels.some((channel) => channel.status === "fulfilled" && channel.value.length > 0)
		const failed = channels.find((channel) => channel.status === "rejected")
		if (!available && failed?.status === "rejected") throw failed.reason
		if (failed) console.warn("[CodeIndexSearchService] One retrieval channel failed; returning available matches")
		const ranked = fuseSearchResults(
			channels.map((channel) => (channel.status === "fulfilled" ? channel.value : [])),
		)
		return packSearchResults(ranked, maxResults, undefined, await this.sourceValidator(prefix))
	}

	private async sourceValidator(
		prefix?: string,
	): Promise<((result: VectorStoreSearchResult) => Promise<boolean>) | undefined> {
		if (!this.source) return undefined
		const source = this.source
		const root = await fs.realpath(source.workspacePath)
		// Validate only evidence that fits the output budget. Keep at most eight source files in memory.
		const files = new Map<string, { content: string; hash: string } | null>()
		return async (result) => {
			const payload = result.payload
			if (!payload) return false
			try {
				const relative = relativeIndexPath(payload.filePath, source.workspacePath)
				const scope = prefix?.replace(/\/$/, "")
				if (scope && scope !== "." && relative !== scope && !relative.startsWith(scope + "/")) return false
				if (!source.validateAccess(relative)) return false
				if (!files.has(relative)) {
					if (files.size >= 8) files.delete(files.keys().next().value!)
					files.set(relative, null)
					const real = await fs.realpath(path.join(root, relative))
					const realRelative = relativeIndexPath(real, root)
					if (!source.validateAccess(realRelative) || (await fs.stat(real)).size > MAX_FILE_SIZE_BYTES)
						return false
					const content = await fs.readFile(real, "utf8")
					files.set(relative, { content, hash: createHash("sha256").update(content).digest("hex") })
				}
				const file = files.get(relative)
				if (!file || file.hash !== payload.fileHash) return false
				if (
					!Number.isInteger(payload.startOffset) ||
					!Number.isInteger(payload.endOffset) ||
					payload.startOffset < 0 ||
					payload.endOffset <= payload.startOffset
				)
					return false
				if (file.content.slice(payload.startOffset, payload.endOffset) !== payload.codeChunk) return false
				return true
			} catch (error) {
				// Concurrent deletes, changed symlinks and out-of-scope results cannot expose stale source.
				if (
					error instanceof Error &&
					"code" in error &&
					!["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
				)
					throw error
				return false
			}
		}
	}
}
