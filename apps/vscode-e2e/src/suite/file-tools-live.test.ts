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
		const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-header\n-value = old\n-footer\n+header\r\n+${replacement}\r\n+footer\n*** End Patch`
		await runLiveCase(
			"patch-bytes",
			["apply_patch"],
			{ [file]: originalBytes },
			`Read ${file}, then submit exactly one apply_patch call using the patch string in this JSON argument unchanged, including its mixed LF/CRLF separators: ${JSON.stringify({ patch })}. Preserve the file's BOM, CRLF and absent final newline. Read it after editing.`,
			async (calls, _messages, workspace) => {
				const edits = calls.filter((call) => call.name === "apply_patch")
				assert.equal(edits.length, 1)
				assert.equal(edits[0]!.input.patch, patch)
				assert.equal(edits[0]!.isError, false)
				assert.deepEqual(await fs.readFile(path.join(workspace, file)), Buffer.from(expectedBytes))
			},
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
		await runLiveCase(
			"patch-partial",
			["apply_patch"],
			{
				[paths[0]!]: "first old\n",
				[paths[1]!]: "second old\n",
				[paths[2]!]: "third old\n",
				[paths[3]!]: "fourth old\n",
			},
			`Read partial-first.txt, partial-second.txt and partial-third.txt under live-file-tools. Submit exactly ONE apply_patch call with this deliberate contract probe, unchanged: the second hunk cannot match, and the fourth file is ignored. Let the tool enforce those failures. Do not read the fourth file separately, fix the patch, or retry it. Report the per-file outcomes, then finish.\n${patch}`,
			async (calls, _messages, workspace) => {
				const edits = calls.filter((call) => call.name === "apply_patch")
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
		)
	})

	test("search returns compact modes, literal matches and partial batch success", async () => {
		const dir = `${prefix}/search`
		const queries = [
			{ path: dir, regex: "(" },
			{ path: dir, regex: "foo(.bar", output_mode: "files", literal: true },
			{ path: dir, regex: "TODO", output_mode: "count", literal: null },
			{ path: dir, regex: "alpha\\nbeta", literal: false },
			{ path: `${prefix}/large`, regex: "BUDGET_TOKEN", output_mode: "count" },
		]
		await runLiveCase(
			"search-modes",
			["search_files"],
			{
				[`${dir}/first.txt`]: "HEADER\nfoo(.bar\nTODO TODO\nalpha\nbeta\nTRAILER\n",
				[`${dir}/second.txt`]: "foo(.bar\nTODO\n",
				[`${dir}/secret.txt`]: "foo(.bar TODO\n",
				[`${prefix}/large/repeated.txt`]: "BUDGET_TOKEN\n".repeat(2_000),
			},
			`Make exactly one search_files call with this queries array, including the deliberately invalid first regex. Do not replace the invalid query or split the batch. Report what succeeded and failed.\n${JSON.stringify({ queries })}`,
			async (calls, messages) => {
				const searches = calls.filter((call) => call.name === "search_files")
				assert.equal(searches.length, 1)
				assert.equal(searches[0]!.isError, false, "One failed query must not fail a partially successful batch")
				assert.deepEqual(searches[0]!.input.queries, queries)
				const approvals = messages
					.filter((message) => !message.partial && (message.ask === "tool" || message.say === "tool"))
					.map((message) => {
						try {
							return record(JSON.parse(message.text ?? ""))
						} catch {
							return {}
						}
					})
					.filter((message) => message.tool === "searchFiles" && Array.isArray(message.batchSearches))
				assert.ok(approvals.length > 0)
				const results = (approvals.at(-1)!.batchSearches as unknown[]).map(record)
				assert.deepEqual(
					results.map((result) => result.searchStatus),
					["error", "success", "success", "success", "success"],
				)
				assert.match(String(results[0]!.content), /unclosed group|regex parse error/)
				assert.deepEqual(String(results[1]!.content).split("\n").sort(), [
					`${dir}/first.txt`,
					`${dir}/second.txt`,
				])
				assert.deepEqual(String(results[2]!.content).split("\n").sort(), [
					`${dir}/first.txt: 2`,
					`${dir}/second.txt: 1`,
				])
				assert.match(String(results[3]!.content), /4 \| alpha\n\s*5 \| beta/)
				assert.match(String(results[4]!.content), /Search output truncated/)
				assert.match(String(results[4]!.content), /Counts are lower bounds/)
				assert.ok(!String(results[4]!.content).includes("BUDGET_TOKEN"))
				assert.ok(searches[0]!.result.length <= 16_000)
			},
		)
	})
})
