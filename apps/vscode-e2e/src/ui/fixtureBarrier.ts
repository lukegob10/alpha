import * as assert from "node:assert/strict"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { waitUntil } from "../evidence/sharedStorageProtocol"

/** Optional coordination in the existing fixture; only the external renderer driver acknowledges a stage. */
export async function uiFixtureBarrier(stage: string, detail: Record<string, unknown> = {}): Promise<void> {
	const nonce = process.env.ALPHA_UI_ACCEPTANCE_NONCE
	if (!nonce) return
	assert.match(nonce, /^[a-f0-9-]{36}$/)
	assert.match(stage, /^[a-z-]+$/)
	const directory = process.env.ALPHA_E2E_ARTIFACTS_DIR!
	assert.ok(directory)
	await fs.writeFile(path.join(directory, `ui-stage-${stage}.json`), JSON.stringify({ ...detail, nonce, stage }), {
		flag: "wx",
	})
	await waitUntil(
		async () => {
			try {
				const result = JSON.parse(await fs.readFile(path.join(directory, `ui-done-${stage}.json`), "utf8"))
				assert.equal(result.nonce, nonce)
				assert.equal(result.stage, stage)
				assert.equal(result.status, "passed")
				return true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
				throw error
			}
		},
		Date.now() + 60000,
		`ui_${stage}_timeout`,
	)
}
