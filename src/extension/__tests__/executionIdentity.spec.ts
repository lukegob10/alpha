import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { readExecutionIdentity } from "../executionIdentity"

describe("installed execution identity", () => {
	it("observes actual installed bytes and rejects an entrypoint outside the installation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-installed-identity-"))
		try {
			const install = path.join(root, "extension")
			await fs.mkdir(install)
			const manifest = { name: "alpha", publisher: "Alpha", version: "1.0.0", main: "extension.js" }
			await fs.writeFile(path.join(install, "package.json"), JSON.stringify(manifest))
			await fs.writeFile(path.join(install, "extension.js"), "actual byte identity")
			const receipt = await readExecutionIdentity(install, "1.125.0")
			expect(receipt).toMatchObject({
				hostVersion: "1.125.0",
				extensionId: "Alpha.alpha",
				identityScope: "observed-entrypoint-and-manifest",
			})
			await fs.writeFile(path.join(install, "extension.js"), "changed")
			expect((await readExecutionIdentity(install, "1.125.0")).entrypointDigest).not.toBe(
				receipt.entrypointDigest,
			)
			await fs.writeFile(path.join(root, "outside.js"), "outside")
			await fs.writeFile(
				path.join(install, "package.json"),
				JSON.stringify({ ...manifest, main: "../outside.js" }),
			)
			await expect(readExecutionIdentity(install, "1.125.0")).rejects.toThrow("outside")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
