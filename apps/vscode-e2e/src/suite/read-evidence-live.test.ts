import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { runLiveCase } from "./live-file-tool-support"

const scope =
	"Work only in live-read-evidence. Leave files unchanged. Finish with a concise answer supported by the evidence you obtained."

suite("Live Copilot read evidence", function () {
	this.timeout(230_000)

	test("finds and repairs a named function late in a large file without changing unrelated bytes", async () => {
		const file = "live-read-evidence/repair/invoice.js"
		const prefix =
			"\uFEFF" +
			Array.from({ length: 1600 }, (_, i) => `// Archived example ${i + 1}: ${"unchanged ".repeat(5)}`).join(
				"\r\n",
			) +
			"\r\n"
		await runLiveCase(
			"read-repair",
			["search_files", "apply_patch"],
			{
				[file]:
					prefix +
					"function totalCents(items) {\r\n  return items.reduce((sum, item) => sum + item.unitCents, 0)\r\n}\r\nmodule.exports = { totalCents }",
			},
			`Fix totalCents in ${file}: invoice totals must multiply each item's unitCents by its quantity, then sum all items. Empty invoices total zero. Inspect the relevant implementation and preserve the unrelated content. Verify the saved change and briefly report what you verified.`,
			async (calls, _messages, workspace) => {
				const source = await fs.readFile(path.join(workspace, file), "utf8")
				assert.ok(source.startsWith(prefix), "Unrelated content, BOM, and CRLF must be preserved")
				assert.doesNotMatch(source, /(?<!\r)\n/)
				assert.equal(source.endsWith("\n"), false)
				const context = { module: { exports: {} as { totalCents?: (items: unknown[]) => number } } }
				runInNewContext(source, context, { timeout: 1000 })
				const total = context.module.exports.totalCents!
				assert.equal(total([]), 0)
				assert.equal(
					total([
						{ unitCents: 250, quantity: 3 },
						{ unitCents: 100, quantity: 2 },
					]),
					950,
				)
				assert.equal(total([{ unitCents: 100, quantity: 0 }]), 0)
				assert.ok(calls.some((call) => call.name === "read_file"))
				assert.ok(calls.some((call) => call.name === "apply_patch" && !call.isError))
			},
			{
				scope: "Work only in live-read-evidence/repair. Make the requested repair with the available file tools.",
			},
		)
	})

	test("batch selections honor limits and optional null ranges", async () => {
		const first = "live-read-evidence/batch/first.txt"
		const second = "live-read-evidence/batch/second.txt"
		const content = Array.from({ length: 320 }, (_, index) => `record ${index + 1}`).join("\n")
		const input = {
			path: first,
			files: [
				{ path: first, line_ranges: null },
				{ path: second, line_ranges: null },
			],
			offset: 220,
			limit: 3,
			mode: "slice",
		}
		await runLiveCase(
			"read-batch",
			[],
			{ [first]: content, [second]: content },
			`Submit one read_file call with these arguments unchanged: ${JSON.stringify(input)}. Report the returned records. Do not retry errors.`,
			async (calls) => {
				const reads = calls.filter((call) => call.name === "read_file")
				assert.equal(reads.length, 1)
				assert.equal(reads[0]!.isError, false)
				assert.deepEqual(reads[0]!.input, input)
				for (const line of [220, 221, 222])
					assert.equal(reads[0]!.result.match(new RegExp(`\\b${line} \\| record ${line}`, "g"))?.length, 2)
				assert.doesNotMatch(reads[0]!.result, /\b(?:1|219|223) \| record /)
			},
			{ scope },
		)
	})

	test("continuation begins at the first line not completely delivered", async () => {
		const file = "live-read-evidence/large.txt"
		const content = Array.from(
			{ length: 2500 },
			(_, index) => `record ${String(index + 1).padStart(4, "0")} ${"x".repeat(44)}`,
		).join("\n")
		await runLiveCase(
			"read-continuation",
			[],
			{ [file]: content },
			`Read ${file} from the beginning using read_file's default line limit. Then make one more read_file call using the continuation provided by that result. Stop after these two reads and report the line ranges actually visible; do not read the entire file.`,
			async (calls) => {
				const reads = calls.filter((call) => call.name === "read_file")
				assert.equal(reads.length, 2)
				const ranges = reads.map((read) => {
					assert.equal(read.isError, false)
					assert.ok(read.result.length <= 32_000)
					assert.doesNotMatch(read.result, /Tool output truncated by harness/)
					const lines = [...read.result.matchAll(/^\s*(\d+) \| (.*)$/gm)]
					assert.ok(lines.length > 0)
					for (const line of lines)
						assert.equal(line[2], `record ${String(line[1]).padStart(4, "0")} ${"x".repeat(44)}`)
					return { first: Number(lines[0]![1]), last: Number(lines.at(-1)![1]) }
				})
				assert.equal(ranges[0]!.first, 1)
				assert.equal(ranges[1]!.first, ranges[0]!.last + 1)
			},
			{ scope },
		)
	})

	test("a small quality review finds both defects and the correct boundary", async () => {
		const dir = "live-read-evidence/review"
		await runLiveCase(
			"read-review",
			["list_files", "search_files"],
			{
				[`${dir}/access.ts`]:
					'export function canRead(user, record) {\n  return user.active && user.tenantId === record.tenantId\n}\nexport function canWrite(user, record) {\n  return user.role === "editor"\n}\n',
				[`${dir}/routes.ts`]:
					'import { canRead, canWrite } from "./access"\nexport function getRecord(user, record) {\n  if (!canRead(user, record)) throw new Error("denied")\n  return record\n}\nexport function updateRecord(user, record, title) {\n  if (!canWrite(user, record)) throw new Error("denied")\n  record.title = title\n}\n',
				[`${dir}/README.md`]:
					"Records belong to one tenant. Only active editors in that same tenant may update a record. Active users in that tenant may read it. Review implementation against these requirements.\n",
				[`${dir}/access.test.ts`]:
					'import { canRead, canWrite } from "./access"\nit("permits an editor in the same tenant", () => {\n  expect(canWrite({ active: true, role: "editor", tenantId: "a" }, { tenantId: "a" })).toBe(true)\n})\nit("denies a read across tenants", () => {\n  expect(canRead({ active: true, tenantId: "a" }, { tenantId: "b" })).toBe(false)\n})\n',
			},
			`Review the quality of the access-control code in ${dir}. Identify concrete defects, what is already correct, and missing tests. Cite the source and name canRead and canWrite.`,
			async (calls, _messages, _workspace, assistantText) => {
				const answer = [
					...calls
						.filter((call) => call.name === "attempt_completion")
						.map((call) => String(call.input.result)),
					assistantText,
				].join("\n")
				assert.match(answer, /tenant/i)
				assert.match(answer, /inactive|active|deactivat/i)
				assert.match(answer, /canRead|active user and matching tenant|matching tenant for reads/i)
				assert.match(answer, /canWrite/)
				assert.match(answer, /test/i)
				assert.ok(calls.some((call) => call.name === "read_file"))
			},
			{ scope },
		)
	})
})
