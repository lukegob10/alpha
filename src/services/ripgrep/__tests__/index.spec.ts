// npx vitest run src/services/ripgrep/__tests__/index.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { clearRipgrepPathCache, resolveRipgrepBinary, truncateLine } from "../index"

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
