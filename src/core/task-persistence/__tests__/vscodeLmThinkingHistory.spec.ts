import { describe, expect, it } from "vitest"
import { isApiStreamSemanticChunk } from "../../../api/transform/stream"

import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

describe("VS Code thinking history", () => {
	it("keeps host-only metadata out of semantic output while retaining other reasoning contracts", () => {
		const state = { value: "", id: "host", metadata: { signature: "opaque" } }
		expect(isApiStreamSemanticChunk({ type: "reasoning", text: "", vscodeLmThinking: state })).toBe(false)
		expect(isApiStreamSemanticChunk({ type: "reasoning", text: "Visible", vscodeLmThinking: state })).toBe(true)
		expect(isApiStreamSemanticChunk({ type: "reasoning", text: "", encryptedContent: "opaque" })).toBe(true)
	})
	it("retains ordered provider state independently of the display projection", async () => {
		const accumulator = new AgentResponseAccumulator()
		const state = { value: ["First", "Second"], id: "thinking-1", metadata: { nested: { signature: "opaque" } } }
		await accumulator.add({ type: "reasoning", text: "First\nSecond", vscodeLmThinking: state })
		await accumulator.add({ type: "text", text: "Checking." })
		await accumulator.add({ type: "tool_call", id: "call-1", name: "read_file", arguments: "{}" })
		const completion = { value: "", id: "thinking-1", metadata: { vscode_reasoning_done: true } }
		await accumulator.add({ type: "reasoning", text: "", vscodeLmThinking: completion })
		state.value.push("External mutation")
		state.metadata.nested.signature = "Changed"
		const response = await accumulator.finish()
		expect(response.reasoning).toBe("First\nSecond")
		expect(response.text).toBe("Checking.")
		const content = JSON.parse(JSON.stringify(buildCanonicalAssistantHistoryContent(response)))
		expect(content).toEqual([
			{
				type: "vscode_lm_thinking",
				value: ["First", "Second"],
				id: "thinking-1",
				metadata: { nested: { signature: "opaque" } },
			},
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: "call-1", name: "read_file", input: {} },
			{ type: "vscode_lm_thinking", ...completion },
		])
		expect(invalidPersistedApiMessages([{ role: "assistant", content }])).toBeUndefined()
	})

	it("retains metadata-only state after cancellation without changing the terminal outcome", async () => {
		const accumulator = new AgentResponseAccumulator()
		const state = { value: "", id: "thinking-2", metadata: { signature: "opaque", _completeThinking: true } }
		await accumulator.add({ type: "reasoning", text: "", vscodeLmThinking: state })
		await accumulator.add({ type: "outcome", status: "cancelled", terminal: true, semanticOutputObserved: false })
		const response = await accumulator.finish()
		expect(response.outcome?.status).toBe("cancelled")
		expect(response.text).toBe("")
		expect(response.reasoning).toBe("")
		expect(buildCanonicalAssistantHistoryContent(response)).toEqual([{ type: "vscode_lm_thinking", ...state }])
	})

	it.each([{ value: 1 }, { value: ["valid", false] }, { value: "", id: 1 }, { value: "", metadata: [] }])(
		"rejects malformed persisted provider state: %j",
		(state) => {
			expect(
				invalidPersistedApiMessages([
					{ role: "assistant", content: [{ type: "vscode_lm_thinking", ...state }] },
				]),
			).toContain("invalid VS Code thinking")
		},
	)
})
