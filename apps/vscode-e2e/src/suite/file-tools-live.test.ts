import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { assertOwnedTestRoot } from "../testProfile"
import { record, runLiveCase } from "./live-file-tool-support"

const prefix = "live-file-tools"

const replacement = "value = $& $$ $1 $` $' &lt; &amp; &#36;"
const originalBytes = "\uFEFFheader\r\nvalue = old\r\nfooter"
const expectedBytes = originalBytes.replace("value = old", () => replacement)

suite("Live Copilot file-tool contracts", function () {
	this.timeout(230_000)
	suiteSetup(async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
		const workspace = process.env.ALPHA_E2E_WORKSPACE!
		await assertOwnedTestRoot(workspace)
		await fs.writeFile(
			path.join(workspace, ".alphaignore"),
			`${prefix}/partial-fourth.txt\n${prefix}/search/secret.txt\n`,
			{ flag: "wx" },
		)
	})

	test("patch preserves BOM, CRLF, literal dollars/entities and no final newline", async () => {
		const file = `${prefix}/patch-bytes.txt`
		const inspect = `node -e "const fs=require('fs');console.log(fs.readFileSync('${file}').toString('base64'))"`
		const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-header\n-value = old\n-footer\n+header\r\n+${replacement}\r\n+footer\n*** End Patch`
		await runLiveCase(
			"patch-bytes",
			["exec_command", "apply_patch"],
			{ [file]: originalBytes },
			`Inspect ${file} with exec_command using this cmd before and after editing: ${JSON.stringify(inspect)}. Then submit exactly one apply_patch call using the patch string in this JSON argument unchanged, including its mixed LF/CRLF separators: ${JSON.stringify({ patch })}. Preserve the file's BOM, CRLF and absent final newline.`,
			async (calls, _messages, workspace) => {
				const edits = calls.filter((call) => call.name === "apply_patch")
				const inspections = calls.filter((call) => call.name === "exec_command")
				assert.ok(inspections.length >= 2, "The model must inspect the file before and after the patch")
				assert.ok(inspections.every((call) => call.input.cmd === inspect))
				assert.ok(
					inspections.some((call) => call.result.includes(Buffer.from(originalBytes).toString("base64"))),
				)
				assert.ok(
					inspections.some((call) => call.result.includes(Buffer.from(expectedBytes).toString("base64"))),
				)
				assert.equal(edits.length, 1)
				assert.equal(edits[0]!.input.patch, patch)
				assert.equal(edits[0]!.isError, false)
				assert.deepEqual(await fs.readFile(path.join(workspace, file)), Buffer.from(expectedBytes))
			},
			{ commands: ["node"] },
		)
	})

	test("patch reports applied, error and skipped files after a partial failure", async () => {
		const paths = ["first", "second", "third", "fourth"].map((name) => `${prefix}/partial-${name}.txt`)
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${paths[0]}`,
			"@@",
			"-first old",
			"+first new",
			`*** Update File: ${paths[1]}`,
			"@@",
			"-INTENTIONALLY ABSENT",
			"+second new",
			`*** Update File: ${paths[2]}`,
			"@@",
			"-third old",
			"+third new",
			`*** Update File: ${paths[3]}`,
			"@@",
			"-fourth old",
			"+fourth new",
			"*** End Patch",
		].join("\n")
		const inspect = `node -e "const fs=require('fs');for(const p of ['${paths[0]}','${paths[1]}','${paths[2]}']){console.log(p);console.log(fs.readFileSync(p,'utf8'))}"`
		await runLiveCase(
			"patch-partial",
			["exec_command", "apply_patch"],
			{
				[paths[0]!]: "first old\n",
				[paths[1]!]: "second old\n",
				[paths[2]!]: "third old\n",
				[paths[3]!]: "fourth old\n",
			},
			`Inspect the first three named files under live-file-tools with exec_command using this cmd: ${JSON.stringify(inspect)}. Submit exactly ONE apply_patch call with this deliberate contract probe, unchanged: the second hunk cannot match, and the fourth file is ignored. Let the tool enforce those failures. Do not inspect the fourth file, fix the patch, or retry it. Report the per-file outcomes, then finish.\n${patch}`,
			async (calls, _messages, workspace) => {
				const edits = calls.filter((call) => call.name === "apply_patch")
				const inspection = calls.find((call) => call.name === "exec_command")
				assert.ok(inspection)
				assert.equal(inspection.input.cmd, inspect)
				assert.match(inspection.result, /first old/)
				assert.match(inspection.result, /second old/)
				assert.match(inspection.result, /third old/)
				assert.equal(edits.length, 1)
				assert.equal(edits[0]!.isError, true)
				const ledger = record(JSON.parse(edits[0]!.result)).files
				assert.ok(Array.isArray(ledger))
				assert.deepEqual(
					ledger.map((entry) => record(entry).status),
					["applied", "error", "applied", "skipped"],
				)
				assert.deepEqual(
					ledger.map((entry) => record(entry).path),
					paths,
				)
				assert.equal(await fs.readFile(path.join(workspace, paths[0]!), "utf8"), "first new\n")
				assert.equal(await fs.readFile(path.join(workspace, paths[1]!), "utf8"), "second old\n")
				assert.equal(await fs.readFile(path.join(workspace, paths[2]!), "utf8"), "third new\n")
				assert.equal(await fs.readFile(path.join(workspace, paths[3]!), "utf8"), "fourth old\n")
				assert.match(String(record(ledger[1]).reason), /Failed to find expected lines/)
				assert.match(String(record(ledger[3]).reason), /alphaignore/)
			},
			{ commands: ["node"] },
		)
	})

	test("exec_command inspects bounded workspace matches", async () => {
		const dir = `${prefix}/search`
		const inspect = `node -e "const fs=require('fs');for(const p of ['${dir}/first.txt','${dir}/second.txt']){const lines=fs.readFileSync(p,'utf8').split(/\\r?\\n/);for(let i=0;i<lines.length;i++)if(lines[i].includes('foo(.bar'))console.log(p+':'+String(i+1)+':'+lines[i])}"`
		await runLiveCase(
			"exec-file-inspection",
			["exec_command"],
			{
				[`${dir}/first.txt`]: "HEADER\nfoo(.bar\nTODO TODO\nalpha\nbeta\nTRAILER\n",
				[`${dir}/second.txt`]: "foo(.bar\nTODO\n",
				[`${dir}/secret.txt`]: "foo(.bar TODO\n",
				[`${prefix}/large/repeated.txt`]: "BUDGET_TOKEN\n".repeat(2_000),
			},
			`Use one exec_command call with this cmd exactly: ${JSON.stringify(inspect)}. Report the matches and their line numbers. Do not inspect secret.txt or the large directory.`,
			async (calls) => {
				const inspections = calls.filter((call) => call.name === "exec_command")
				assert.equal(inspections.length, 1)
				assert.equal(inspections[0]!.input.cmd, inspect)
				assert.equal(inspections[0]!.isError, false)
				assert.match(inspections[0]!.result, new RegExp(`${dir}/first\\.txt:2:foo\\(\\.bar`))
				assert.match(inspections[0]!.result, new RegExp(`${dir}/second\\.txt:1:foo\\(\\.bar`))
				assert.doesNotMatch(inspections[0]!.result, /secret\.txt|BUDGET_TOKEN/)
				assert.ok(inspections[0]!.result.length <= 16_000)
			},
			{ commands: ["node"] },
		)
	})
})
