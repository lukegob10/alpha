import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@alpha-code/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

const lancedbNativePackages = [
	"@lancedb/lancedb-win32-x64-msvc",
	"@lancedb/lancedb-linux-x64-gnu",
	"@lancedb/lancedb-linux-x64-musl",
]

const lancedbNativeBindingFiles = [
	"lancedb.win32-x64-msvc.node",
	"lancedb.linux-x64-gnu.node",
	"lancedb.linux-x64-musl.node",
]

const ripgrepPackages = [
	"@vscode/ripgrep",
	"@vscode/ripgrep-universal",
	"@vscode/ripgrep-darwin-x64",
	"@vscode/ripgrep-darwin-arm64",
	"@vscode/ripgrep-win32-x64",
	"@vscode/ripgrep-win32-arm64",
	"@vscode/ripgrep-win32-ia32",
	"@vscode/ripgrep-linux-x64",
	"@vscode/ripgrep-linux-arm64",
	"@vscode/ripgrep-linux-arm",
	"@vscode/ripgrep-linux-ppc64",
	"@vscode/ripgrep-linux-riscv64",
	"@vscode/ripgrep-linux-s390x",
	"@vscode/ripgrep-linux-ia32",
]

function findPackageRoot(resolvedPath, packageName) {
	let current = path.dirname(resolvedPath)
	const expectedPackageName = packageName.split("/").pop()

	while (current && current !== path.dirname(current)) {
		if (path.basename(current) === expectedPackageName && fs.existsSync(path.join(current, "package.json"))) {
			return current
		}
		current = path.dirname(current)
	}

	return path.dirname(resolvedPath)
}

function resolveRipgrepPackageDir(packageName) {
	const resolutionBases = [
		import.meta.url,
		path.join(__dirname, "..", "package.json"),
		path.join(__dirname, "..", "apps", "cli", "package.json"),
	]

	for (const resolutionBase of resolutionBases) {
		try {
			return findPackageRoot(createRequire(resolutionBase).resolve(packageName), packageName)
		} catch {
			// Continue looking from the next workspace package root.
		}

		try {
			const packageJsonPath = createRequire(resolutionBase).resolve(`${packageName}/package.json`)
			return path.dirname(packageJsonPath)
		} catch {
			// Platform packages expose package.json, while @vscode/ripgrep itself does not.
		}
	}

	return undefined
}

function copyBundledRipgrepDependencies(distDir) {
	for (const packageName of ripgrepPackages) {
		const packageDir = resolveRipgrepPackageDir(packageName)
		if (!packageDir) {
			continue
		}

		const targetDir = path.join(distDir, "node_modules", ...packageName.split("/"))

		fs.rmSync(targetDir, { recursive: true, force: true })
		fs.mkdirSync(path.dirname(targetDir), { recursive: true })
		fs.cpSync(packageDir, targetDir, { recursive: true })
		console.log(`[copyBundledRipgrepDependencies] Copied ${packageName} to ${targetDir}`)
	}
}

async function removeDirWithRetries(dirPath, retries = 5, retryDelayMs = 200) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fs.promises.rm(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isRetryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM"
			const isLastAttempt = attempt === retries

			if (!isRetryable || isLastAttempt) {
				throw error
			}

			await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * (attempt + 1)))
		}
	}
}

async function cleanDistDir(distDir) {
	try {
		await removeDirWithRetries(distDir)
		return
	} catch (error) {
		const lockedLanceDbBinding = path.join(distDir, "lancedb.win32-x64-msvc.node")

		if (process.platform !== "win32" || error?.code !== "EPERM" || !fs.existsSync(lockedLanceDbBinding)) {
			throw error
		}

		console.warn(`[extension] Reusing locked LanceDB native binding: ${lockedLanceDbBinding}`)

		const entries = await fs.promises.readdir(distDir)
		await Promise.all(
			entries
				.filter((entry) => entry !== path.basename(lockedLanceDbBinding))
				.map((entry) => fs.promises.rm(path.join(distDir, entry), { recursive: true, force: true })),
		)
	}
}

function resolveLanceDbNativeBindings() {
	const nativeBindings = []
	const lanceDbEntry = require.resolve("@lancedb/lancedb")
	const lanceDbRequire = createRequire(lanceDbEntry)

	for (const nativePackage of lancedbNativePackages) {
		try {
			const nativePackageJson = lanceDbRequire.resolve(`${nativePackage}/package.json`)
			const nativePackageDir = path.dirname(nativePackageJson)
			const nativeBinding = lancedbNativeBindingFiles
				.map((fileName) => path.join(nativePackageDir, fileName))
				.find((filePath) => fs.existsSync(filePath))

			if (nativeBinding) {
				nativeBindings.push(nativeBinding)
			}
		} catch {
			// Optional native packages are only installed for the current package manager environment.
		}
	}

	return nativeBindings
}

function copyLanceDbNativeBindings(distDir) {
	const nativeBindings = resolveLanceDbNativeBindings()

	if (nativeBindings.length === 0) {
		return
	}

	fs.mkdirSync(distDir, { recursive: true })
	for (const nativeBinding of nativeBindings) {
		const target = path.join(distDir, path.basename(nativeBinding))
		try {
			fs.copyFileSync(nativeBinding, target)
		} catch (error) {
			if (
				process.platform === "win32" &&
				(error?.code === "EBUSY" || error?.code === "EPERM") &&
				fs.existsSync(target)
			) {
				console.warn(`[copyLanceDbNativeBindings] Reusing locked native binding at ${target}`)
				continue
			}

			throw error
		}
		console.log(`[copyLanceDbNativeBindings] Copied ${nativeBinding} to ${target}`)
	}
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		await cleanDistDir(distDir)
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "copyLanceDbNativeBindings",
			setup(build) {
				build.onEnd((result) => {
					if (result.errors.length === 0) {
						copyLanceDbNativeBindings(distDir)
						copyBundledRipgrepDependencies(distDir)
					}
				})
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent", ...lancedbNativePackages],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
