import { strict as assert } from "node:assert"
import { test } from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { settlementPrompt, settlementScript, settlementRevisions, SETTLEMENT_ORACLE } from "./commandSettlement"
import { applyFixturePatch } from "./fixturePatchTestHelper"

test("the independent HTML oracle accepts browser click events and rejects broken controls", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-settlement-oracle-")))
	try {
		for (const call of settlementScript(1, root)) {
			if (call.name === "apply_patch") await applyFixturePatch(root, call.arguments.patch)
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

test("settlement workload bounds revisions and yields only the exact approved Node command", () => {
	assert.throws(() => settlementPrompt(13))
	assert.throws(() => settlementRevisions("13"))
	assert.deepEqual(settlementRevisions(undefined), [1, 2, 3])
	assert.equal(settlementRevisions("12").length, 12)
	for (const revision of [1, 2, 3]) {
		const plan = settlementScript(revision, "/workspace")
		const commands = plan.filter((call) => call.name === "exec_command")
		assert.deepEqual(commands, [
			{
				name: "exec_command",
				arguments: {
					cmd: `node .alpha-receipt-oracle.cjs ${revision}`,
					workdir: "/workspace",
					yield_time_ms: 10_000,
				},
			},
		])
		assert.equal(plan.at(-1)?.name, "exec_command")
		assert.ok(plan.every((call) => call.name === "apply_patch" || call.name === "exec_command"))
	}
})

test("canonical settlement patches preserve prior files through every supported revision", async () => {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-settlement-patches-")))
	try {
		for (const revision of settlementRevisions("12")) {
			for (const call of settlementScript(revision, root))
				if (call.name === "apply_patch") await applyFixturePatch(root, call.arguments.patch)
			assert.equal(JSON.parse(await readFile(path.join(root, "config.json"), "utf8")).revision, revision)
			assert.match(await readFile(path.join(root, "README.md"), "utf8"), new RegExp(`revision ${revision}:`))
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
