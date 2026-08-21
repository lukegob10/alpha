import * as path from "path"
import Mocha from "mocha"
import { glob } from "glob"
import * as vscode from "vscode"

import type { RooCodeAPI } from "@alpha-code/types"

import { waitFor } from "./utils"

export async function run() {
	const extensionId = process.env.ALPHA_E2E_EXTENSION_ID
	if (!extensionId) throw new Error("ALPHA_E2E_EXTENSION_ID was not provided by the E2E runner")
	const extension = vscode.extensions.getExtension<RooCodeAPI>(extensionId)

	if (!extension) {
		throw new Error(`Development extension ${extensionId} was not found`)
	}

	const api = extension.isActive ? extension.exports : await extension.activate()
	const providerMode = process.env.ALPHA_E2E_PROVIDER_MODE ?? "live"
	if (providerMode === "live") {
		const openRouterApiKey = process.env.OPENROUTER_API_KEY
		if (!openRouterApiKey) {
			throw new Error(
				"OPENROUTER_API_KEY is required for live E2E tests. Use --provider scripted for deterministic tests.",
			)
		}
		await api.setConfiguration({
			apiProvider: "openrouter" as const,
			openRouterApiKey,
			openRouterModelId: "openai/gpt-4.1",
		})
	} else if (providerMode !== "scripted") {
		throw new Error(`Unsupported E2E provider mode: ${providerMode}`)
	}

	await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
	await waitFor(() => api.isReady())

	globalThis.api = api

	const mochaOptions: Mocha.MochaOptions = {
		ui: "tdd",
		timeout: 20 * 60 * 1_000, // 20m
	}

	if (process.env.TEST_GREP) {
		mochaOptions.grep = process.env.TEST_GREP
		console.log(`Running tests matching pattern: ${process.env.TEST_GREP}`)
	}

	const mocha = new Mocha(mochaOptions)
	const cwd = path.resolve(__dirname, "..")

	let testFiles: string[]

	if (process.env.TEST_FILE) {
		const specificFile = process.env.TEST_FILE.endsWith(".js")
			? process.env.TEST_FILE
			: `${process.env.TEST_FILE}.js`

		testFiles = await glob(`**/${specificFile}`, { cwd })
		console.log(`Running specific test file: ${specificFile}`)
	} else {
		testFiles = await glob("**/**.test.js", { cwd })
	}

	if (testFiles.length === 0) {
		throw new Error(`No test files found matching criteria: ${process.env.TEST_FILE || "all tests"}`)
	}

	testFiles.forEach((testFile) => mocha.addFile(path.resolve(cwd, testFile)))

	return new Promise<void>((resolve, reject) =>
		mocha.run((failures) => (failures === 0 ? resolve() : reject(new Error(`${failures} tests failed.`)))),
	)
}
