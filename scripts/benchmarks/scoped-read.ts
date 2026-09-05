import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import { readWithSlice } from "../../src/integrations/misc/indentation-reader"

// An offline formatting workload, not a provider/task-quality or timing benchmark.
const samples = 3
const requestedLines = 20
const observations = [128, 8192, 65536].map((sourceLines) => {
	const lines = Array.from({ length: sourceLines }, (_, index) => `\t    const value${index} = () => {}`)
	const content = lines.join("\n")
	const offset = Math.floor(sourceLines / 2)
	const width = String(offset + requestedLines).length
	const expected = lines
		.slice(offset, offset + requestedLines)
		.map((line, index) => `${String(offset + index + 1).padStart(width, " ")} | ${line}`)
		.join("\n")
	const indentationAnalysisCalls: number[] = []
	let outputSha256 = ""
	for (let sample = 0; sample < samples; sample++) {
		let calls = 0
		const originalTrimStart = String.prototype.trimStart
		String.prototype.trimStart = function () {
			calls++
			return originalTrimStart.call(this)
		}
		let result: ReturnType<typeof readWithSlice>
		try {
			result = readWithSlice(content, offset, requestedLines)
		} finally {
			String.prototype.trimStart = originalTrimStart
		}
		assert.deepEqual(result, {
			content: expected,
			includedRanges: [[offset + 1, offset + requestedLines]],
			totalLines: sourceLines,
			returnedLines: requestedLines,
			wasTruncated: true,
		})
		indentationAnalysisCalls.push(calls)
		outputSha256 = createHash("sha256").update(JSON.stringify(result)).digest("hex")
	}
	return {
		sourceLines,
		requestedLines,
		indentationAnalysisCalls,
		outputBytes: Buffer.byteLength(expected),
		outputSha256,
	}
})

console.log(
	JSON.stringify(
		{
			benchmark: "scoped-read-formatting",
			node: process.version,
			samples,
			provider: "none",
			cache: "fresh input; no result cache",
			metric: "trimStart calls during slice formatting (one per analyzed source line in baseline)",
			observations,
		},
		null,
		2,
	),
)
