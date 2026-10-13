import { describe, expect, it } from "vitest"

import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { AgentResponseItem } from "../AgentResponse"
import { AgentResponseAccumulator } from "../AgentResponseAccumulator"

describe("assistant message metadata", () => {
	it.each(["commentary", "partial_answer", "final_answer"] as const)(
		"retains %s, the original message ID, and output position through serialization",
		async (phase) => {
			const accumulator = new AgentResponseAccumulator()
			await accumulator.add({ type: "text", text: "Message.", id: "msg/original", phase, outputIndex: 0 })
			const response = await accumulator.finish()

			expect(JSON.parse(JSON.stringify(response)).items).toEqual([
				{ type: "text", text: "Message.", id: "msg/original", phase, outputIndex: 0 },
			])
			expect(response.text).toBe("Message.")
			expect(response.outcome).toBeUndefined()
		},
	)

	it("reconciles late message metadata across its deltas without repeating text or changing adjacent messages", async () => {
		const accumulator = new AgentResponseAccumulator()
		const observed: AgentResponseItem[] = []
		const onItem = (item: AgentResponseItem) => {
			observed.push(item)
		}
		await accumulator.add({ type: "text", text: "Checking ", outputIndex: 0 }, onItem)
		await accumulator.add({ type: "text", text: "the file.", outputIndex: 0 }, onItem)
		await accumulator.add({ type: "text", text: "Done.", id: "answer", outputIndex: 2 }, onItem)
		await accumulator.add({ type: "message_metadata", id: "preamble", phase: "commentary", outputIndex: 0 }, onItem)
		await accumulator.add({ type: "message_metadata", id: "answer", phase: "final_answer" }, onItem)
		await accumulator.add({ type: "message_metadata", id: "preamble", phase: "commentary", outputIndex: 0 }, onItem)
		const response = await accumulator.finish()

		expect(response.items).toEqual([
			{ type: "text", text: "Checking ", id: "preamble", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "the file.", id: "preamble", phase: "commentary", outputIndex: 0 },
			{ type: "text", text: "Done.", id: "answer", phase: "final_answer", outputIndex: 2 },
		])
		expect(observed).toEqual(response.items)
		expect(observed).toHaveLength(3)
		expect(response.text).toBe("Checking the file.Done.")
	})

	it("uses metadata announced before text and links ID-only deltas to their later output position", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "message_metadata", id: "first", phase: "partial_answer", outputIndex: 0 })
		await accumulator.add({ type: "text", text: "First.", outputIndex: 0 })
		await accumulator.add({ type: "text", text: "Second ", id: "second" })
		await accumulator.add({ type: "text", text: "answer.", outputIndex: 1 })
		await accumulator.add({ type: "message_metadata", id: "second", phase: "final_answer", outputIndex: 1 })

		expect((await accumulator.finish()).items).toEqual([
			{ type: "text", text: "First.", id: "first", phase: "partial_answer", outputIndex: 0 },
			{ type: "text", text: "Second ", id: "second", phase: "final_answer", outputIndex: 1 },
			{ type: "text", text: "answer.", id: "second", phase: "final_answer", outputIndex: 1 },
		])
	})

	it("ignores uncorrelated or conflicting late metadata rather than assigning it to another message", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "text", text: "First.", id: "first", outputIndex: 0 })
		await accumulator.add({ type: "text", text: "Second.", id: "second", outputIndex: 1 })
		await accumulator.add({ type: "message_metadata", phase: "final_answer" })
		await accumulator.add({ type: "message_metadata", id: "second", phase: "final_answer", outputIndex: 0 })

		expect((await accumulator.finish()).items).toEqual([
			{ type: "text", text: "First.", id: "first", outputIndex: 0 },
			{ type: "text", text: "Second.", id: "second", outputIndex: 1 },
		])
	})

	it("keeps the legacy unknown-phase fallback while preserving independently valid message identity", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "text", text: "Legacy." })
		await accumulator.add({
			type: "text",
			text: "Future.",
			id: "future",
			phase: "future_phase",
			outputIndex: 1,
		} as unknown as ApiStreamChunk)

		expect((await accumulator.finish()).items).toEqual([
			{ type: "text", text: "Legacy." },
			{ type: "text", text: "Future.", id: "future", outputIndex: 1 },
		])
	})

	it.each(["cancelled", "failed", "incomplete"] as const)(
		"does not use a final-answer phase to erase a %s response",
		async (status) => {
			const accumulator = new AgentResponseAccumulator()
			await accumulator.add({ type: "text", text: "Answer.", id: "message", outputIndex: 0 })
			await accumulator.add({ type: "message_metadata", id: "message", phase: "final_answer", outputIndex: 0 })
			const response = await accumulator.finish(undefined, { status })

			expect(response.outcome).toEqual({ status })
			expect(response.items).toEqual([
				{ type: "text", text: "Answer.", id: "message", phase: "final_answer", outputIndex: 0 },
			])
		},
	)
})
