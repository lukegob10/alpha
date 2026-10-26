import * as fs from "fs/promises"
import { constants } from "fs"
import { createHash, randomUUID } from "crypto"
import os from "os"
import path from "path"

import { atomicWriteText, withFileLock } from "../../core/task-persistence/atomicWrite"
import { redactAgentCredentialText } from "../../core/agent/redactCredentials"
import { tiktoken } from "../../utils/tiktoken"
import { fingerprintContent } from "../../core/tools/contentVersion"
import { arePathsEqual } from "../../utils/path"
import {
	writeMemorySummaryInDocument,
	assertMemoryDocumentsClean,
	type MemorySummaryFile,
	type MemorySummaryWriteConditions,
	type MemorySummaryWriter,
} from "./MemorySummaryEditor"

const SUMMARY_MAX_BYTES = 10_000
const ROLLOUT_MAX_BYTES = 9_000
const MAX_FILE_BYTES = 256_000
const MAX_STATE_BYTES = 8_000_000
const MAX_FILES = 2_000
const MAX_SEARCH_RESULTS = 200
const TOKEN_CHUNK_BYTES = 1_024
const TOKEN_BOUNDARY_ALLOWANCE = 8
const SUMMARY_HEADINGS = ["## User Profile", "## User preferences", "## General Tips", "## What's in Memory"]

export interface MemorySearchMatch {
	path: string
	line: number
	text: string
}

export interface MemoryFileRead {
	content: string
	totalLines: number
	truncated: boolean
}

/** These operations share the caller's lock. Do not retain this facade after its callback returns. */
export interface MemoryStoreTransaction {
	readState(): Promise<unknown | undefined>
	writeState(value: unknown): Promise<void>
	writeSummary(text: string): Promise<void>
	readSummarySnapshot(): Promise<{ summary?: string; version?: string }>
	writeSummaryIfUnchanged(text: string, conditions: MemorySummaryWriteConditions): Promise<boolean>
	writeRolloutSummary(id: string, slug: string, text: string, sourceUpdatedAt?: number): Promise<string>
	removeRolloutSummary(relativePath: string): Promise<void>
	addAdHocNote(text: string, signal?: AbortSignal): Promise<string>
	readExtraction(id: string): Promise<string | undefined>
	writeExtraction(id: string, text: string): Promise<void>
	removeExtraction(id: string): Promise<void>
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

export function truncateMemoryText(text: string, maxBytes: number): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid memory byte limit")
	const bytes = Buffer.from(text, "utf8")
	if (bytes.byteLength <= maxBytes) return text
	let end = maxBytes
	// Never retain a partial UTF-8 code point at the byte boundary.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
	return bytes.subarray(0, end).toString("utf8")
}

export function redactMemoryText(text: string): string {
	// The shared diagnostic redactor treats a closing bracket as a value delimiter.
	// Protect its existing markers so persisted text stays unchanged on later reads.
	// Two shared markers keep restoration linear even for many previously redacted values.
	const prefix = `MEMORY_REDACTION_${randomUUID()}_`
	const markers = new Map([
		["[redacted]", `${prefix}VALUE`],
		["[redacted private key]", `${prefix}KEY`],
	])
	const protectedText = text
		.replace(/\[redacted(?: private key)?\]/g, (value) => markers.get(value)!)
		// SAS and presigned URLs authorize access without a credential-shaped field name.
		// Keep the resource pointer and nonsecret query parameters useful for retrieval.
		.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (url) =>
			url.replace(
				/([?&](?:amp;)?(?:sig|signature|x-(?:amz|goog)-signature)=)[^&#\s<>"'`)\]}]*/gi,
				`$1${markers.get("[redacted]")}`,
			),
		)
	// Historical tool output can end inside a quoted value; scrub it before the shared complete-field redactor.
	const quotedCredentials = protectedText.replace(
		/(\b[\w.-]*(?:authorization|api.?key|access.?key|client.?secret|secret|password|passwd|credential|private.?key|(?:(?:auth|access|refresh|id).?)?token)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/gi,
		(value, field: string) =>
			`${field}${markers.get("[redacted]")}${value.slice(field.length).match(/\r?\n/g)?.join("") ?? ""}`,
	)
	let redacted = redactAgentCredentialText(quotedCredentials)
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			// Retain line positions for reads of manually edited memory files. A partial key is private, too.
			(value) => `[redacted private key]${value.match(/\r?\n/g)?.join("") ?? ""}`,
		)
		.replace(
			/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
			"[redacted]",
		)
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
	for (const [value, marker] of markers) redacted = redacted.replaceAll(marker, value)
	return redacted
}

