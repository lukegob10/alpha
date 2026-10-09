import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"

describe("large streamed tool arguments", () => {
	let storage: string
	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-large-arguments-"))
	})
	afterEach(async () => {
		if (
			path.dirname(storage) !== path.resolve(os.tmpdir()) ||
			!path.basename(storage).startsWith("alpha-large-arguments-")
		)
			throw new Error("Unexpected fixture storage path")
		await fs.rm(storage, { recursive: true, force: true })
	})

	it.each(["freeform", "json"] as const)(
		"preserves a large %s patch through stream assembly, save, and reload",
		async (transport) => {
			const patch = `*** Begin Patch\n*** Add File: large.txt\n${'+quoted "text" \\ emoji 😀\n'.repeat(5_000)}*** End Patch\n`
			expect(Buffer.byteLength(patch, "utf8")).toBeGreaterThan(100_000)
			const wireArguments = transport === "json" ? JSON.stringify({ patch }) : patch
			const accumulator = new AgentResponseAccumulator()
			await accumulator.add({ type: "tool_call_start", id: "large-patch", name: "apply_patch" })
			// Split escapes and Unicode code units as real streamed deltas may do.
			for (let offset = 0; offset < wireArguments.length; offset += 127) {
				await accumulator.add({
					type: "tool_call_delta",
					id: "large-patch",
					delta: wireArguments.slice(offset, offset + 127),
				})
			}
			await accumulator.add({ type: "tool_call_end", id: "large-patch" })
			const response = await accumulator.finish()
			expect(response.toolCalls).toEqual([
				{ type: "tool_call", id: "large-patch", name: "apply_patch", arguments: { patch } },
			])
			const messages: ApiMessage[] = [
				{ role: "user", content: "Apply the reviewed patch." },
				{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "large-patch", content: "Review denied", is_error: true },
					],
				},
			]
			await saveApiMessages({ taskId: "large-arguments", globalStoragePath: storage, messages })
			expect(await readApiMessages({ taskId: "large-arguments", globalStoragePath: storage })).toEqual(messages)
		},
	)
})
