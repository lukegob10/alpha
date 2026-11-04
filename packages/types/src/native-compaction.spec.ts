import { describe, expect, it } from "vitest"

import { MAX_NATIVE_COMPACTION_CHARACTERS, snapshotNativeCompactionCheckpoint } from "./native-compaction.js"

function checkpoint() {
	return {
		protocol: "openai-responses",
		provider: "openai-native",
		modelId: "gpt-6.1-sol",
		responseId: "compact-1",
		output: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Keep this requirement." }] },
			{ type: "compaction", id: "checkpoint-1", encrypted_content: "opaque-native-checkpoint" },
		],
	}
}

describe("native compaction checkpoint", () => {
	it("snapshots the entire canonical output window without pruning retained fields", () => {
		const source = checkpoint()
		const result = snapshotNativeCompactionCheckpoint(source)
		expect(result).toEqual(source)
		expect(result?.output).not.toBe(source.output)
		const first = source.output[0]
		if (!first) throw new Error("Missing retained fixture item")
		first.role = "assistant"
		expect(result?.output[0]?.role).toBe("user")
	})

	it.each(["", undefined, 42])("rejects invalid encrypted content (%s)", (encrypted_content) => {
		const source = checkpoint()
		expect(
			snapshotNativeCompactionCheckpoint({
				...source,
				output: [{ type: "compaction", encrypted_content }],
			}),
		).toBeUndefined()
	})

	it("rejects missing or duplicate compaction items", () => {
		const source = checkpoint()
		expect(snapshotNativeCompactionCheckpoint({ ...source, output: [source.output[0]] })).toBeUndefined()
		expect(
			snapshotNativeCompactionCheckpoint({ ...source, output: [...source.output, source.output[1]] }),
		).toBeUndefined()
	})

	it("rejects unsupported protocols, excessive payloads, and non-JSON values", () => {
		const source = checkpoint()
		expect(snapshotNativeCompactionCheckpoint({ ...source, provider: "openai-codex" })).toBeUndefined()
		expect(
			snapshotNativeCompactionCheckpoint({
				...source,
				output: [{ type: "compaction", encrypted_content: "x".repeat(MAX_NATIVE_COMPACTION_CHARACTERS + 1) }],
			}),
		).toBeUndefined()
		expect(
			snapshotNativeCompactionCheckpoint({ ...source, output: [{ ...source.output[1], usage: NaN }] }),
		).toBeUndefined()
	})
	it("rejects non-plain objects and excessively deep input before parsing provider items", () => {
		const source = checkpoint()
		for (const value of [new Date(), new Map(), new Set()]) {
			expect(
				snapshotNativeCompactionCheckpoint({ ...source, output: [{ ...source.output[1], value }] }),
			).toBeUndefined()
		}
		let nested: unknown = "end"
		for (let depth = 0; depth < 40; depth++) nested = { nested }
		expect(
			snapshotNativeCompactionCheckpoint({ ...source, output: [{ ...source.output[1], nested }] }),
		).toBeUndefined()
	})
})
