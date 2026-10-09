import path from "path"
import fs from "fs/promises"
import { createHash } from "crypto"
import type { ICodeParser, VectorStoreSearchResult } from "../interfaces"
import { MAX_FILE_SIZE_BYTES } from "../constants"
import { createIndexPoint, relativeIndexPath } from "./embedding-input"
import { codeTerms, lexicalText } from "./lexical"
import { scannerExtensions } from "./supported-extensions"
import { isPathInIgnoredDirectory } from "../../glob/ignore-utils"

export type SearchSource = {
	workspacePath: string
	validateAccess: (filePath: string) => boolean
	pendingFiles?: (limit: number) => readonly string[]
	parser?: ICodeParser
}

const FRESH_FILE_LIMIT = 64
type SourceFile = { content: string; hash: string }

/** Current source is query-scoped evidence, never an alternate persisted index. */
export class CurrentSource {
	private readonly files = new Map<string, Promise<SourceFile | null>>()
	private freshMatches: VectorStoreSearchResult[] = []

	private constructor(
		private readonly source: SearchSource,
		private readonly root: string,
	) {}

	static async open(source: SearchSource): Promise<CurrentSource> {
		return new CurrentSource(source, await fs.realpath(source.workspacePath))
	}

	clear(): void {
		this.files.clear()
	}

	getFreshMatches(): VectorStoreSearchResult[] {
		return [...this.freshMatches]
	}

	private inScope(relative: string, prefix?: string): boolean {
		const scope = prefix?.replace(/\/$/, "")
		return !scope || scope === "." || relative === scope || relative.startsWith(scope + "/")
	}

	private async read(filePath: string, prefix?: string): Promise<SourceFile | null> {
		try {
			const relative = relativeIndexPath(filePath, this.source.workspacePath)
			if (!this.inScope(relative, prefix) || !this.source.validateAccess(relative)) return null
			if (!this.files.has(relative)) {
				if (this.files.size >= 8) this.files.delete(this.files.keys().next().value!)
				const load = async () => {
					const real = await fs.realpath(path.join(this.root, relative))
					const realRelative = relativeIndexPath(real, this.root)
					const stats = await fs.stat(real)
					if (
						!this.source.validateAccess(realRelative) ||
						!stats.isFile() ||
						stats.size > MAX_FILE_SIZE_BYTES
					)
						return null
					const content = await fs.readFile(real, "utf8")
					if (Buffer.byteLength(content) > MAX_FILE_SIZE_BYTES) return null
					return { content, hash: createHash("sha256").update(content).digest("hex") }
				}
				this.files.set(relative, load())
			}
			return await this.files.get(relative)!
		} catch (error) {
			// Concurrent removal and unsafe paths cannot expose stale or out-of-workspace source.
			if (
				error instanceof Error &&
				"code" in error &&
				!["ENOENT", "EACCES", "EPERM"].includes(String(error.code))
			)
				throw error
			return null
		}
	}

	async accept(result: VectorStoreSearchResult, prefix?: string): Promise<boolean> {
		const payload = result.payload
		if (!payload) return false
		const file = await this.read(payload.filePath, prefix)
		return (
			!!file &&
			file.hash === payload.fileHash &&
			Number.isInteger(payload.startOffset) &&
			Number.isInteger(payload.endOffset) &&
			payload.startOffset >= 0 &&
			payload.endOffset > payload.startOffset &&
			file.content.slice(payload.startOffset, payload.endOffset) === payload.codeChunk
		)
	}

	async searchFresh(
		query: string,
		prefix: string | undefined,
		limit: number,
		signal: AbortSignal,
		onMatch?: () => void,
	): Promise<VectorStoreSearchResult[]> {
		const { pendingFiles, parser } = this.source
		if (!pendingFiles || !parser) return []
		const paths = [...new Set(pendingFiles(FRESH_FILE_LIMIT).slice(0, FRESH_FILE_LIMIT))]
		const terms = new Set(codeTerms(query))
		if (!terms.size) return []
		const matches: VectorStoreSearchResult[] = []
		this.freshMatches = matches
		let next = 0
		await Promise.all(
			Array.from({ length: Math.min(4, paths.length) }, async () => {
				while (next < paths.length) {
					signal.throwIfAborted()
					const filePath = paths[next++]
					let relative: string
					try {
						relative = relativeIndexPath(filePath, this.source.workspacePath)
					} catch {
						continue
					}
					if (
						isPathInIgnoredDirectory(relative) ||
						!scannerExtensions.includes(path.extname(relative).toLowerCase())
					)
						continue
					const file = await this.read(filePath, prefix)
					if (!file) continue
					const blocks = await parser.parseFile(path.join(this.root, relative), {
						content: file.content,
						fileHash: file.hash,
						signal,
					})
					for (const block of blocks) {
						signal.throwIfAborted()
						const point = createIndexPoint(block, this.root, [])
						const found = new Set(codeTerms(lexicalText(point.payload)))
						const count = [...terms].filter((term) => found.has(term)).length
						if (!count) continue
						matches.push({
							id: point.id,
							score: count / terms.size,
							payload: {
								...point.payload,
								filePath: relative,
								codeChunk: block.content,
								startLine: block.start_line,
								endLine: block.end_line,
							},
						})
						matches.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
						if (matches.length > limit) matches.pop()
						if (matches.length === 1) onMatch?.()
					}
				}
			}),
		)
		return matches
	}
}
