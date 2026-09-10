import { strict as assert } from "node:assert"
import { test } from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { settlementPrompt, settlementScript, settlementRevisions, SETTLEMENT_ORACLE } from "./commandSettlement"

test("the independent HTML oracle accepts browser click events and rejects broken controls", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-settlement-oracle-"))
	try {
		for (const call of settlementScript(1, root)) {
			if (call.name !== "write_to_file") continue
			const args = call.arguments as { path: string; content: string }
			await writeFile(path.join(root, args.path), args.content)
		}
		await writeFile(path.join(root, "oracle.cjs"), SETTLEMENT_ORACLE)
		await writeFile(
			path.join(root, "app.js"),
			`
const count = document.getElementById('count')
count.textContent = 0
for (const id of ['increment', 'decrement', 'reset']) {
 const element = document.getElementById(id)
 element.addEventListener('click', function(event) {
  if (event.currentTarget !== element || event.target !== this) throw new Error('Invalid browser event')
  count.textContent = id === 'reset' ? 0 : Number(count.textContent) + (id === 'increment' ? 1 : -1)
 })
}
`,
		)
		const run = () =>
			promisify(execFile)(process.execPath, ["oracle.cjs", "1"], {
				cwd: root,
				windowsHide: true,
				timeout: 10_000,
				maxBuffer: 512 * 1024,
			})
		await run()
		assert.deepEqual(JSON.parse(await readFile(path.join(root, "build-receipt.json"), "utf8")), {
			revision: 1,
			checks: 5,
			passed: true,
		})
		await writeFile(path.join(root, "app.js"), "document.getElementById('count').textContent = 0")
		await assert.rejects(run())
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test("settlement workload bounds revisions and backgrounds only the exact approved Node command", () => {
	assert.throws(() => settlementPrompt(13))
	assert.throws(() => settlementRevisions("13"))
	assert.deepEqual(settlementRevisions(undefined), [1, 2, 3])
	assert.equal(settlementRevisions("12").length, 12)
	for (const revision of [1, 2, 3]) {
		const plan = settlementScript(revision, "/workspace")
		const commands = plan.filter((call) => call.name === "execute_command")
		assert.deepEqual(commands, [
			{
				name: "execute_command",
				arguments: { command: `node .alpha-receipt-oracle.cjs ${revision}`, cwd: "/workspace", timeout: 1 },
			},
		])
		assert.equal(plan.at(-1)?.name, "attempt_completion")
	}
})
