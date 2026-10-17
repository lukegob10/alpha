import { describe, expect, it } from "vitest"

import { serializeThreadResult } from "../serializeThreadResult"

describe("thread result serialization", () => {
	it("preserves a small result exactly", () => {
		const result = { threads: [{ id: "peer", title: "A task", status: "idle" }], nextCursor: "cursor" }
		expect(serializeThreadResult(result)).toBe(JSON.stringify(result))
	})

	it("bounds UTF-8 output without cutting JSON, IDs, or pagination cursors", () => {
		const threads = Array.from({ length: 50 }, (_, index) => ({
			id: `thread-${index}`,
			title: "😀".repeat(1_000),
			summary: "evidence".repeat(1_000),
			status: "idle",
			cwd: "long-workspace-name/".repeat(200),
		}))
		const text = serializeThreadResult({ threads, nextCursor: "complete-cursor-value" })
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8_000)
		const result = JSON.parse(text)
		expect(result.threads.map((thread: { id: string }) => thread.id)).toEqual(threads.map((thread) => thread.id))
		expect(result.nextCursor).toBe("complete-cursor-value")
		expect(result.truncated).toBe(true)
	})

	it("preserves the latest assistant answer before shrinking supporting history", () => {
		const result = JSON.parse(
			serializeThreadResult({
				thread: { id: "peer" },
				turns: [
					{
						id: "turn",
						items: [
							{ type: "toolResult", id: "large", text: "x".repeat(40_000) },
							{ type: "agentMessage", id: "answer", text: "Verified outcome." },
						],
					},
				],
			}),
		)
		expect(result.turns[0].items).toEqual([{ type: "agentMessage", id: "answer", text: "Verified outcome." }])
	})

	it("also honors a smaller remaining character budget", () => {
		const text = serializeThreadResult({ thread: { id: "peer" }, message: "large".repeat(4_000) }, 300)
		expect(text.length).toBeLessThanOrEqual(300)
		expect(JSON.parse(text).thread.id).toBe("peer")
		expect(() => serializeThreadResult({ id: "immutable-thread-identity" }, 5)).toThrow("metadata exceeds")
	})
})
