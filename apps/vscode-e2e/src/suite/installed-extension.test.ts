import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import "./workflow.test"

suite("Installed extension identity", () => {
	test("runs the selected installed artifact with one active Alpha identity", async function () {
		const expectedDirectory = process.env.ALPHA_E2E_INSTALLED_EXTENSION_DIR
		if (!expectedDirectory) this.skip()
		const extensions = vscode.extensions.all.filter((extension) => extension.id.toLowerCase() === "alphainc.alpha")
		assert.equal(extensions.length, 1)
		const extension = extensions[0]!
		assert.ok(extension.isActive)
		assert.equal(extension.exports, globalThis.api)
		assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(expectedDirectory!))
		assert.equal(extension.packageJSON.version, process.env.ALPHA_E2E_INSTALLED_EXTENSION_VERSION)
		const bundle = await fs.readFile(path.join(extension.extensionPath, "dist/extension.js"))
		await fs.writeFile(
			path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "installed-extension.json"),
			JSON.stringify(
				{
					hostVersion: vscode.version,
					extensionId: extension.id,
					version: extension.packageJSON.version,
					extensionDirectory: path.basename(extension.extensionPath),
					bundleSha256: createHash("sha256").update(bundle).digest("hex"),
					activeIdentities: extensions.length,
				},
				null,
				2,
			),
			{ flag: "wx" },
		)
	})
})