/** Matches the current Codex v2 artifact contract, independently implemented in TypeScript. */
export function isValidMemorySummary(text: string): boolean {
	const lines = text.split(/\r?\n/)
	return (
		lines[0] === "v1" &&
		Buffer.from(text, "utf8").toString("utf8") === text &&
		Buffer.byteLength(text, "utf8") < SUMMARY_MAX_BYTES &&
		SUMMARY_HEADINGS.every((heading) => lines.some((line) => line.trim() === heading))
	)
}

function* tokenChunks(text: string): Generator<string> {
	let offset = 0
	while (offset < text.length) {
		let end = Math.min(text.length, offset + TOKEN_CHUNK_BYTES)
		const last = text.charCodeAt(end - 1)
		if (last >= 0xd800 && last <= 0xdbff && end < text.length) end--
		const chunk = truncateMemoryText(text.slice(offset, end), TOKEN_CHUNK_BYTES)
		yield chunk
		offset += chunk.length
	}
}

/** Avoid quadratic tokenizer work on an unbroken manually edited line; count chunk boundaries conservatively. */
export async function countMemoryTokens(text: string, signal?: AbortSignal): Promise<number> {
	signal?.throwIfAborted()
	let tokens = 0
	for (const chunk of tokenChunks(text)) {
		await new Promise<void>((resolve) => setImmediate(resolve))
		signal?.throwIfAborted()
		tokens += (await tiktoken([{ type: "text", text: chunk }])) + TOKEN_BOUNDARY_ALLOWANCE
	}
	return tokens
}

export async function limitMemoryTokens(text: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted()
	if (maxTokens <= 0) return ""
	const parts: string[] = []
	let remaining = maxTokens
	for (const chunk of tokenChunks(text)) {
		const tokens = await countMemoryTokens(chunk, signal)
		if (tokens <= remaining) {
			parts.push(chunk)
			remaining -= tokens
			continue
		}
		let low = 0
		let high = Buffer.byteLength(chunk, "utf8")
		while (low < high) {
			const middle = Math.ceil((low + high) / 2)
			const prefix = truncateMemoryText(chunk, middle)
			if ((await countMemoryTokens(prefix, signal)) <= remaining) low = middle
			else high = middle - 1
		}
		parts.push(truncateMemoryText(chunk, low))
		break
	}
	signal?.throwIfAborted()
	return parts.join("")
}

function safeComponent(value: string, label: string, maxLength: number): string {
	if (!value || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`Invalid memory ${label}`)
	}
	return value
}

/**
 * Host-local memory namespace; it never reads or mutates workspace files.
 * Layout/validation reference: openai/codex 970111f6cb62cc02fe36a82ea7d71b37a2889c97 (2026-10-23).
 */
export class MemoryStore {
	private static readonly transactions = new Map<string, Promise<void>>()
	readonly home: string
	readonly rootPath: string
	readonly statePath: string
	private readonly now: () => number
	private readonly summaryWriter: MemorySummaryWriter

	constructor(options: { home?: string; now?: () => number; summaryWriter?: MemorySummaryWriter } = {}) {
		this.home = path.resolve(options.home ?? process.env.ALPHA_HOME ?? path.join(os.homedir(), ".alpha"))
		this.rootPath = path.join(this.home, "memories_v2")
		this.statePath = path.join(this.home, ".memory-state.json")
		this.now = options.now ?? Date.now
		this.summaryWriter = options.summaryWriter ?? writeMemorySummaryInDocument
	}

	static forDefaultHome(): MemoryStore {
		return new MemoryStore()
	}

