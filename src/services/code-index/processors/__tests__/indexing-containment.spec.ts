import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import ignore from "ignore"
import * as vscode from "vscode"
import { AlphaIgnoreController } from "../../../../core/ignore/AlphaIgnoreController"
import { listFiles } from "../../../glob/list-files"
import type { CacheManager } from "../../cache-manager"
import type { IEmbedder, IVectorStore } from "../../interfaces"
import { FileWatcher } from "../file-watcher"
import { codeParser } from "../parser"
import { DirectoryScanner } from "../scanner"

vi.mock("fs/promises", async () => vi.importActual("fs/promises"))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))
vi.mock("../../../glob/list-files", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../glob/list-files")>()),
	listFiles: vi.fn(),
}))
vi.mock("../parser", () => ({ codeParser: { parseFile: vi.fn() } }))
vi.mock("../../../../utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../utils/path")>()),
	getWorkspacePathForContext: (directory: string) => directory,
}))
vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: class {},
	EventEmitter: class {
		event = () => ({ dispose() {} })
		fire() {}
		dispose() {}
	},
	workspace: {
		getWorkspaceFolder: vi.fn(),
		createFileSystemWatcher: () => ({
			onDidCreate: () => ({ dispose() {} }),
			onDidChange: () => ({ dispose() {} }),
			onDidDelete: () => ({ dispose() {} }),
			dispose() {},
		}),
		fs: {
			readFile: vi.fn((uri: vscode.Uri) => fs.readFile(uri.fsPath)),
			stat: vi.fn(async (uri: vscode.Uri) => {
				const stats = await fs.stat(uri.fsPath)
				return { type: 1, ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size }
			}),
		},
	},
}))

