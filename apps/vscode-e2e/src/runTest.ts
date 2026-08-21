import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"

import { runTests } from "@vscode/test-electron"

type ProviderMode = "live" | "scripted"

const readOption = (name: string): string | undefined => {
	const index = process.argv.indexOf(name)
	if (index === -1) return undefined
	const value = process.argv[index + 1]
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
	return value
}

const readProviderMode = (): ProviderMode => {
	const value = readOption("--provider") ?? process.env.ALPHA_E2E_PROVIDER_MODE ?? "live"
	if (value !== "live" && value !== "scripted") {
		throw new Error(`Unsupported E2E provider mode: ${value}`)
	}
	return value
}

async function main() {
	const extensionDevelopmentPath = path.resolve(__dirname, "../../../src")
	const extensionTestsPath = path.resolve(__dirname, "./suite/index")
	const extensionManifest = JSON.parse(
		await fs.readFile(path.join(extensionDevelopmentPath, "package.json"), "utf8"),
	) as { name?: unknown; publisher?: unknown }
	if (typeof extensionManifest.name !== "string" || typeof extensionManifest.publisher !== "string") {
		throw new Error("The extension manifest must define string name and publisher fields")
	}
	const extensionId = `${extensionManifest.publisher}.${extensionManifest.name}`
	const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-vscode-e2e-"))
	const testWorkspace = path.join(testRoot, "workspace")
	const userDataDir = path.join(testRoot, "user-data")
	const extensionsDir = path.join(testRoot, "extensions")

	try {
		await Promise.all([
			fs.mkdir(testWorkspace, { recursive: true }),
			fs.mkdir(userDataDir, { recursive: true }),
			fs.mkdir(extensionsDir, { recursive: true }),
		])

		const testGrep = readOption("--grep") ?? process.env.TEST_GREP
		const testFile = readOption("--file") ?? process.env.TEST_FILE
		const providerMode = readProviderMode()
		const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH

		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [testWorkspace, `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
			extensionTestsEnv: {
				...process.env,
				ALPHA_E2E_EXTENSION_ID: extensionId,
				ALPHA_E2E_PROVIDER_MODE: providerMode,
				ALPHA_E2E_WORKSPACE: testWorkspace,
				...(testGrep && { TEST_GREP: testGrep }),
				...(testFile && { TEST_FILE: testFile }),
			},
			...(vscodeExecutablePath
				? { vscodeExecutablePath: path.resolve(vscodeExecutablePath) }
				: { version: process.env.VSCODE_VERSION || "1.120.0" }),
		})
	} finally {
		await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
	}
}

main().catch((error) => {
	console.error("Failed to run VS Code extension-host tests", error)
	process.exitCode = 1
})
