import { AgentResponseAccumulator } from "../AgentResponseAccumulator"

describe("WS06 interrupted response tool boundaries", () => {
	it("discards unfinished valid JSON intent while retaining completed calls in their source positions", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "text", text: "Before." })
		await accumulator.add({
			type: "tool_call_partial",
			index: 0,
			id: "discarded-before",
			name: "read_file",
			arguments: '{"path":"before.txt"}',
		})
		await accumulator.add({ type: "text", text: "Between." })
		await accumulator.add({
			type: "tool_call_partial",
			index: 1,
			id: "retained",
			name: "read_file",
			arguments: '{"path":"retained.txt"}',
		})
		await accumulator.add({ type: "tool_call_end", id: "retained" })
		await accumulator.add({
			type: "tool_call_partial",
			index: 2,
			id: "discarded-after",
			name: "read_file",
			arguments: '{"path":"after.txt"}',
		})
		await accumulator.add({ type: "text", text: "After." })
		const result = await accumulator.finish(undefined, { status: "completed", requiresContinuation: true })

		expect(result.items).toEqual([
			{ type: "text", text: "Before." },
			{ type: "text", text: "Between." },
			{ type: "tool_call", id: "retained", name: "read_file", arguments: { path: "retained.txt" } },
			{ type: "text", text: "After." },
		])
		expect(result.toolCalls.map((call) => call.id)).toEqual(["retained"])
		expect(result.outcome).toEqual({ status: "completed", requiresContinuation: true })
	})

	it("retains a complete payload chunk without requiring a redundant end marker", async () => {
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({
			type: "tool_call",
			id: "complete",
			name: "read_file",
			arguments: '{"path":"file.txt"}',
		})
		const result = await accumulator.finish(undefined, { status: "completed", requiresContinuation: true })

		expect(result.toolCalls).toEqual([
			{ type: "tool_call", id: "complete", name: "read_file", arguments: { path: "file.txt" } },
		])
		expect(result.outcome).toEqual({ status: "completed", requiresContinuation: true })
	})

	it.each(["complete payload", "end marker"])(
		"retains a correlated rejected call from a malformed %s",
		async (completion) => {
			const accumulator = new AgentResponseAccumulator()
			if (completion === "complete payload") {
				await accumulator.add({ type: "tool_call", id: "malformed", name: "read_file", arguments: '{"path":' })
			} else {
				await accumulator.add({
					type: "tool_call_partial",
					index: 0,
					id: "malformed",
					name: "read_file",
					arguments: '{"path":',
				})
				await accumulator.add({ type: "tool_call_end", id: "malformed" })
			}
			const result = await accumulator.finish(undefined, { status: "completed", requiresContinuation: true })

			expect(result.toolCalls).toEqual([
				{
					type: "tool_call",
					id: "malformed",
					name: "read_file",
					arguments: {},
					argumentParseError: 'Unable to parse arguments for tool call "read_file" (malformed).',
					rawArguments: '{"path":',
				},
			])
			expect(result.items.some((item) => item.type === "error")).toBe(false)
			expect(result.outcome).toEqual({ status: "completed", requiresContinuation: true })
		},
	)

	it("fails conflicting persisted identities even when finalized calls were not accepted early", async () => {
		const accumulator = new AgentResponseAccumulator()
		for (const [index, id] of ["call/a", "call:a"].entries()) {
			await accumulator.add({
				type: "tool_call_partial",
				index,
				id,
				name: "read_file",
				arguments: '{"path":"file.txt"}',
			})
			await accumulator.add({ type: "tool_call_end", id })
		}
		const result = await accumulator.finish(undefined, { status: "completed", requiresContinuation: true })

		expect(result.toolCalls).toHaveLength(1)
		expect(result.items).toContainEqual(
			expect.objectContaining({ type: "error", callId: "call:a", retryable: false }),
		)
		expect(result.outcome).toMatchObject({ status: "failed", retryable: false })
	})

	it.each([undefined, { status: "completed" as const }])(
		"preserves ordinary completion semantics (%j)",
		async (outcome) => {
			const accumulator = new AgentResponseAccumulator()
			await accumulator.add({
				type: "tool_call_partial",
				index: 0,
				id: "legacy",
				name: "read_file",
				arguments: '{"path":"file.txt"}',
			})
			const result = await accumulator.finish(undefined, outcome)

			expect(result.toolCalls).toEqual([
				{ type: "tool_call", id: "legacy", name: "read_file", arguments: { path: "file.txt" } },
			])
		},
	)
})
