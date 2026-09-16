// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import { clearRipgrepPathCache, regexSearchFiles, resolveRipgrepBinary, truncateLine } from "../index"

vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: vi.fn().mockImplementation((base, pattern) => ({ base, pattern })),
}))

describe("Ripgrep line truncation", () => {
	// The default MAX_LINE_LENGTH is 500 in the implementation
	const MAX_LINE_LENGTH = 500

	it("should truncate lines longer than MAX_LINE_LENGTH", () => {
		const longLine = "a".repeat(600) // Line longer than MAX_LINE_LENGTH
		const truncated = truncateLine(longLine)

		expect(truncated).toContain("[truncated...]")
		expect(truncated.length).toBeLessThan(longLine.length)
		expect(truncated.length).toEqual(MAX_LINE_LENGTH + " [truncated...]".length)
	})

	it("should not truncate lines shorter than MAX_LINE_LENGTH", () => {
		const shortLine = "Short line of text"
		const truncated = truncateLine(shortLine)

		expect(truncated).toEqual(shortLine)
		expect(truncated).not.toContain("[truncated...]")
	})

	it("should correctly truncate a line at exactly MAX_LINE_LENGTH characters", () => {
		const exactLine = "a".repeat(MAX_LINE_LENGTH)
		const exactPlusOne = exactLine + "x"

		// Should not truncate when exactly MAX_LINE_LENGTH
		expect(truncateLine(exactLine)).toEqual(exactLine)

		// Should truncate when exceeding MAX_LINE_LENGTH by even 1 character
		expect(truncateLine(exactPlusOne)).toContain("[truncated...]")
	})

	it("should handle empty lines without errors", () => {
		expect(truncateLine("")).toEqual("")
	})

	it("should allow custom maximum length", () => {
		const customLength = 100
		const line = "a".repeat(customLength + 50)

		const truncated = truncateLine(line, customLength)

		expect(truncated.length).toEqual(customLength + " [truncated...]".length)
		expect(truncated).toContain("[truncated...]")
	})
})

