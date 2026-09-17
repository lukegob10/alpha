import { readFile } from "fs/promises"
import { createHash } from "crypto"
import path from "path"
import type { Node } from "web-tree-sitter"
import { LanguageParser, loadRequiredLanguageParsers } from "../../tree-sitter/languageParser"
import type { ICodeParser, CodeBlock } from "../interfaces"
import { scannerExtensions, shouldUseFallbackChunking } from "../shared/supported-extensions"
import { chunkSource, CodeScope } from "./chunking"

/** Syntax supplies scope; chunking preserves complete source, including parse-error regions. */
export class CodeParser implements ICodeParser {
	private loadedParsers: LanguageParser = {}
	private pendingLoads = new Map<string, Promise<LanguageParser>>()

	async parseFile(
		filePath: string,
		options?: { content?: string; fileHash?: string; signal?: AbortSignal },
	): Promise<CodeBlock[]> {
		options?.signal?.throwIfAborted()
		const extension = path.extname(filePath).toLowerCase()
		if (!scannerExtensions.includes(extension)) return []
		const content = options?.content ?? (await readFile(filePath, "utf8"))
		const fileHash = options?.fileHash ?? createHash("sha256").update(content).digest("hex")
		const partition = (scopes: CodeScope[] = [], type = "code_chunk") =>
			chunkSource(filePath, content, fileHash, scopes, type, options?.signal)
		if (!content.trim()) return []
		if (extension === ".md" || extension === ".markdown") {
			return partition(this.markdownScopes(content), "markdown_content")
		}
		if (shouldUseFallbackChunking(extension)) return partition([], "fallback_chunk")

		const key = extension.slice(1)
		if (!this.loadedParsers[key]) {
			let pending = this.pendingLoads.get(key)
			if (!pending) {
				pending = loadRequiredLanguageParsers([filePath])
				this.pendingLoads.set(key, pending)
			}
			try {
				Object.assign(this.loadedParsers, await pending)
			} catch {
				// A missing grammar must not make an otherwise readable file disappear.
				return partition([], "fallback_chunk")
			} finally {
				if (this.pendingLoads.get(key) === pending) this.pendingLoads.delete(key)
			}
		}
		const language = this.loadedParsers[key]
		if (!language) return partition([], "fallback_chunk")
		const tree = language.parser.parse(content)
		try {
			const scopes: CodeScope[] = []
			const seen = new Set<string>()
			for (const capture of tree ? language.query.captures(tree.rootNode) : []) {
				if (!capture.name.startsWith("definition.")) continue
				const node = capture.node
				const id = `${node.startIndex}:${node.endIndex}`
				if (seen.has(id)) continue
				seen.add(id)
				scopes.push({
					startLine: node.startPosition.row + 1,
					endLine: node.endPosition.row + 1,
					name: node.childForFieldName("name")?.text ?? "",
					signature: this.signature(node),
					type: node.type,
				})
			}
			return await partition(scopes)
		} finally {
			tree?.delete()
		}
	}

	private signature(node: Node): string {
		const body = node.childForFieldName("body")
		const header = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text.split("\n", 1)[0]
		const previous = node.previousNamedSibling
		const documentation = previous?.type.includes("comment") ? previous.text.slice(0, 240) + "\n" : ""
		return documentation + header.replace(/\s+/g, " ").trim().slice(0, 360)
	}

	private markdownScopes(content: string): CodeScope[] {
		const lines = content.split("\n")
		const scopes: CodeScope[] = []
		const active: CodeScope[] = []
		let fence: string | undefined
		for (let index = 0; index < lines.length; index++) {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index])
			if (marker) {
				if (!fence) fence = marker[1]
				else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
					fence = undefined
				continue
			}
			if (fence) continue
			const match = /^(#{1,6})\s+(.+)/.exec(lines[index])
			if (!match) continue
			const level = match[1].length
			while (active.length && Number(active.at(-1)!.type.at(-1)) >= level) active.pop()!.endLine = index
			scopes.push({
				startLine: index + 1,
				endLine: lines.length,
				name: match[2],
				signature: lines[index],
				type: `markdown_header_h${level}`,
			})
			active.push(scopes.at(-1)!)
		}
		return scopes
	}
}

export const codeParser = new CodeParser()
