import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { runLiveCase } from "./live-file-tool-support"

const scope =
	"Work only in live-read-evidence. Use exec_command with bounded read-only Node.js inspections of the named files. Leave files unchanged unless the task explicitly asks for a repair. Finish with a concise answer supported by command output."

const linesCommand = (file: string, start: number, count: number) =>
	`node -e "const fs=require('fs');const lines=fs.readFileSync('${file}','utf8').split(/\\r?\\n/);console.log(lines.slice(${start - 1},${start - 1 + count}).map((line,index)=>String(index+${start})+' | '+line).join('\\n'))"`

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
			["exec_command", "apply_patch"],
			{
				[file]:
					prefix +
					"function totalCents(items) {\r\n  return items.reduce((sum, item) => sum + item.unitCents, 0)\r\n}\r\nmodule.exports = { totalCents }",
			},
			`Inspect lines 1601-1603 of ${file} with this read-only command before editing: ${JSON.stringify(linesCommand(file, 1601, 3))}. Fix totalCents so invoice totals multiply each item's unitCents by its quantity, then sum all items. Empty invoices total zero. Preserve unrelated content. Verify the saved change and briefly report what you verified.`,
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
				const inspection = calls.find((call) => call.name === "exec_command")
				assert.ok(inspection, "The model must inspect the current implementation with exec_command")
				assert.match(inspection.result, /function totalCents/)
				assert.match(inspection.result, /item\.unitCents/)
				assert.ok(calls.some((call) => call.name === "apply_patch" && !call.isError))
			},
			{
				scope: "Work only in live-read-evidence/repair. Inspect with exec_command, then make the requested repair with apply_patch.",
				commands: ["node"],
			},
		)
	})

	test("batch selections honor limits and optional null ranges", async () => {
		const first = "live-read-evidence/batch/first.txt"
		const second = "live-read-evidence/batch/second.txt"
		const content = Array.from({ length: 320 }, (_, index) => `record ${index + 1}`).join("\n")
		const cmd = `node -e "const fs=require('fs');for(const p of ['${first}','${second}']){const lines=fs.readFileSync(p,'utf8').split(/\\r?\\n/);console.log(p+'\\n'+lines.slice(219,222).map((line,index)=>String(index+220)+' | '+line).join('\\n'))}"`
		await runLiveCase(
			"read-batch",
			["exec_command"],
			{ [first]: content, [second]: content },
			`Use one exec_command call with this cmd exactly: ${JSON.stringify(cmd)}. Report the returned records. Do not retry errors.`,
			async (calls) => {
				const reads = calls.filter((call) => call.name === "exec_command")
				assert.equal(reads.length, 1)
				assert.equal(reads[0]!.isError, false)
				assert.equal(reads[0]!.input.cmd, cmd)
				for (const line of [220, 221, 222])
					assert.equal(reads[0]!.result.match(new RegExp(`\\b${line} \\| record ${line}`, "g"))?.length, 2)
				assert.doesNotMatch(reads[0]!.result, /\b(?:1|219|223) \| record /)
			},
			{ scope, commands: ["node"] },
		)
	})

	test("continuation begins at the first line not completely delivered", async () => {
		const file = "live-read-evidence/large.txt"
		const content = Array.from(
			{ length: 2500 },
			(_, index) => `record ${String(index + 1).padStart(4, "0")} ${"x".repeat(44)}`,
		).join("\n")
		const firstCmd = linesCommand(file, 1, 80)
		const secondCmd = linesCommand(file, 81, 80)
		await runLiveCase(
			"read-continuation",
			["exec_command"],
			{ [file]: content },
			`Inspect ${file} in two bounded windows. First call exec_command with cmd ${JSON.stringify(firstCmd)}, then call exec_command with cmd ${JSON.stringify(secondCmd)}. Stop after those two reads and report the line ranges actually visible; do not read the entire file.`,
			async (calls) => {
				const reads = calls.filter((call) => call.name === "exec_command")
				assert.equal(reads.length, 2)
				assert.deepEqual(
					reads.map((read) => read.input.cmd),
					[firstCmd, secondCmd],
				)
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
			{ scope, commands: ["node"] },
		)
	})

	test("a small quality review finds both defects and the correct boundary", async () => {
		const dir = "live-read-evidence/review"
		const cmd = `node -e "const fs=require('fs');for(const p of ['${dir}/access.ts','${dir}/routes.ts','${dir}/access.test.ts','${dir}/README.md']){console.log(p);console.log(fs.readFileSync(p,'utf8'))}"`
		await runLiveCase(
			"read-review",
			["exec_command"],
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
			`Inspect the named access-control source, tests, and requirements in ${dir} with one exec_command call using this cmd exactly: ${JSON.stringify(cmd)}. Identify concrete defects, what is already correct, and missing tests. Cite the source and name canRead and canWrite.`,
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
				const inspection = calls.find((call) => call.name === "exec_command")
				assert.ok(inspection)
				assert.equal(inspection.input.cmd, cmd)
				assert.match(inspection.result, /user\.active/)
				assert.match(inspection.result, /canWrite/)
			},
			{ scope, commands: ["node"] },
		)
	})
})