describe("Ripgrep binary resolution", () => {
	let tempDir: string
	let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }

	beforeEach(async () => {
		clearRipgrepPathCache()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-rg-"))
		logger = { info: vi.fn(), warn: vi.fn() }
	})

	afterEach(async () => {
		clearRipgrepPathCache()
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function writeExecutable(filePath: string) {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, "")
		await fs.chmod(filePath, 0o755)
	}

	it("prefers extension-bundled @vscode/ripgrep over PATH and VS Code internals", async () => {
		const packageRoot = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep")
		const bundledRg = path.join(packageRoot, "bin", "rg")
		const pathRg = path.join(tempDir, "path-bin", "rg")
		const internalRg = path.join(tempDir, "app-root", "node_modules", "@vscode", "ripgrep", "bin", "rg")
		await writeExecutable(bundledRg)
		await writeExecutable(pathRg)
		await writeExecutable(internalRg)

		const resolution = await resolveRipgrepBinary({
			appRoot: path.join(tempDir, "app-root"),
			bundledPackageRoots: [{ packageName: "@vscode/ripgrep", packageRoot }],
			env: { PATH: path.dirname(pathRg) },
			logger,
			platform: "linux",
			skipRuntimePackageLookup: true,
		})

		expect(resolution).toEqual({
			path: bundledRg,
			source: "bundled",
			reason: "using extension-bundled @vscode/ripgrep",
		})
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("using extension-bundled @vscode/ripgrep"))
	})

	it("supports extension-bundled @vscode/ripgrep-universal layouts", async () => {
		const packageRoot = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep-universal")
		const universalRg = path.join(packageRoot, "platform", "linux-x64", "rg")
		await writeExecutable(universalRg)

		const resolution = await resolveRipgrepBinary({
			bundledPackageRoots: [{ packageName: "@vscode/ripgrep-universal", packageRoot }],
			env: {},
			logger,
			platform: "linux",
			skipRuntimePackageLookup: true,
		})

		expect(resolution?.path).toBe(universalRg)
		expect(resolution?.source).toBe("bundled")
		expect(resolution?.reason).toBe("using extension-bundled @vscode/ripgrep-universal")
	})

	it("falls back to rg on PATH when no bundled dependency is available", async () => {
		const pathRg = path.join(tempDir, "path-bin", "rg")
		await writeExecutable(pathRg)

		const resolution = await resolveRipgrepBinary({
			env: { PATH: path.dirname(pathRg) },
			logger,
			platform: "linux",
			skipRuntimePackageLookup: true,
		})

		expect(resolution).toEqual({
			path: pathRg,
			source: "system",
			reason: "extension-bundled ripgrep was unavailable; using rg from PATH",
		})
		expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("using rg from PATH"))
	})

	it("uses VS Code internal ripgrep paths only as a last-resort compatibility fallback", async () => {
		const appRoot = path.join(tempDir, "app-root")
		const internalRg = path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", "rg")
		await writeExecutable(internalRg)

		const resolution = await resolveRipgrepBinary({
			appRoot,
			env: {},
			logger,
			platform: "linux",
			skipRuntimePackageLookup: true,
		})

		expect(resolution).toEqual({
			path: internalRg,
			source: "vscode-internal",
			reason: "bundled and system ripgrep were unavailable; using VS Code internal compatibility fallback",
		})
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("VS Code internal compatibility fallback"))
	})

	it("resolves the Windows rg.exe executable name", async () => {
		const packageRoot = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep")
		const bundledRg = path.join(packageRoot, "bin", "rg.exe")
		await writeExecutable(bundledRg)

		const resolution = await resolveRipgrepBinary({
			bundledPackageRoots: [{ packageName: "@vscode/ripgrep", packageRoot }],
			env: {},
			logger,
			platform: "win32",
			skipRuntimePackageLookup: true,
		})

		expect(resolution?.path).toBe(bundledRg)
	})

	it.each(
		["node_modules", "node_modules.asar.unpacked"].flatMap((moduleDirectory) =>
			(
				[
					["win32", "x64"],
					["win32", "arm64"],
					["darwin", "arm64"],
					["linux", "x64"],
					["linux", "arm64"],
				] as const
			).map(([platform, arch]) => ({ moduleDirectory, platform, arch })),
		),
	)(
		"resolves host target layout $moduleDirectory/$platform-$arch without PATH",
		async ({ moduleDirectory, platform, arch }) => {
			const appRoot = path.join(tempDir, "VS Code host", "resources", "app")
			const executable = platform === "win32" ? "rg.exe" : "rg"
			const internalRg = path.join(
				appRoot,
				moduleDirectory,
				"@vscode",
				"ripgrep-universal",
				"bin",
				`${platform}-${arch}`,
				executable,
			)
			await writeExecutable(internalRg)
			const resolution = await resolveRipgrepBinary({
				appRoot,
				platform,
				arch,
				env: {},
				logger,
				skipRuntimePackageLookup: true,
			})
			expect(resolution?.path).toBe(internalRg)
			expect(resolution?.source).toBe("vscode-internal")
		},
	)

	it("never selects another architecture's internal platform package", async () => {
		const appRoot = path.join(tempDir, "app-root")
		await writeExecutable(path.join(appRoot, "node_modules", "@vscode", "ripgrep-win32-x64", "bin", "rg.exe"))
		await writeExecutable(
			path.join(appRoot, "node_modules", "@vscode", "ripgrep-universal", "bin", "win32-x64", "rg.exe"),
		)
		const resolution = await resolveRipgrepBinary({
			appRoot,
			platform: "win32",
			arch: "arm64",
			env: {},
			logger,
			skipRuntimePackageLookup: true,
		})
		expect(resolution).toBeUndefined()
	})

	it("supports @vscode/ripgrep platform package layouts", async () => {
		const packageRoot = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep-win32-x64")
		const bundledRg = path.join(packageRoot, "bin", "rg.exe")
		await writeExecutable(bundledRg)

		const resolution = await resolveRipgrepBinary({
			bundledPackageRoots: [{ packageName: "@vscode/ripgrep-win32-x64", packageRoot }],
			env: {},
			logger,
			platform: "win32",
			skipRuntimePackageLookup: true,
		})

		expect(resolution).toEqual({
			path: bundledRg,
			source: "bundled",
			reason: "using extension-bundled @vscode/ripgrep-win32-x64",
		})
	})

	it("warns when no ripgrep binary can be found", async () => {
		const resolution = await resolveRipgrepBinary({
			env: {},
			logger,
			platform: "linux",
			skipRuntimePackageLookup: true,
		})

		expect(resolution).toBeUndefined()
		expect(logger.warn).toHaveBeenCalledWith(
			"[ripgrep] No ripgrep binary found in bundled dependencies, PATH, or VS Code internal fallbacks",
		)
	})
})