	/** Check ancestors as well as the final entry, including an overridden Alpha home. */
	private async checkPath(file: string): Promise<void> {
		const relative = path.relative(this.home, file)
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error("Memory path must stay within Alpha home")
		}
		let current = path.resolve(file)
		while (true) {
			try {
				const stat = await fs.lstat(current)
				if (stat.isSymbolicLink()) throw new Error("Memory paths cannot contain symbolic links")
				if (current !== file && !stat.isDirectory()) throw new Error("Memory path ancestor is not a directory")
			} catch (error) {
				if (!missing(error)) throw error
			}
			const parent = path.dirname(current)
			if (parent === current) break
			current = parent
		}
	}

	private async ensureDirectory(directory: string): Promise<void> {
		await this.checkPath(directory)
		const relative = path.relative(this.home, directory)
		await fs.mkdir(this.home, { recursive: true, mode: 0o700 })
		let current = this.home
		for (const component of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, component)
			await this.checkPath(current)
			await fs.mkdir(current, { recursive: true, mode: 0o700 })
		}
		await this.checkPath(directory)
		if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Memory path must be a directory")
	}

	async initialize(): Promise<void> {
		await this.withTransaction(async () => this.ensureDirectory(this.rootPath))
	}

	async withTransaction<T>(operation: (transaction: MemoryStoreTransaction) => Promise<T>): Promise<T> {
		const key = process.platform === "win32" ? this.home.toLowerCase() : this.home
		const previous = MemoryStore.transactions.get(key)
		let releaseQueue: () => void = () => undefined
		const queued = new Promise<void>((resolve) => (releaseQueue = resolve))
		MemoryStore.transactions.set(key, queued)
		await previous
		try {
			await this.ensureDirectory(this.home)
			const lockPath = path.join(this.home, ".memories.transaction")
			await this.checkPath(lockPath)
			await this.checkPath(`${lockPath}.lock`)
			return await withFileLock(lockPath, async () => {
				await this.checkPath(this.home)
				let active = true
				const run = <TResult>(action: () => Promise<TResult>): Promise<TResult> => {
					if (!active) throw new Error("Memory transaction has finished")
					return action()
				}
				const transaction: MemoryStoreTransaction = {
					readState: () => run(() => this.readState()),
					writeState: (value) => run(() => this.writeState(value)),
					writeSummary: (text) => run(() => this.writeSummaryUnlocked(text)),
					readSummarySnapshot: () =>
						run(async () => {
							const { text, version } = await this.readSummaryFile()
							return {
								summary:
									text !== undefined && isValidMemorySummary(text)
										? redactMemoryText(text)
										: undefined,
								version,
							}
						}),
					writeSummaryIfUnchanged: (text, conditions) =>
						run(() => this.writeSummaryIfUnchanged(text, conditions)),
					writeRolloutSummary: (id, slug, text, updatedAt) =>
						run(() => this.writeRolloutSummaryUnlocked(id, slug, text, updatedAt)),
					removeRolloutSummary: (file) => run(() => this.removeRolloutSummaryUnlocked(file)),
					addAdHocNote: (text, signal) => run(() => this.addAdHocNoteUnlocked(text, signal)),
					readExtraction: (id) => run(() => this.readExtraction(id)),
					writeExtraction: (id, text) => run(() => this.writeExtractionUnlocked(id, text)),
					removeExtraction: (id) => run(() => this.removeExtractionUnlocked(id)),
				}
				try {
					return await operation(transaction)
				} finally {
					active = false
				}
			})
		} finally {
			releaseQueue()
			if (MemoryStore.transactions.get(key) === queued) MemoryStore.transactions.delete(key)
		}
	}

	private resolveFile(relativePath: string): string {
		const resolved = this.resolveDirectory(relativePath)
		if (!relativePath.endsWith(".md")) {
			throw new Error("Invalid memory file path")
		}
		return resolved
	}

	private resolveDirectory(relativePath: string): string {
		const components = relativePath.replace(/\\/g, "/").split("/")
		if (
			!relativePath ||
			relativePath.length > 4_096 ||
			components.some((component) => !component || component.startsWith(".") || /[:\0]/.test(component))
		) {
			throw new Error("Invalid memory path")
		}
		return path.join(this.rootPath, ...components)
	}

	private async readBounded(file: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted()
		await this.checkPath(file)
		const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
		try {
			await this.checkPath(file)
			signal?.throwIfAborted()
			const stat = await handle.stat()
			if (!stat.isFile()) throw new Error("Memory path must be a file")
			if (stat.size > maxBytes) throw new Error("Memory file exceeds its size limit")
			const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
			let bytesRead = 0
			while (bytesRead < bytes.byteLength) {
				signal?.throwIfAborted()
				const read = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead)
				if (!read.bytesRead) break
				bytesRead += read.bytesRead
			}
			if (bytesRead > maxBytes) throw new Error("Memory file exceeds its size limit")
			signal?.throwIfAborted()
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))
		} finally {
			await handle.close()
		}
	}

	async readSummary(): Promise<string | undefined> {
		try {
			if (await this.hasPendingForget()) return undefined
			const text = await this.readBounded(path.join(this.rootPath, "memory_summary.md"), SUMMARY_MAX_BYTES - 1)
			if (!isValidMemorySummary(text)) return undefined
			return await limitMemoryTokens(redactMemoryText(text), 2_500)
		} catch {
			// Corrupt, inaccessible, or missing optional memory must not prevent a foreground task from starting.
			return undefined
		}
	}

	private async writePrivate(file: string, text: string): Promise<void> {
		await this.ensureDirectory(path.dirname(file))
		await this.checkPath(file)
		await atomicWriteText(file, text, { requireAtomicReplace: true, mode: 0o600 })
	}

	private extractionPath(id: string): string {
		if (!id || id.length > 256) throw new Error("Invalid memory extraction identity")
		return path.join(this.home, ".memory-rollouts", `${createHash("sha256").update(id).digest("hex")}.md`)
	}

	/** Private stage-one cache, separate from the selected evidence exposed to tasks. */
	async readExtraction(id: string): Promise<string | undefined> {
		try {
			return await this.readBounded(this.extractionPath(id), ROLLOUT_MAX_BYTES)
		} catch (error) {
			if (missing(error)) return undefined
			throw error
		}
	}

	private async writeExtractionUnlocked(id: string, text: string): Promise<void> {
		await this.writePrivate(this.extractionPath(id), truncateMemoryText(redactMemoryText(text), ROLLOUT_MAX_BYTES))
	}

	private async removeExtractionUnlocked(id: string): Promise<void> {
		const file = this.extractionPath(id)
		await this.checkPath(file)
		await fs.rm(file, { force: true })
	}

	async writeSummary(text: string): Promise<void> {
		await this.withTransaction((transaction) => transaction.writeSummary(text))
	}

	private async writeSummaryUnlocked(text: string): Promise<void> {
		if (!isValidMemorySummary(text)) throw new Error("Invalid memory summary format or size")
		const redacted = redactMemoryText(text)
		if (!isValidMemorySummary(redacted)) throw new Error("Invalid redacted memory summary format or size")
		await this.writePrivate(path.join(this.rootPath, "memory_summary.md"), redacted)
	}

	private async readSummaryFile(): Promise<MemorySummaryFile> {
		try {
			const text = await this.readBounded(path.join(this.rootPath, "memory_summary.md"), MAX_FILE_BYTES)
			return { text, version: fingerprintContent(text) }
		} catch (error) {
			if (missing(error)) return {}
			throw error
		}
	}

	private async writeSummaryIfUnchanged(text: string, conditions: MemorySummaryWriteConditions): Promise<boolean> {
		if (!isValidMemorySummary(text)) throw new Error("Invalid memory summary format or size")
		const redacted = redactMemoryText(text)
		if (!isValidMemorySummary(redacted)) throw new Error("Invalid redacted memory summary format or size")
		conditions.signal.throwIfAborted()
		const file = path.join(this.rootPath, "memory_summary.md")
		await this.ensureDirectory(this.rootPath)
		await this.checkPath(`${file}.lock`)
		return this.summaryWriter(file, redacted, {
			...conditions,
			readFile: () => this.readSummaryFile(),
			assertPath: () => this.checkPath(file),
		})
	}

	async writeRolloutSummary(id: string, slug: string, text: string, sourceUpdatedAt?: number): Promise<string> {
		return this.withTransaction((transaction) => transaction.writeRolloutSummary(id, slug, text, sourceUpdatedAt))
	}

	private async writeRolloutSummaryUnlocked(
		id: string,
		slug: string,
		text: string,
		sourceUpdatedAt?: number,
	): Promise<string> {
		safeComponent(id, "rollout ID", 100)
		safeComponent(slug, "rollout slug", 80)
		if (sourceUpdatedAt !== undefined && (!Number.isSafeInteger(sourceUpdatedAt) || sourceUpdatedAt < 0)) {
			throw new Error("Invalid memory source timestamp")
		}
		const filename = `${id}_${slug}.md`
		const relative = `rollout_summaries/${filename}`
		const content = truncateMemoryText(redactMemoryText(text), ROLLOUT_MAX_BYTES)
		await this.writePrivate(this.resolveFile(relative), content)
		return relative
	}

	async listFiles(signal?: AbortSignal, relativeDirectory?: string): Promise<string[]> {
		signal?.throwIfAborted()
		const root = relativeDirectory ? this.resolveDirectory(relativeDirectory) : this.rootPath
		await this.checkPath(root)
		const files: string[] = []
		const pending = [root]
		let inspected = 0
		while (pending.length && files.length < MAX_FILES && inspected < MAX_FILES * 4) {
			signal?.throwIfAborted()
			const directory = pending.shift()!
			await this.checkPath(directory)
			let opened
			try {
				opened = await fs.opendir(directory)
			} catch (error) {
				if (missing(error)) continue
				throw error
			}
			const entries = []
			// Reading the whole directory before applying a cap permits an unbounded allocation.
			for await (const entry of opened) {
				signal?.throwIfAborted()
				if (++inspected > MAX_FILES * 4) break
				entries.push(entry)
			}
			entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
			for (const entry of entries) {
				if (files.length >= MAX_FILES) break
				if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue
				const file = path.join(directory, entry.name)
				if (entry.isDirectory()) pending.push(file)
				else if (entry.isFile() && entry.name.endsWith(".md")) {
					files.push(path.relative(this.rootPath, file).split(path.sep).join("/"))
				}
			}
		}
		signal?.throwIfAborted()
		return files.sort()
	}

	async readFile(relativePath: string, offset = 1, limit = 200, signal?: AbortSignal): Promise<string> {
		return (await this.readFileDetails(relativePath, offset, limit, signal)).content
	}

	async readFileDetails(
		relativePath: string,
		offset = 1,
		limit = 200,
		signal?: AbortSignal,
	): Promise<MemoryFileRead> {
		signal?.throwIfAborted()
		if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("Memory line offset and limit must be positive integers")
		}
		const file = this.resolveFile(relativePath)
		if (arePathsEqual(file, path.join(this.rootPath, "memory_summary.md")) && (await this.hasPendingForget())) {
			throw new Error("Memory summary is awaiting removal of excluded source knowledge")
		}
		const text = await this.readBounded(file, MAX_FILE_BYTES, signal)
		// Slicing first can expose the body of a multiline credential without its identifying header.
		const lines = redactMemoryText(text).split(/\r?\n/)
		if (offset > lines.length) throw new Error("Memory line offset exceeds file length")
		const end = Math.min(lines.length, offset - 1 + Math.min(limit, 2_000))
		const selected = lines.slice(offset - 1, end).join("\n")
		const content = await limitMemoryTokens(selected, 20_000, signal)
		signal?.throwIfAborted()
		return { content, totalLines: lines.length, truncated: end < lines.length || content !== selected }
	}

	async search(query: string, signal?: AbortSignal): Promise<MemorySearchMatch[]> {
		signal?.throwIfAborted()
		if (!query.trim() || query.length > 1_000) throw new Error("Memory search requires a nonempty bounded query")
		const matches: MemorySearchMatch[] = []
		const needle = query.toLowerCase()
		let inspectedBytes = 0
		for (const relative of await this.listFiles(signal)) {
			signal?.throwIfAborted()
			if (
				arePathsEqual(path.join(this.rootPath, relative), path.join(this.rootPath, "memory_summary.md")) &&
				(await this.hasPendingForget())
			)
				continue
			const text = redactMemoryText(await this.readBounded(this.resolveFile(relative), MAX_FILE_BYTES, signal))
			inspectedBytes += Buffer.byteLength(text, "utf8")
			if (inspectedBytes > MAX_STATE_BYTES) break
			for (const [index, line] of text.split(/\r?\n/).entries()) {
				if (index % 128 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve))
					signal?.throwIfAborted()
				}
				if (line.toLowerCase().includes(needle)) {
					matches.push({ path: relative, line: index + 1, text: truncateMemoryText(line, 1_000) })
					if (matches.length >= MAX_SEARCH_RESULTS) return matches
				}
			}
		}
		signal?.throwIfAborted()
		return matches
	}

	async addAdHocNote(text: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted()
		return this.withTransaction((transaction) => transaction.addAdHocNote(text, signal))
	}

	private async addAdHocNoteUnlocked(text: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted()
		if (!text.trim()) throw new Error("Memory note cannot be empty")
		const timestamp = new Date(this.now()).toISOString().slice(0, 19).replace(/:/g, "-")
		const relative = `extensions/ad_hoc/notes/${timestamp}-${randomUUID()}.md`
		const file = this.resolveFile(relative)
		await this.ensureDirectory(path.dirname(file))
		await this.checkPath(file)
		signal?.throwIfAborted()
		const handle = await fs.open(file, "wx", 0o600)
		let committed = false
		try {
			signal?.throwIfAborted()
			await handle.writeFile(truncateMemoryText(redactMemoryText(text), ROLLOUT_MAX_BYTES), "utf8")
			signal?.throwIfAborted()
			await handle.sync()
			signal?.throwIfAborted()
			committed = true
		} finally {
			await handle.close()
			if (!committed) await fs.rm(file, { force: true })
		}
		return relative
	}

	async removeRolloutSummary(relativePath: string): Promise<void> {
		await this.withTransaction((transaction) => transaction.removeRolloutSummary(relativePath))
	}

	private async removeRolloutSummaryUnlocked(relativePath: string): Promise<void> {
		const file = this.resolveFile(relativePath)
		if (path.dirname(file) !== path.join(this.rootPath, "rollout_summaries")) {
			throw new Error("Only rollout summaries can be pruned")
		}
		await this.checkPath(file)
		await fs.rm(file, { force: true })
	}

	private async readState(): Promise<unknown | undefined> {
		try {
			return JSON.parse(await this.readBounded(this.statePath, MAX_STATE_BYTES)) as unknown
		} catch (error) {
			if (missing(error)) return undefined
			throw error
		}
	}

	private async hasPendingForget(): Promise<boolean> {
		const state = await this.readState()
		return (
			state !== undefined &&
			state !== null &&
			typeof state === "object" &&
			"forgetPending" in state &&
			state.forgetPending === true
		)
	}

	private async writeState(value: unknown): Promise<void> {
		const text = JSON.stringify(value)
		if (text === undefined || Buffer.byteLength(text, "utf8") + 1 > MAX_STATE_BYTES) {
			throw new Error("Invalid memory state or size")
		}
		await this.writePrivate(this.statePath, `${text}\n`)
	}

	async reset(): Promise<void> {
		await this.withTransaction(async () => {
			const targets = [
				path.join(this.home, "memories"),
				this.rootPath,
				this.statePath,
				path.join(this.home, ".memory-rollouts"),
			]
			for (const target of targets) await this.checkPath(target)
			const assertClean = await assertMemoryDocumentsClean(targets)
			// Admit the explicit reset once; join all removals after this final guard.
			assertClean()
			for (const target of targets) await fs.rm(target, { recursive: true, force: true })
		})
	}
}
