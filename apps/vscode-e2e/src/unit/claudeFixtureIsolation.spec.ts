import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { runExtensionTests } from "../runTest"

for (const providerMode of ["vscode-lm-fixture", "scripted", "live-copilot"] as const) {
	test(`${providerMode} records and launches only its intended disabled extensions`, async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-claude-isolation-")))
		let launchArgs: string[] | undefined
		let receipt: { fixtureIsolation?: { disabledExtensions: string[]; gitExecution: string } } | undefined
		try {
			const result = await runExtensionTests(
				{
					providerMode,
					vscodeVersion: "1.138.0",
					profileDir: path.join(root, "profile"),
					workspace: path.join(root, "workspace"),
					artifactsDir: path.join(root, "artifacts"),
					initializeProfile: true,
					modelId: "exact-live-model-id",
				},
				{
					launch: async (options) => {
						launchArgs = options.launchArgs
						receipt = JSON.parse(
							await fs.readFile(
								path.join(options.extensionTestsEnv!.ALPHA_E2E_ARTIFACTS_DIR!, "launch.json"),
								"utf8",
							),
						)
						return 0
					},
				},
			)
			// This seam checks launch isolation only; missing real host evidence must remain blocked.
			assert.equal(result.execution, "test-seam")
			assert.equal(result.status, "blocked")
			assert.ok(launchArgs)
			const expected = ["vscode.git", ...(providerMode === "vscode-lm-fixture" ? ["github.copilot-chat"] : [])]
			assert.deepEqual(receipt?.fixtureIsolation, { disabledExtensions: expected, gitExecution: "native-cli" })
			assert.deepEqual(
				launchArgs.filter((argument) => argument.startsWith("--disable-extension=")),
				expected.map((id) => `--disable-extension=${id}`),
			)
		} finally {
			assert.equal(await fs.realpath(path.dirname(root)), await fs.realpath(os.tmpdir()))
			assert.match(path.basename(root), /^alpha-claude-isolation-/)
			await fs.rm(root, { recursive: true, force: true })
		}
	})
}
