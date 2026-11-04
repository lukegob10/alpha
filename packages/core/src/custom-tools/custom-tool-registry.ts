/**
 * CustomToolRegistry - A reusable class for dynamically loading and managing TypeScript tools.
 *
 * Features:
 * - Dynamic TypeScript/JavaScript tool loading with esbuild transpilation.
 * - Runtime validation of tool definitions.
 * - Tool execution with context.
 * - JSON Schema generation for LLM integration.
 */

import fs from "fs"
import path from "path"
import { createHash, randomUUID } from "crypto"
import os from "os"
import { pathToFileURL } from "url"
import { createRequire } from "module"

import type {
	CustomToolDefinition,
	SerializedCustomToolDefinition,
	CustomToolParametersSchema,
} from "@alpha-code/types"

import type { StoredCustomTool, LoadResult, CatalogLoadResult } from "./types.js"
import { serializeCustomTool } from "./serialize.js"
import { runEsbuild, NODE_BUILTIN_MODULES, COMMONJS_REQUIRE_BANNER } from "./esbuild-runner.js"

export interface RegistryOptions {
	/** Directory for caching compiled TypeScript files. */
	cacheDir?: string
	/** Additional paths for resolving node modules (useful for tools outside node_modules). */
	nodePaths?: string[]
	/** Path to the extension root directory (for finding bundled esbuild binary in production). */
	extensionPath?: string
}

const MAX_CACHED_DIRECTORIES = 64
const MAX_COMPILED_SOURCES = 128
const MAX_IMPORT_GENERATIONS = 256
const PROCESS_CACHE_NAMESPACE = `host-${process.pid}-${randomUUID()}`

// Node retains ESM generations for the lifetime of the extension host, including failed imports.
// Keep this budget process-wide across registry instances; cache eviction cannot reclaim those modules.
const importedModuleUrls = new Set<string>()
const pendingModuleLoads = new Map<string, Promise<Record<string, unknown>>>()
const activeCacheDirectories = new Set<string>()
const pendingCacheGenerations = new Set<string>()
const retainedCacheDirectories = new Set<string>()
const pendingCacheRemovals = new Map<string, Promise<void>>()
const pendingCachePrunes = new Map<string, Promise<void>>()

interface DirectorySnapshot {
	fingerprint: string
	tools: readonly StoredCustomTool[]
	loaded: readonly string[]
	failed: ReadonlyArray<LoadResult["failed"][number]>
}

interface CompiledSource {
	fingerprint: string
	url: string
}

