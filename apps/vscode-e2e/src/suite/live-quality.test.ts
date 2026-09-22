import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { LIVE_QUALITY_CASES, scoreQuality, visibleAnswer } from "../quality/liveQuality"
import { runLiveCase } from "./live-file-tool-support"

suite("Live Copilot groundedness and trajectory", function () {
	this.timeout(200_000)

	for (const item of LIVE_QUALITY_CASES) {
		test(item.id, async () => {
			await runLiveCase(
				item.id,
				[...item.tools],
				{ ...item.files },
				item.prompt,
				async (calls, _messages, _workspace, transcript) => {
					const report = scoreQuality(item, {
						answer: visibleAnswer(calls, transcript),
						calls,
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
						report.passed,
						report.scores
							.map(
								(score) => `${score.dimension}/${score.name}=${score.value.toFixed(2)} ${score.reason}`,
							)
							.join("; "),
					)
				},
				{ scope: item.scope, requestLimit: item.requestLimit },
			)
		})
	}
})
