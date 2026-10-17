import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	clearRipgrepPathCache,
	createRipgrepProcessError,
	executeWithRipgrepFallback,
	resolveRipgrepBinary,
} from "../index"

describe("Ripgrep binary resolution", () => {
	let tempDir: string
	let logger: { info: import("vitest").Mock; warn: import("vitest").Mock }

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

	it("invalidates an executable after ENOENT and resolves the next bundled candidate", async () => {
		const firstPackageRoot = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep")
		const firstBinary = path.join(firstPackageRoot, "bin", process.platform === "win32" ? "rg.exe" : "rg")
		const fallbackPackageRoot = path.join(tempDir, "fallback", "node_modules", "@vscode", "ripgrep")
		const fallbackBinary = path.join(fallbackPackageRoot, "bin", process.platform === "win32" ? "rg.exe" : "rg")
		await writeExecutable(firstBinary)
		await writeExecutable(fallbackBinary)

		const options = {
			bundledPackageRoots: [
				{ packageName: "@vscode/ripgrep", packageRoot: firstPackageRoot },
				{ packageName: "@vscode/ripgrep", packageRoot: fallbackPackageRoot },
			],
			env: {},
			logger,
			platform: process.platform,
			skipRuntimePackageLookup: true,
		}
		expect(await resolveRipgrepBinary(options)).toMatchObject({ path: firstBinary, source: "bundled" })

		const spawnError = Object.assign(new Error(`spawn ${firstBinary} ENOENT`), {
			code: "ENOENT",
			path: firstBinary,
			syscall: `spawn ${firstBinary}`,
		})
		const execute = vi.fn(async (binaryPath: string) => {
			if (binaryPath === firstBinary) throw createRipgrepProcessError(spawnError)
			return binaryPath
		})
		const resolveFallback = () => resolveRipgrepBinary(options).then((resolution) => resolution?.path)

		await expect(executeWithRipgrepFallback(firstBinary, execute, resolveFallback)).resolves.toBe(fallbackBinary)
		expect(await resolveRipgrepBinary(options)).toMatchObject({ path: fallbackBinary, source: "bundled" })
	})

	it("retries once from the remaining binary sources after spawn returns ENOENT", async () => {
		const bundledRg = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe")
		const fallbackRg = path.join(
			tempDir,
			"vscode",
			"node_modules.asar.unpacked",
			"@vscode",
			"ripgrep",
			"bin",
			"rg.exe",
		)
		const spawnError = Object.assign(new Error(`spawn ${bundledRg} ENOENT`), {
			code: "ENOENT",
			path: bundledRg,
			syscall: `spawn ${bundledRg}`,
		})
		const execute = vi.fn(async (binaryPath: string) => {
			if (binaryPath === bundledRg) throw createRipgrepProcessError(spawnError)
			return binaryPath
		})
		const resolveFallback = vi.fn(async () => fallbackRg)

		await expect(executeWithRipgrepFallback(bundledRg, execute, resolveFallback)).resolves.toBe(fallbackRg)
		expect(execute).toHaveBeenNthCalledWith(1, bundledRg)
		expect(execute).toHaveBeenNthCalledWith(2, fallbackRg)
		expect(resolveFallback).toHaveBeenCalledOnce()
	})

	it("does not retry a missing binary after cancellation", async () => {
		const bundledRg = path.join(tempDir, "extension", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe")
		const controller = new AbortController()
		const cancelReason = new Error("cancelled")
		const spawnError = Object.assign(new Error(`spawn ${bundledRg} ENOENT`), {
			code: "ENOENT",
			path: bundledRg,
			syscall: `spawn ${bundledRg}`,
		})
		const execute = vi.fn(async () => {
			controller.abort(cancelReason)
			throw createRipgrepProcessError(spawnError)
		})
		const resolveFallback = vi.fn(async () => path.join(tempDir, "fallback", "rg.exe"))

		await expect(executeWithRipgrepFallback(bundledRg, execute, resolveFallback, controller.signal)).rejects.toBe(
			cancelReason,
		)
		expect(resolveFallback).not.toHaveBeenCalled()
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
