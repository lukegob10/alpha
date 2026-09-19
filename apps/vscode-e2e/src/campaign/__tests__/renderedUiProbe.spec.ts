import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runExtensionTests, type ExtensionTestRunOptions } from "../../runTest"

test("renderer debugging is scoped to the explicit scripted fixture and owned profile", async () => {
	for (const change of [
		{ rendererDebuggingPort: 9222 },
		{ providerMode: "live" },
		{ profileDir: undefined },
		{ testFile: "extension.test" },
	]) {
		await assert.rejects(
			runExtensionTests({
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				rendererDebuggingPort: 0,
				profileDir: "unused",
				testFile: "rendered-ui-probe.test",
				...change,
			} as ExtensionTestRunOptions),
			/Renderer debugging requires/,
		)
	}
})

test("the normal runner passes only an ephemeral renderer port for the UI fixture", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ui-port-test-"))
	try {
		let launched = false
		await runExtensionTests(
			{
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				rendererDebuggingPort: 0,
				testFile: "rendered-ui-probe.test",
				profileDir: path.join(root, "profile"),
				workspace: path.join(root, "workspace"),
				artifactsDir: path.join(root, "evidence"),
				initializeProfile: true,
			},
			{
				launch: async (options) => {
					launched = true
					assert.equal(
						options.launchArgs?.filter((value) => value.startsWith("--remote-debugging-port=")).join(),
						"--remote-debugging-port=0",
					)
					return 1
				},
			},
		)
		assert.equal(launched, true)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
