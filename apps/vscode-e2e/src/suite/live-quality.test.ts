import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { LIVE_QUALITY_CASES, scoreQuality, visibleAnswer } from "../quality/liveQuality"
import { runLiveCase } from "./live-file-tool-support"

suite("Live short-task correctness and trajectory", function () {
	this.timeout(200_000)

	for (const item of LIVE_QUALITY_CASES) {
		test(item.id, async () => {
			await runLiveCase(
				item.id,
				[...item.tools],
				{ ...item.files },
				item.prompt,
				async (calls, _messages, workspace, _transcript, _task, finalAssistantText, finalAssistantCalls) => {
					const expectedFiles = item.expectedFiles ?? item.files
					const finalFiles: Record<string, string> = {}
					for (const relative of Object.keys(expectedFiles))
						finalFiles[relative] = await fs.readFile(path.join(workspace, relative), "utf8")
					const report = scoreQuality(item, {
						answer: visibleAnswer(finalAssistantCalls, finalAssistantText),
						calls,
						workspace,
						finalFiles,
					})
					const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
					if (artifacts) {
						await fs.writeFile(
							path.join(artifacts, `${item.id}.quality.json`),
							JSON.stringify(report, null, 2),
							{
								flag: "wx",
							},
						)
					}
					assert.ok(
						process.env.ALPHA_E2E_QUALITY_CAPTURE === "1" ? report.correctnessPassed : report.passed,
						report.scores
							.map(
								(score) => `${score.dimension}/${score.name}=${score.value.toFixed(2)} ${score.reason}`,
							)
							.join("; "),
					)
					for (const [relative, content] of Object.entries(expectedFiles))
						assert.equal(
							await fs.readFile(path.join(workspace, relative), "utf8"),
							content,
							`Quality probe final content differs: ${relative}`,
						)
					const directory = path.dirname(item.sourcePath)
					const actualFiles = (
						await fs.readdir(path.join(workspace, directory), { recursive: true, withFileTypes: true })
					)
						.filter((entry) => entry.isFile())
						.map((entry) =>
							path.relative(workspace, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
						)
					assert.deepEqual(
						actualFiles.sort(),
						Object.keys(expectedFiles).sort(),
						"Quality probe created unrelated files",
					)
				},
				{
					scope: item.scope,
					commands: ["node", "rg", "cut", "cat", "type", "Get-Content"],
					requestLimit: item.requestLimit,
				},
			)
		})
	}
})
