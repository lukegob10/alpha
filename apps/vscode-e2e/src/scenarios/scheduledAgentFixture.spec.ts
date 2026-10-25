import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { SCHEDULED_RECEIPT_CONTENT, SCHEDULED_VERIFIER_SOURCE } from "./scheduledAgentFixture"

test("the real schedule verifier accepts host text line endings and rejects malformed receipt content", async () => {
	const root = path.resolve(os.tmpdir())
	const directory = await fs.mkdtemp(path.join(root, "schedule-verifier-"))
	assert.equal(path.dirname(directory), root)
	try {
		const verifier = path.join(directory, "verify.cjs")
		await fs.writeFile(verifier, SCHEDULED_VERIFIER_SOURCE)
		const cases = [
			{ name: "LF", content: SCHEDULED_RECEIPT_CONTENT, exit: 0 },
			{ name: "CRLF", content: SCHEDULED_RECEIPT_CONTENT.replace(/\n/g, "\r\n"), exit: 0 },
			{ name: "literal escaped newline", content: String.raw`SCHEDULE_EFFECT\n`, exit: 1 },
			{ name: "missing final newline", content: "SCHEDULE_EFFECT", exit: 1 },
			{ name: "extra line", content: `${SCHEDULED_RECEIPT_CONTENT}\n`, exit: 1 },
			{ name: "bare carriage return", content: "SCHEDULE_EFFECT\r", exit: 1 },
			{ name: "wrong effect", content: "UNEXPECTED_EFFECT\n", exit: 1 },
		]
		for (const fixture of cases) {
			await fs.writeFile(path.join(directory, "receipt.txt"), fixture.content)
			const result = spawnSync(process.execPath, [verifier], {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
			})
			assert.equal(result.error, undefined, `${fixture.name}: verifier must execute`)
			assert.equal(result.signal, null, `${fixture.name}: verifier must exit normally`)
			assert.equal(result.status, fixture.exit, `${fixture.name}: ${result.stderr}`)
			assert.equal(result.stdout.replace(/\r\n/g, "\n"), fixture.exit === 0 ? "SCHEDULE_VERIFIED\n" : "")
		}
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})