describe.each(["initial scan", "incremental update"] as const)("%s workspace containment", (surface) => {
	let fixture: string
	let workspace: string
	const content = "export const indexedValue = 123"

	beforeEach(async () => {
		vi.clearAllMocks()
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-index-containment-"))
		workspace = path.join(fixture, "workspace")
		await fs.mkdir(workspace)
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: vscode.Uri.file(workspace),
			name: "fixture",
			index: 0,
		})
		vi.mocked(codeParser.parseFile).mockImplementation(async (filePath, options) => [
			{
				file_path: filePath,
				content: options?.content ?? "",
				start_line: 1,
				end_line: 1,
				startOffset: 0,
				endOffset: content.length,
				type: "code",
				identifier: "indexedValue",
				fileHash: options?.fileHash ?? "",
				segmentHash: createHash("sha256")
					.update(options?.content ?? "")
					.digest("hex"),
			},
		])
	})

	afterEach(async () => {
		expect(path.dirname(path.resolve(fixture))).toBe(path.resolve(os.tmpdir()))
		await fs.rm(fixture, { recursive: true, force: true })
	})

	async function indexFile(filePath: string, ignoredPaths: string[] = [], betweenRuns?: () => Promise<void>) {
		const embedder: IEmbedder = {
			embedderInfo: { name: "vertex" },
			validateConfiguration: vi.fn(async () => ({ valid: true })),
			createEmbeddings: vi.fn(async (texts) => ({ embeddings: texts.map(() => [1, 0]) })),
		}
		const store = {
			getPointsByFilePath: vi.fn(async () => []),
			replaceFilePoints: vi.fn(async () => {}),
			deletePointsByFilePath: vi.fn(async () => {}),
		} as unknown as IVectorStore
		const cache = {
			getHash: vi.fn(),
			getAllHashes: () => ({}),
			updateHash: vi.fn(),
			deleteHash: vi.fn(),
		} as unknown as CacheManager
		const ignoreInstance = ignore().add(ignoredPaths)
		const errors: Error[] = []
		let skipped: boolean
		if (surface === "initial scan") {
			vi.mocked(listFiles).mockResolvedValue([[filePath], false])
			const scanner = new DirectoryScanner(embedder, store, codeParser, cache, ignoreInstance, 60, 0)
			let result = await scanner.scanDirectory(workspace, (error) => errors.push(error))
			if (betweenRuns) {
				await betweenRuns()
				result = await scanner.scanDirectory(workspace, (error) => errors.push(error))
			}
			skipped = result.stats.skipped > 0
		} else {
			const ignoreController = new AlphaIgnoreController(workspace)
			await ignoreController.initialize()
			const watcher = new FileWatcher(
				workspace,
				{} as vscode.ExtensionContext,
				cache,
				embedder,
				store,
				ignoreInstance,
				ignoreController,
				60,
				0,
			)
			try {
				let result = await watcher.processFile(filePath)
				if (betweenRuns) {
					await betweenRuns()
					result = await watcher.processFile(filePath)
				}
				if (result.error) errors.push(result.error)
				skipped = result.status === "skipped"
			} finally {
				watcher.dispose()
				ignoreController.dispose()
			}
		}
		return { embedder, cache, skipped, errors }
	}

	it("rejects an external junction before reading, parsing, or embedding source", async () => {
		const outside = path.join(fixture, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "file.ts"), content)
		await fs.symlink(outside, path.join(workspace, "link"), "junction")
		const { embedder, skipped } = await indexFile(path.join(workspace, "link", "file.ts"))

		expect(skipped).toBe(true)
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(codeParser.parseFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("preserves an internal junction and its discovered file identity", async () => {
		const target = path.join(workspace, "source")
		await fs.mkdir(target)
		await fs.writeFile(path.join(target, "file.ts"), content)
		await fs.symlink(target, path.join(workspace, "link"), "junction")
		const aliasPath = path.join(workspace, "link", "file.ts")
		const { embedder, cache, skipped } = await indexFile(aliasPath)

		expect(skipped).toBe(false)
		expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(vscode.Uri.file(await fs.realpath(aliasPath)))
		expect(codeParser.parseFile).toHaveBeenCalledWith(aliasPath, expect.objectContaining({ content }))
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
		if (surface === "initial scan") expect(cache.updateHash).toHaveBeenCalledWith(aliasPath, expect.any(String))
	})

	it("applies ignore rules to an internal junction's canonical target", async () => {
		const target = path.join(workspace, "private")
		await fs.mkdir(target)
		await fs.writeFile(path.join(target, "file.ts"), content)
		await fs.symlink(target, path.join(workspace, "link"), "junction")
		await fs.writeFile(path.join(workspace, ".gitignore"), "private/\n")
		const { embedder, skipped } = await indexFile(path.join(workspace, "link", "file.ts"), ["private/"])

		expect(skipped).toBe(true)
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(codeParser.parseFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it("rejects a file excluded by its nested .gitignore before reading source", async () => {
		const target = path.join(workspace, "src")
		await fs.mkdir(target)
		await fs.writeFile(path.join(target, "file.ts"), content)
		await fs.writeFile(path.join(target, ".gitignore"), "/file.ts\n")
		const { embedder, skipped } = await indexFile(path.join(target, "file.ts"))

		expect(skipped).toBe(true)
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(codeParser.parseFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})

	it.each(["root", "nested"])("applies changed %s ignore rules to the same live indexer", async (location) => {
		const target = path.join(workspace, "src")
		await fs.mkdir(target)
		const filePath = path.join(target, "file.ts")
		await fs.writeFile(filePath, content)
		const { embedder, skipped } = await indexFile(filePath, [], async () => {
			expect(codeParser.parseFile).toHaveBeenCalledOnce()
			vi.mocked(vscode.workspace.fs.readFile).mockClear()
			vi.mocked(codeParser.parseFile).mockClear()
			await fs.writeFile(path.join(location === "root" ? workspace : target, ".gitignore"), "file.ts\n")
		})

		expect(skipped).toBe(true)
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(codeParser.parseFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it("lets nested negation override a stale root ignore snapshot", async () => {
		const target = path.join(workspace, "src")
		await fs.mkdir(target)
		const filePath = path.join(target, "file.ts")
		await fs.writeFile(filePath, content)
		await fs.writeFile(path.join(workspace, ".gitignore"), "*.ts\n")
		await fs.writeFile(path.join(target, ".gitignore"), "!file.ts\n")
		const { embedder, skipped } = await indexFile(filePath, ["*.ts"])

		expect(skipped).toBe(false)
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it.each(["root", "nested"])("applies removed %s ignore rules to the same live indexer", async (location) => {
		const target = path.join(workspace, "src")
		await fs.mkdir(target)
		const filePath = path.join(target, "file.ts")
		const ignorePath = path.join(location === "root" ? workspace : target, ".gitignore")
		await fs.writeFile(filePath, content)
		await fs.writeFile(ignorePath, "file.ts\n")
		const { embedder, skipped } = await indexFile(filePath, location === "root" ? ["file.ts"] : [], async () => {
			expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
			expect(codeParser.parseFile).not.toHaveBeenCalled()
			await fs.unlink(ignorePath)
		})

		expect(skipped).toBe(false)
		expect(codeParser.parseFile).toHaveBeenCalledOnce()
		expect(embedder.createEmbeddings).toHaveBeenCalledOnce()
	})

	it("fails closed before reading source when current ignore rules exceed their budget", async () => {
		const filePath = path.join(workspace, "file.ts")
		await fs.writeFile(filePath, content)
		await fs.writeFile(path.join(workspace, ".gitignore"), "#".repeat(65_537))
		const { embedder, errors } = await indexFile(filePath)

		expect(errors).toHaveLength(1)
		expect(errors[0]?.message).toContain("64 KiB ignore-file budget")
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(codeParser.parseFile).not.toHaveBeenCalled()
		expect(embedder.createEmbeddings).not.toHaveBeenCalled()
	})
})
