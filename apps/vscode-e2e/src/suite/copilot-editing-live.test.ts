import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { LiveResponseProbe } from "../scenarios/liveResponseProbe"
import { record, runLiveCase } from "./live-file-tool-support"

// Keep the available tools, user requests and byte oracles fixed across reference/candidate builds.
const fixtures: Array<{ id: string; before: Record<string, string>; after: Record<string, string>; request: string }> =
	[
		{
			id: "duplicate",
			before: { "limits.ts": "export const fast = { limit: 12 }\nexport const slow = { limit: 12 }\n" },
			after: { "limits.ts": "export const fast = { limit: 12 }\nexport const slow = { limit: 24 }\n" },
			request: "Change only the slow limit in limits.ts to 24.",
		},
		{
			id: "windows",
			before: { "app.ini": "\uFEFF[ui]\r\nlabel=old\r\nkeep=on" },
			after: { "app.ini": "\uFEFF[ui]\r\nlabel=$1 & $&\r\nkeep=on" },
			request:
				"Set label in app.ini to the literal value `$1 & $&`. Preserve its BOM, CRLF and absent final newline.",
		},
		{
			id: "two-files",
			before: { "client.ts": "export const retries = 2\n", "worker.ts": "export const retries = 2\n" },
			after: { "client.ts": "export const retries = 4\n", "worker.ts": "export const retries = 4\n" },
			request: "Set retries to 4 in both client.ts and worker.ts.",
		},
	]

suite("Live Copilot editor choice", function () {
	this.timeout(180_000)
	for (const fixture of fixtures) {
		test(fixture.id, async () => {
			const directory = `editor-choice/${fixture.id}`
			const inspect = `node ${directory}/inspect.cjs`
			const files: Record<string, string> = {
				...fixture.before,
				"neighbor.txt": "untouched\n",
				"inspect.cjs": `const fs = require("node:fs"), path = require("node:path")\nfor (const name of ${JSON.stringify(Object.keys(fixture.before))}) console.log(name, JSON.stringify(fs.readFileSync(path.join(__dirname, name), "utf8")))\n`,
			}
			const usage: Array<{ request: number; input: number; output: number }> = []
			const probe = new LiveResponseProbe((part, request) => {
				if (
					!part ||
					typeof part !== "object" ||
					!("mimeType" in part) ||
					part.mimeType !== "usage" ||
					!("data" in part) ||
					!(part.data instanceof Uint8Array)
				)
					return
				const dto = record(JSON.parse(new TextDecoder().decode(part.data)))
				const input = dto.prompt_tokens ?? dto.input_tokens
				const output = dto.completion_tokens ?? dto.output_tokens
				if (typeof input === "number" && typeof output === "number") usage.push({ request, input, output })
			})
			let advertised: string[] | undefined
			await runLiveCase(
				`editor-choice-${fixture.id}`,
				["exec_command", "apply_patch", "edit", "search_and_replace", "navigate_code"],
				Object.fromEntries(Object.entries(files).map(([file, value]) => [`${directory}/${file}`, value])),
				`${fixture.request} Use the file editor supplied for this task. The read-only command ${inspect} displays the input files.`,
				async (calls, _messages, workspace) => {
					assert.ok(calls.some(({ name }) => name === "apply_patch" || name === "edit"))
					const target = path.join(workspace, directory)
					assert.deepEqual((await fs.readdir(target)).sort(), Object.keys(files).sort())
					for (const [file, content] of Object.entries({ ...files, ...fixture.after })) {
						assert.deepEqual(await fs.readFile(path.join(target, file)), Buffer.from(content), file)
					}
					await fs.writeFile(
						path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, `editor-choice-${fixture.id}-usage.json`),
						JSON.stringify({ advertised, usage }),
						{ flag: "wx" },
					)
				},
				{
					scope: `Work only in ${directory}. Preserve unrelated files and bytes.`,
					commands: [inspect],
					requestLimit: 8,
					responseProbe: probe,
					onTaskRequest: (_client, _messages, options) => {
						const tools = record(options).tools
						if (!advertised && Array.isArray(tools))
							advertised = tools.map((tool) => String(record(tool).name))
					},
				},
			)
		})
	}
})
