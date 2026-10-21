import { parentPort, workerData } from "node:worker_threads"

import type {
	CommandOutputSearchBatch,
	CommandOutputSearchBatchResult,
} from "../core/tools/helpers/commandOutputSearch"

const pattern: unknown = workerData
if (typeof pattern !== "string") throw new Error("Invalid command output search pattern")

let regex: RegExp
try {
	regex = new RegExp(pattern, "i")
} catch {
	regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
}

parentPort?.on("message", (batch: CommandOutputSearchBatch) => {
	const matchedLineIndices: number[] = []
	let remainingBytes = batch.remainingBytes
	let hasMatches = batch.hasMatches
	let processedLineCount = 0
	for (let index = 0; index < batch.lines.length; index++) {
		processedLineCount++
		const line = batch.lines[index]
		if (!regex.test(line)) continue
		matchedLineIndices.push(index)
		const prefix = `${String(batch.firstLineNumber + index).padStart(5)} | `
		const renderedBytes = (hasMatches ? 1 : 0) + Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(line, "utf8")
		// Stop at the same output boundary as the caller. Later lines must not
		// consume regex time or move pagination beyond the returned page.
		if (renderedBytes >= remainingBytes) break
		remainingBytes -= renderedBytes
		hasMatches = true
	}
	parentPort?.postMessage({ matchedLineIndices, processedLineCount } satisfies CommandOutputSearchBatchResult)
})