const fingerprint = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex")

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class CustomToolRegistry {
	private tools = new Map<string, StoredCustomTool>()
	private registeredTools = new Map<string, StoredCustomTool>()
	private directorySnapshots = new Map<string, DirectorySnapshot>()
	private pendingDirectories = new Map<string, Promise<DirectorySnapshot>>()
	private tsCache = new Map<string, CompiledSource>()
	private cacheRoot: string
	private cacheDir: string
	private cacheReady?: Promise<void>
	private nodePaths: string[]
	private extensionPath?: string
	private clearVersion = 0

	constructor(options?: RegistryOptions) {
		this.cacheRoot = path.resolve(options?.cacheDir ?? path.join(os.tmpdir(), "dynamic-tools-cache"))
		this.cacheDir = path.join(this.cacheRoot, PROCESS_CACHE_NAMESPACE)
		// Default to current working directory's node_modules.
		this.nodePaths = options?.nodePaths ?? [path.join(process.cwd(), "node_modules")]
		this.extensionPath = options?.extensionPath
	}

	/**
	 * Load all tools from a directory.
	 * Supports both .ts and .js files.
	 *
	 * @param toolDir - Absolute path to the tools directory
	 * @returns LoadResult with lists of loaded and failed tools
	 */
	async loadFromDirectory(toolDir: string): Promise<CatalogLoadResult> {
		return this.loadDirectories([toolDir], true)
	}

	async loadFromDirectoryIfStale(toolDir: string): Promise<CatalogLoadResult> {
		return this.loadDirectories([toolDir], false)
	}

	/**
	 * Load all tools from multiple directories.
	 * Directories are processed in order, so later directories can override tools from earlier ones.
	 * Supports both .ts and .js files.
	 *
	 * @param toolDirs - Array of absolute paths to tools directories
	 * @returns LoadResult with lists of loaded and failed tools from all directories
	 */
	async loadFromDirectories(toolDirs: string[]): Promise<CatalogLoadResult> {
		return this.loadDirectories(toolDirs, true)
	}

	/**
	 * Load all tools from multiple directories if any has become stale.
	 * Directories are processed in order, so later directories can override tools from earlier ones.
	 *
	 * @param toolDirs - Array of absolute paths to tools directories
	 * @returns LoadResult with lists of loaded and failed tools
	 */
	async loadFromDirectoriesIfStale(toolDirs: string[]): Promise<CatalogLoadResult> {
		return this.loadDirectories(toolDirs, false)
	}

	private async loadDirectories(toolDirs: readonly string[], force: boolean): Promise<CatalogLoadResult> {
		const version = this.clearVersion
		const snapshots: DirectorySnapshot[] = []
		for (const toolDir of toolDirs) snapshots.push(await this.loadDirectorySnapshot(toolDir, force))
		const tools = new Map(this.registeredTools)
		const result: CatalogLoadResult = { loaded: [], failed: [], catalog: [] }
		for (const snapshot of snapshots) {
			for (const tool of snapshot.tools) tools.set(tool.name, tool)
			result.loaded.push(...snapshot.loaded)
			result.failed.push(...snapshot.failed)
		}
		result.catalog = Object.freeze([...tools.values()])
		// Legacy getters project the last completed request atomically. Executable consumers retain result.catalog.
		if (version === this.clearVersion) this.tools = tools
		return result
	}

	private async loadDirectorySnapshot(toolDir: string, force: boolean): Promise<DirectorySnapshot> {
		let directory = path.resolve(toolDir)
		try {
			directory = await fs.promises.realpath(directory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return {
					fingerprint: "",
					tools: [],
					loaded: [],
					failed: [{ file: toolDir, error: errorMessage(error) }],
				}
			}
		}
		const key = process.platform === "win32" ? directory.toLowerCase() : directory
		const pending = this.pendingDirectories.get(key)
		if (pending) {
			if (!force) return pending
			await pending
			return this.loadDirectorySnapshot(toolDir, force)
		}
		if (this.pendingDirectories.size >= MAX_CACHED_DIRECTORIES) {
			return {
				fingerprint: "",
				tools: [],
				loaded: [],
				failed: [
					{
						file: toolDir,
						error: "Too many concurrent custom tool directory loads. Retry after the current loads finish.",
					},
				],
			}
		}
		const version = this.clearVersion
		const loading = this.readDirectorySnapshot(directory, key, force)
		this.pendingDirectories.set(key, loading)
		try {
			const snapshot = await loading
			if (version === this.clearVersion) {
				this.directorySnapshots.delete(key)
				this.directorySnapshots.set(key, snapshot)
				while (this.directorySnapshots.size > MAX_CACHED_DIRECTORIES) {
					this.directorySnapshots.delete(this.directorySnapshots.keys().next().value!)
				}
			}
			return snapshot
		} finally {
			this.pendingDirectories.delete(key)
		}
	}

	private async readDirectorySnapshot(directory: string, key: string, force: boolean): Promise<DirectorySnapshot> {
		const loaded: string[] = []
		const failed: LoadResult["failed"] = []
		const tools = new Map<string, StoredCustomTool>()
		try {
			const files = (await fs.promises.readdir(directory, { withFileTypes: true }))
				.filter((entry) => !entry.isDirectory() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")))
				.map((entry) => entry.name)
				.sort()
			const manifest: Array<{ file: string; fingerprint: string }> = []
			for (const file of files) {
				try {
					manifest.push({
						file,
						fingerprint: fingerprint(await fs.promises.readFile(path.join(directory, file))),
					})
				} catch (error) {
					failed.push({ file, error: errorMessage(error) })
				}
			}
			const sourceFingerprint = fingerprint(JSON.stringify({ manifest, failed }))
			const cached = this.directorySnapshots.get(key)
			if (!force && cached?.fingerprint === sourceFingerprint && cached.failed.length === 0) return cached
			for (const entry of manifest) {
				const filePath = path.join(directory, entry.file)
				try {
					const mod = await this.import(filePath, entry.fingerprint, force)
					const fileTools: StoredCustomTool[] = []
					for (const [exportName, value] of Object.entries(mod)) {
						const definition = this.validate(exportName, value)
						if (definition) fileTools.push(Object.freeze({ ...definition, source: filePath }))
					}
					for (const tool of fileTools) {
						tools.set(tool.name, tool)
						loaded.push(tool.name)
					}
				} catch (error) {
					const message = errorMessage(error)
					console.error(`[CustomToolRegistry] import(${filePath}) failed: ${message}`)
					failed.push({ file: entry.file, error: message })
				}
			}
			return { fingerprint: sourceFingerprint, tools: Object.freeze([...tools.values()]), loaded, failed }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				failed.push({ file: directory, error: errorMessage(error) })
			return { fingerprint: "", tools: [], loaded, failed }
		}
	}

	/**
	 * Register a tool directly (without loading from file).
	 */
	register(definition: CustomToolDefinition, source?: string): void {
		const { name: id } = definition
		const validated = this.validate(id, definition)

		if (!validated) {
			throw new Error(`Invalid tool definition for '${id}'`)
		}

		const storedTool: StoredCustomTool = Object.freeze(source ? { ...validated, source } : { ...validated })
		this.registeredTools.set(id, storedTool)
		this.tools.set(id, storedTool)
	}

	/**
	 * Unregister a tool by ID.
	 */
	unregister(id: string): boolean {
		this.registeredTools.delete(id)
		for (const [key, snapshot] of this.directorySnapshots) {
			if (snapshot.tools.some((tool) => tool.name === id)) {
				this.directorySnapshots.set(key, {
					...snapshot,
					tools: Object.freeze(snapshot.tools.filter((tool) => tool.name !== id)),
					loaded: snapshot.loaded.filter((name) => name !== id),
				})
			}
		}
		return this.tools.delete(id)
	}

	/**
	 * Get a tool by ID.
	 */
	get(id: string): CustomToolDefinition | undefined {
		return this.tools.get(id)
	}

	/**
	 * Check if a tool exists.
	 */
	has(id: string): boolean {
		return this.tools.has(id)
	}

	/**
	 * Get all registered tool IDs.
	 */
	list(): string[] {
		return Array.from(this.tools.keys())
	}

	/**
	 * Get all registered tools.
	 */
	getAll(): CustomToolDefinition[] {
		return Array.from(this.tools.values())
	}

	/**
	 * Get all registered tools in the serialized format.
	 */
	getAllSerialized(): SerializedCustomToolDefinition[] {
		return this.getAll().map(serializeCustomTool)
	}

	/**
	 * Get the number of registered tools.
	 */
	get size(): number {
		return this.tools.size
	}

	/**
	 * Clear all registered tools.
	 */
	clear(): void {
		this.clearVersion++
		this.tools.clear()
		this.registeredTools.clear()
		this.directorySnapshots.clear()
	}

	/**
	 * Set the extension path for finding bundled esbuild binary.
	 * This should be called with context.extensionPath when the extension activates.
	 */
	setExtensionPath(extensionPath: string): void {
		this.extensionPath = extensionPath
	}

	/**
	 * Get the current extension path.
	 */
	getExtensionPath(): string | undefined {
		return this.extensionPath
	}

	/**
	 * Clear the TypeScript lookup cache and unused disk entries.
	 * Imported generations retain their resources until host exit so captured tools remain executable.
	 */
	clearCache(): void {
		this.tsCache.clear()

		if (fs.existsSync(this.cacheDir)) {
			try {
				const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true })
				for (const entry of entries) {
					const entryPath = path.join(this.cacheDir, entry.name)
					if (
						entry.isDirectory() &&
						!retainedCacheDirectories.has(entryPath) &&
						!pendingCacheGenerations.has(entryPath) &&
						!activeCacheDirectories.has(entryPath)
					) {
						fs.rmSync(entryPath, { recursive: true, force: true })
					} else if (entry.name.endsWith(".mjs")) {
						// Also clean up any legacy flat .mjs files from older cache format.
						fs.unlinkSync(entryPath)
					}
				}
			} catch (error) {
				console.error(
					`[CustomToolRegistry] clearCache failed to clean disk cache: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	/**
	 * Dynamically import a TypeScript or JavaScript file.
	 * TypeScript files are transpiled on-the-fly using esbuild.
	 *
	 * For TypeScript files, esbuild bundles the code with these considerations:
	 * - Node.js built-in modules (fs, path, etc.) are kept external
	 * - npm packages are bundled with a CommonJS shim for require() compatibility
	 * - The tool's local node_modules is included in the resolution path
	 */
	private async import(
		filePath: string,
		sourceFingerprint: string,
		force: boolean,
	): Promise<Record<string, unknown>> {
		const absolutePath = path.resolve(filePath)
		const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
		// A stable compiled slot must not be overwritten while another registry imports it.
		while (pendingModuleLoads.has(key)) {
			try {
				await pendingModuleLoads.get(key)
			} catch {
				// Each caller receives its own source load result after the previous attempt settles.
			}
		}
		if (pendingModuleLoads.size >= MAX_CACHED_DIRECTORIES) {
			throw new Error("Too many concurrent custom tool module loads. Retry after the current loads finish.")
		}
		const loading = this.importSource(absolutePath, sourceFingerprint, force)
		pendingModuleLoads.set(key, loading)
		try {
			return await loading
		} finally {
			pendingModuleLoads.delete(key)
		}
	}

	private async importSource(
		absolutePath: string,
		sourceFingerprint: string,
		force: boolean,
	): Promise<Record<string, unknown>> {
		const assertSourceCurrent = async () => {
			if (fingerprint(await fs.promises.readFile(absolutePath)) !== sourceFingerprint) {
				throw new Error("Custom tool source changed while loading. Refresh custom tools to retry.")
			}
		}
		await assertSourceCurrent()
		if (path.extname(absolutePath) === ".js") {
			const url = pathToFileURL(absolutePath)
			url.searchParams.set("alpha_tool", sourceFingerprint)
			const nativeRequire = createRequire(absolutePath)
			// Native import of CommonJS also consults require.cache, independently of the versioned ESM URL.
			delete nativeRequire.cache[absolutePath]
			try {
				const mod = await this.importModule(url.href)
				await assertSourceCurrent()
				return mod
			} finally {
				delete nativeRequire.cache[absolutePath]
			}
		}

		const cached = this.tsCache.get(absolutePath)
		if (!force && cached?.fingerprint === sourceFingerprint) return this.importModule(cached.url)

		await this.ensureCacheDirectory()
		const stagingDirectory = path.join(this.cacheDir, `stage-${fingerprint(absolutePath).slice(0, 32)}`)
		while (pendingCacheRemovals.has(stagingDirectory)) await pendingCacheRemovals.get(stagingDirectory)
		activeCacheDirectories.add(stagingDirectory)
		try {
			await fs.promises.mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
			// Prune before compilation so invalid sources cannot accumulate unbounded failed-build slots.
			await this.pruneDiskCache(stagingDirectory)
			this.tsCache.delete(absolutePath)
			const toolDir = path.dirname(absolutePath)
			const tempFile = path.join(stagingDirectory, "bundle.mjs")
			await runEsbuild(
				{
					entryPoint: absolutePath,
					outfile: tempFile,
					format: "esm",
					platform: "node",
					target: "node18",
					bundle: true,
					sourcemap: "inline",
					packages: "bundle",
					nodePaths: [path.join(toolDir, "node_modules"), ...this.nodePaths],
					external: NODE_BUILTIN_MODULES,
					banner: COMMONJS_REQUIRE_BANNER,
				},
				this.extensionPath,
			)
			const bundle = await fs.promises.readFile(tempFile)
			const envFiles = await this.readEnvFiles(toolDir)
			const generation = fingerprint(
				JSON.stringify({
					source: absolutePath,
					bundle: fingerprint(bundle),
					env: envFiles.map(({ name, contents }) => [name, fingerprint(contents)]),
				}),
			)
			const toolCacheDir = path.join(this.cacheDir, `tool-${generation.slice(0, 32)}`)
			const url = pathToFileURL(path.join(toolCacheDir, "bundle.mjs")).href
			this.assertImportCapacity(url)
			while (pendingCacheRemovals.has(toolCacheDir)) await pendingCacheRemovals.get(toolCacheDir)
			const retained = retainedCacheDirectories.has(toolCacheDir)
			if (!retained && retainedCacheDirectories.size + pendingCacheGenerations.size >= MAX_COMPILED_SOURCES) {
				throw new Error(
					"Custom tool compiled generation limit reached. Reload the extension host before loading new tool versions.",
				)
			}
			// Reserve capacity/protect writes without marking partial output as an imported generation.
			if (!retained) pendingCacheGenerations.add(toolCacheDir)
			try {
				const exists =
					retained &&
					(await fs.promises.stat(toolCacheDir).then(
						() => true,
						(error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return false
							throw error
						},
					))
				if (!exists) {
					await fs.promises.mkdir(toolCacheDir, { recursive: true, mode: 0o700 })
					await fs.promises.writeFile(path.join(toolCacheDir, "bundle.mjs"), bundle, { mode: 0o600 })
					for (const { name, contents } of envFiles)
						await fs.promises.writeFile(path.join(toolCacheDir, name), contents, { mode: 0o600 })
				}
				await assertSourceCurrent()
				await this.pruneDiskCache(stagingDirectory)
				// From import onward Node may retain executable state even if module evaluation fails.
				retainedCacheDirectories.add(toolCacheDir)
				pendingCacheGenerations.delete(toolCacheDir)
				const mod = await this.importModule(url)
				await assertSourceCurrent()
				this.tsCache.delete(absolutePath)
				this.tsCache.set(absolutePath, { fingerprint: sourceFingerprint, url })
				while (this.tsCache.size > MAX_COMPILED_SOURCES) this.tsCache.delete(this.tsCache.keys().next().value!)
				return mod
			} finally {
				try {
					if (!retainedCacheDirectories.has(toolCacheDir)) {
						await fs.promises.rm(toolCacheDir, { recursive: true, force: true })
					}
				} finally {
					pendingCacheGenerations.delete(toolCacheDir)
				}
			}
		} finally {
			try {
				await fs.promises.rm(stagingDirectory, { recursive: true, force: true })
			} finally {
				activeCacheDirectories.delete(stagingDirectory)
			}
		}
	}

	private assertImportCapacity(url: string): void {
		if (!importedModuleUrls.has(url) && importedModuleUrls.size >= MAX_IMPORT_GENERATIONS) {
			throw new Error(
				"Custom tool module reload limit reached. Reload the extension host before loading new tool versions.",
			)
		}
	}

	private async importModule(url: string): Promise<Record<string, unknown>> {
		this.assertImportCapacity(url)
		importedModuleUrls.add(url)
		return import(url)
	}

	private async ensureCacheDirectory(): Promise<void> {
		this.cacheReady ??= this.initializeCacheDirectory()
		try {
			await this.cacheReady
		} catch (error) {
			this.cacheReady = undefined
			throw error
		}
	}

	private async initializeCacheDirectory(): Promise<void> {
		await fs.promises.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
		for (const entry of await fs.promises.readdir(this.cacheRoot, { withFileTypes: true })) {
			const match = /^host-([1-9][0-9]*)-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.exec(entry.name)
			if (!entry.isDirectory() || !match || entry.name === PROCESS_CACHE_NAMESPACE) continue
			try {
				process.kill(Number(match[1]), 0)
			} catch (error) {
				// An inaccessible/reused PID is not evidence that another window's resources are unused.
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					await fs.promises.rm(path.join(this.cacheRoot, entry.name), { recursive: true, force: true })
				}
			}
		}
	}

	private async pruneDiskCache(currentDirectory: string): Promise<void> {
		while (pendingCachePrunes.has(this.cacheDir)) await pendingCachePrunes.get(this.cacheDir)
		const pruning = this.pruneDiskCacheEntries(currentDirectory)
		pendingCachePrunes.set(this.cacheDir, pruning)
		try {
			await pruning
		} finally {
			pendingCachePrunes.delete(this.cacheDir)
		}
	}

	private async pruneDiskCacheEntries(currentDirectory: string): Promise<void> {
		const directoryEntries = await fs.promises.readdir(this.cacheDir, { withFileTypes: true })
		for (const entry of directoryEntries) {
			if (entry.isDirectory() && /^stage-[a-f0-9]{32}$/.test(entry.name)) {
				await this.removeUnusedCacheDirectory(path.join(this.cacheDir, entry.name))
			}
		}
		const entries = directoryEntries
			.filter((entry) => entry.isDirectory() && /^(?:tool-[a-f0-9]{32}|[a-f0-9]{16})$/.test(entry.name))
			.map((entry) => path.join(this.cacheDir, entry.name))
		if (entries.length <= MAX_COMPILED_SOURCES) return
		const candidates: Array<{ directory: string; modified: number }> = []
		for (const directory of entries) {
			if (
				directory !== currentDirectory &&
				!activeCacheDirectories.has(directory) &&
				!pendingCacheGenerations.has(directory) &&
				!retainedCacheDirectories.has(directory)
			) {
				candidates.push({ directory, modified: (await fs.promises.stat(directory)).mtimeMs })
			}
		}
		candidates.sort((a, b) => a.modified - b.modified)
		let remaining = entries.length - MAX_COMPILED_SOURCES
		for (const { directory } of candidates) {
			if (remaining <= 0) break
			if (await this.removeUnusedCacheDirectory(directory)) remaining--
		}
	}

	private async removeUnusedCacheDirectory(directory: string): Promise<boolean> {
		if (
			activeCacheDirectories.has(directory) ||
			pendingCacheGenerations.has(directory) ||
			retainedCacheDirectories.has(directory)
		)
			return false
		const removal = fs.promises.rm(directory, { recursive: true, force: true })
		pendingCacheRemovals.set(directory, removal)
		try {
			await removal
			return true
		} finally {
			pendingCacheRemovals.delete(directory)
		}
	}

	/**
	 * Capture exactly the env files belonging to this generation, including deletions between refreshes.
	 */
	private async readEnvFiles(toolDir: string): Promise<Array<{ name: string; contents: Buffer }>> {
		const names = (await fs.promises.readdir(toolDir))
			.filter((name) => name === ".env" || name.startsWith(".env."))
			.sort()
		const files: Array<{ name: string; contents: Buffer }> = []
		for (const name of names) {
			const file = path.join(toolDir, name)
			if ((await fs.promises.stat(file)).isFile())
				files.push({ name, contents: await fs.promises.readFile(file) })
		}
		return files
	}

	/**
	 * Check if a value is a Zod schema by looking for the _def property
	 * which is present on all Zod types.
	 */
	private isParametersSchema(value: unknown): value is CustomToolParametersSchema {
		return (
			value !== null &&
			typeof value === "object" &&
			"_def" in value &&
			typeof (value as Record<string, unknown>)._def === "object"
		)
	}

	/**
	 * Validate a tool definition and return a typed result.
	 * Returns null for non-tool exports, throws for invalid tools.
	 */
	private validate(exportName: string, value: unknown): CustomToolDefinition | null {
		// Quick pre-check to filter out non-objects.
		if (!value || typeof value !== "object") {
			return null
		}

		// Check if it looks like a tool (has execute function).
		if (!("execute" in value) || typeof (value as Record<string, unknown>).execute !== "function") {
			return null
		}

		const obj = value as Record<string, unknown>
		const errors: string[] = []

		// Validate name.
		if (typeof obj.name !== "string") {
			errors.push("name: Expected string")
		} else if (obj.name.length === 0) {
			errors.push("name: Tool must have a non-empty name")
		}

		// Validate description.
		if (typeof obj.description !== "string") {
			errors.push("description: Expected string")
		} else if (obj.description.length === 0) {
			errors.push("description: Tool must have a non-empty description")
		}

		// Validate parameters (optional).
		if (obj.parameters !== undefined && !this.isParametersSchema(obj.parameters)) {
			errors.push("parameters: parameters must be a Zod schema")
		}
		if (errors.length === 0 && obj.parameters !== undefined) {
			try {
				serializeCustomTool(value as CustomToolDefinition)
			} catch {
				// Reject at the owned source boundary so one bad schema cannot poison every task catalog.
				errors.push("parameters: input must be representable as JSON Schema")
			}
		}

		if (errors.length > 0) {
			const label = typeof exportName === "string" ? exportName.slice(0, 120) : "unnamed"
			throw new Error(`Invalid tool definition for '${label}': ${errors.join(", ")}`)
		}

		return value as CustomToolDefinition
	}
}

export const customToolRegistry = new CustomToolRegistry()
