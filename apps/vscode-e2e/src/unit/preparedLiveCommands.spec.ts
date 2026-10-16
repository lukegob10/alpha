import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { runInNewContext } from "node:vm"
import { test } from "node:test"

const execute = promisify(execFile)
interface CommandFixture {
	id: string
	files: Record<string, string>
	commands: string[]
}

test("the eight live file probes run prepared scripts without opaque inline code", async () => {
	const fixtures: CommandFixture[] = []
	for (const suite of ["command-file-diff-live", "file-tools-live", "read-evidence-live"]) {
		const suitePath = path.resolve(__dirname, `../suite/${suite}.test.js`)
		const load = createRequire(suitePath)
		const tests: Array<() => Promise<void>> = []
		runInNewContext(await fs.readFile(suitePath, "utf8"), {
			exports: {},
			require: (specifier: string) => {
				if (specifier === "vscode") return {}
				if (specifier !== "./live-file-tool-support") return load(specifier)
				return {
					runLiveCase: async (
						id: string,
						_tools: unknown,
						files: Record<string, string>,
						_prompt: string,
						_verify: unknown,
						options: { commands: string[] },
					) => fixtures.push({ id, files, commands: options.commands }),
				}
			},
			suite: (_title: string, register: () => void) => register.call({ timeout() {} }),
			suiteSetup: () => {},
			test: (_title: string, run: () => Promise<void>) => tests.push(run),
		})
		for (const run of tests) await run()
	}
	assert.equal(fixtures.length, 8)
	for (const fixture of fixtures) {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-prepared-command-")))
		try {
			for (const [relative, content] of Object.entries(fixture.files)) {
				const target = path.resolve(directory, relative)
				assert.ok(path.relative(directory, target) && !path.relative(directory, target).startsWith(".."))
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, content, { flag: "wx" })
			}
			for (const command of fixture.commands) {
				assert.match(command, /^node (live-file-tools|live-read-evidence)\/[a-z0-9/-]+\.cjs$/)
				const script = command.slice("node ".length)
				assert.ok(Object.hasOwn(fixture.files, script), `${fixture.id}: script must be seeded before the task`)
				if (script.endsWith("verify-invoice.cjs")) {
					await assert.rejects(execute(process.execPath, [script], { cwd: directory, windowsHide: true }))
					const invoice = path.join(directory, "live-read-evidence/repair/invoice.js")
					await fs.writeFile(
						invoice,
						(await fs.readFile(invoice, "utf8")).replace(
							"sum + item.unitCents",
							"sum + item.unitCents * item.quantity",
						),
					)
				}
				const result = await execute(process.execPath, [script], { cwd: directory, windowsHide: true })
				assert.equal(result.stderr, "")
				assert.ok(result.stdout.trim() || fixture.id === "command-file-diff-live")
			}
		} finally {
			assert.equal(await fs.realpath(directory), directory)
			assert.match(path.basename(directory), /^alpha-prepared-command-/)
			await fs.rm(directory, { recursive: true, force: true })
		}
	}
})