describe("Ripgrep content search", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-rg-search-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
		clearRipgrepPathCache()
	})

	it("propagates ripgrep errors instead of reporting a false empty search", async () => {
		await expect(regexSearchFiles(tempDir, tempDir, "[")).rejects.toThrow(/ripgrep process error/)
	})

	it("preserves the failing path diagnostic so a missing search target can be corrected", async () => {
		const missing = path.join(tempDir, "missing-search-target")
		await expect(regexSearchFiles(tempDir, missing, "value")).rejects.toThrow("missing-search-target")
		await fs.writeFile(path.join(tempDir, "source.ts"), "const value = 1\n")
		await expect(regexSearchFiles(tempDir, tempDir, "value")).resolves.toContain("const value = 1")
	})

	it.each(["files", "count"] as const)("returns compact %s output without snippets", async (outputMode) => {
		await fs.writeFile(path.join(tempDir, "first.txt"), "context before\nTODO TODO\ncontext after\nTODO\n")
		await fs.writeFile(path.join(tempDir, "second.txt"), "TODO\n")
		const output = await regexSearchFiles(tempDir, tempDir, "TODO", undefined, undefined, undefined, { outputMode })
		expect(output.split("\n").sort()).toEqual(
			outputMode === "files" ? ["first.txt", "second.txt"] : ["first.txt: 3", "second.txt: 1"],
		)
		expect(output).not.toMatch(/TODO|context|\|/)
	})

	it("searches literal metacharacters without a regex compilation error", async () => {
		await fs.writeFile(path.join(tempDir, "literal.txt"), "foo(.bar\n")
		await fs.writeFile(path.join(tempDir, "other.txt"), "fooxbar\n")
		await expect(
			regexSearchFiles(tempDir, tempDir, "foo(.bar", undefined, undefined, undefined, {
				outputMode: "files",
				literal: true,
			}),
		).resolves.toBe("literal.txt")
	})

	it.each([undefined, null, "content"] as const)("keeps default snippets for mode %s", async (outputMode) => {
		await fs.writeFile(path.join(tempDir, "source.txt"), "before\nTODO\nafter\n")
		await expect(
			regexSearchFiles(tempDir, tempDir, "TODO", undefined, undefined, undefined, { outputMode }),
		).resolves.toBe("Found 1 result.\n\n# source.txt\n  1 | before\n  2 | TODO\n  3 | after\n----")
	})

	it.each([false, null])("keeps multiline regex recovery for literal=%s in every mode", async (literal) => {
		await fs.writeFile(path.join(tempDir, "source.txt"), "before\nalpha\nbeta\nafter\n")
		for (const outputMode of ["content", "files", "count"] as const) {
			const output = await regexSearchFiles(tempDir, tempDir, "alpha\\nbeta", undefined, undefined, undefined, {
				outputMode,
				literal,
			})
			expect(output).toBe(
				outputMode === "content"
					? "Found 1 result.\n\n# source.txt\n  1 | before\n  2 | alpha\n  3 | beta\n  4 | after\n----"
					: outputMode === "files"
						? "source.txt"
						: "source.txt: 1",
			)
		}
	})

	it("honors an already-aborted search signal before starting ripgrep", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled by test")
		controller.abort(reason)

		await expect(
			regexSearchFiles(tempDir, tempDir, "needle", undefined, undefined, controller.signal),
		).rejects.toBe(reason)
	})

	it("formats a match from a file named __proto__ without crashing", async () => {
		await fs.writeFile(path.join(tempDir, "__proto__"), "needle\n")

		const output = await regexSearchFiles(tempDir, tempDir, "needle")

		expect(output).toContain("# __proto__")
		expect(output).toContain("needle")
	})

	it.each(["alpha\\nbeta", "alpha\nbeta", "alpha\\x0Abeta", "alpha\\u{A}beta"])(
		"supports explicit newline pattern %j with numbered source lines and context",
		async (regex) => {
			await fs.writeFile(path.join(tempDir, "source.txt"), "before\nalpha\nbeta\nafter\n")

			await expect(regexSearchFiles(tempDir, tempDir, regex)).resolves.toBe(
				"Found 1 result.\n\n# source.txt\n  1 | before\n  2 | alpha\n  3 | beta\n  4 | after\n----",
			)
		},
	)

	it("preserves blank lines, CRLF line numbers, and a final line without a newline", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), "before\r\nalpha\r\n\r\nbeta\r\nafter")

		await expect(regexSearchFiles(tempDir, tempDir, "alpha\\r?\\n\\r?\\nbeta")).resolves.toBe(
			"Found 1 result.\n\n# source.txt\n  1 | before\n  2 | alpha\n  3 | \n  4 | beta\n  5 | after\n----",
		)
	})

	it("keeps ordinary whitespace patterns line-oriented", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), "alpha\nbeta\n")

		await expect(regexSearchFiles(tempDir, tempDir, "alpha\\s+beta")).resolves.toBe("Found 0 results.")
	})

	it("preserves literal backslash-n searches", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), "alpha\\nbeta\n")

		await expect(regexSearchFiles(tempDir, tempDir, String.raw`alpha\\nbeta`)).resolves.toContain(
			"  1 | alpha\\nbeta",
		)
	})

	it("preserves glob filtering when retrying a multiline search", async () => {
		await fs.writeFile(path.join(tempDir, "source.ts"), "alpha\nbeta\n")
		await fs.writeFile(path.join(tempDir, "excluded.txt"), "alpha\nbeta\n")

		const output = await regexSearchFiles(tempDir, tempDir, "alpha\\nbeta", "*.ts")

		expect(output).toContain("# source.ts")
		expect(output).not.toContain("excluded.txt")
	})

	it.each(["content", "files", "count"] as const)(
		"preserves .gitignore and .alphaignore during %s multiline recovery",
		async (outputMode) => {
			await fs.mkdir(path.join(tempDir, ".git"))
			await fs.writeFile(path.join(tempDir, ".gitignore"), "git-ignored.txt\n")
			await fs.writeFile(path.join(tempDir, ".alphaignore"), "alpha-ignored.txt\n")
			for (const fileName of ["source.txt", "git-ignored.txt", "alpha-ignored.txt"]) {
				await fs.writeFile(path.join(tempDir, fileName), "alpha\nbeta\n")
			}
			const ignoreController = new RooIgnoreController(tempDir)
			try {
				await ignoreController.initialize()
				const output = await regexSearchFiles(
					tempDir,
					tempDir,
					"alpha\\nbeta",
					undefined,
					ignoreController,
					undefined,
					{ outputMode },
				)

				expect(output).toContain(outputMode === "content" ? "# source.txt" : "source.txt")
				expect(output).not.toContain("git-ignored.txt")
				expect(output).not.toContain("alpha-ignored.txt")
			} finally {
				ignoreController.dispose()
			}
		},
	)

	it("truncates each source line independently within a multiline match", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), `alpha${"x".repeat(600)}\nbeta\n`)

		const output = await regexSearchFiles(tempDir, tempDir, "alpha[^\\n]*\\nbeta")

		expect(output).toContain(`  1 | alpha${"x".repeat(495)} [truncated...]\n  2 | beta`)
	})

	it("bounds source lines even when one JSON match spans thousands of lines", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), `alpha\n${"middle\n".repeat(10_000)}beta\n`)

		const output = await regexSearchFiles(tempDir, tempDir, "alpha\\n(?s:.*?)beta")

		expect(output).toContain("  1 | alpha")
		expect(output).toContain("Search output truncated")
		expect(output.split("\n").length).toBeLessThan(1_600)
		expect(output).not.toContain("Found 0 results")
	})

	it("enforces the result-group limit within a single file", async () => {
		const content = Array.from({ length: 350 }, (_, index) => `alpha${index}\nbeta\nx\nx\nx\n`).join("")
		await fs.writeFile(path.join(tempDir, "source.txt"), content)

		const output = await regexSearchFiles(tempDir, tempDir, "alpha\\d+\\nbeta")

		expect(output).toContain("Showing first 300")
		expect(output.match(/^----$/gm)).toHaveLength(300)
		expect(output).toContain("alpha299")
		expect(output).not.toContain("alpha300")
	})

	it("reports truncation instead of a false empty search when one JSON record exceeds the byte budget", async () => {
		await fs.writeFile(path.join(tempDir, "source.txt"), `alpha\n${"x".repeat(2_000_000)}beta\n`)

		const output = await regexSearchFiles(tempDir, tempDir, "alpha\\n.*beta")

		expect(output).toContain("Search output truncated")
		expect(output).not.toContain("Found 0 results")
		expect(output.length).toBeLessThan(1_000)
	})
})
