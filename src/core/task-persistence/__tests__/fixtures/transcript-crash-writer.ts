import * as fs from "fs/promises"
import * as path from "path"

import { saveApiMessages, type ApiMessage } from "../../apiMessages"
import { ProviderTranscriptStore } from "../../ProviderTranscriptStore"
import { TaskRewindStore } from "../../TaskRewindStore"
import { saveTaskMessages } from "../../taskMessages"
import type { AlphaMessage } from "@alpha-code/types"

interface FixtureInput {
	taskId: string
	assistant: ApiMessage[]
	complete: ApiMessage[]
	rewound: ApiMessage[]
	uiRewound: AlphaMessage[]
}

const storage = process.argv[2]
const phase = process.argv[3]
// Keep the IPC channel owned until the parent kills this process at the reported barrier.
process.on("message", () => undefined)
const pause = async () => {
	process.send?.({ kind: "ready", phase })
	await new Promise<void>(() => undefined)
}

async function main() {
	const fixture: FixtureInput = JSON.parse(await fs.readFile(path.join(storage, "fixture.json"), "utf8"))
	const store = new ProviderTranscriptStore(fixture.taskId, storage)
	const options = { taskId: fixture.taskId, globalStoragePath: storage }
	if (phase.startsWith("rewind-")) {
		const rewind = new TaskRewindStore(storage, fixture.taskId)
		const record = await rewind.begin(fixture.uiRewound, fixture.rewound, {
			runId: "crash-run",
			turnId: "removed-turn",
			toolCallIds: ["removed-call"],
		})
		if (phase === "rewind-receipt") await pause()
		await saveTaskMessages({ ...options, messages: fixture.uiRewound })
		if (phase === "rewind-ui") await pause()
		const receipt = await saveApiMessages({ ...options, messages: fixture.rewound })
		await store.commitAuthoritativeTranscript(receipt)
		if (phase === "rewind-api") await pause()
		await rewind.complete(record.rewindId)
		if (phase === "rewind-complete") await pause()
		throw new Error("Unknown rewind crash boundary")
	}

	let write: "assistant" | "result" | "sidecar" = "assistant"
	// Only the barrier is substituted. Every write, sync, close, and rename otherwise uses the real filesystem.
	const filesystem: typeof import("fs/promises") = require("fs/promises")
	const open = filesystem.open
	filesystem.open = async (target, flags, mode) => {
		const handle = await open(target, flags, mode)
		if (
			phase === "assistant-partial-temp" &&
			path.basename(String(target)).startsWith(".api_conversation_history.json.new_")
		) {
			await handle.writeFile('{"partial":', "utf8")
			await pause()
		}
		return handle
	}
	const rename = filesystem.rename
	filesystem.rename = async (source, destination) => {
		const basename = path.basename(String(destination))
		if (
			(phase === "assistant-before-rename" &&
				write === "assistant" &&
				basename === "api_conversation_history.json") ||
			(phase === "result-before-rename" && write === "result" && basename === "api_conversation_history.json") ||
			(phase === "sidecar-before-rename" && write === "sidecar" && basename === "provider_transcript.json")
		) {
			await pause()
		}
		await rename(source, destination)
	}
	const assistant = await saveApiMessages({ ...options, messages: fixture.assistant })
	await store.commitAuthoritativeTranscript(assistant)
	if (phase === "assistant-committed") await pause()
	// A dummy local effect is deliberately outside transcript persistence. Recovery must not invent its outcome.
	await fs.appendFile(path.join(storage, "effect.log"), "committed\n")
	if (phase === "effect-committed") await pause()
	write = "result"
	const result = await saveApiMessages({ ...options, messages: fixture.complete })
	if (phase === "result-committed") await pause()
	write = "sidecar"
	await store.commitAuthoritativeTranscript(result)
	if (phase === "sidecar-committed") await pause()
	throw new Error("Unknown transcript crash boundary")
}

main().catch(() => {
	process.send?.({ kind: "failed", phase })
	process.exitCode = 1
	if (process.connected) process.disconnect()
})
