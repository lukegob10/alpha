import { snapshotProviderResponseItem } from "../provider-response-item.js"

const envelope = {
	protocol: "openai-responses",
	providerId: "openai-native",
	modelId: "gpt-6.1-sol",
	itemType: "message",
	id: "msg_source",
	status: "completed",
	content: [{ type: "output_text", length: 4, annotations: [], logprobs: [] }],
}

describe("bounded provider response item metadata", () => {
	it("snapshots only replay metadata without importing tool authority or private fields", () => {
		const source = {
			...structuredClone(envelope),
			name: "execute_command",
			arguments: "untrusted",
			encrypted_content: "private",
		}
		const copy = snapshotProviderResponseItem(source)
		expect(copy).toEqual(envelope)
		source.content[0]!.length = 99
		expect(copy?.content?.[0]).toEqual({ type: "output_text", length: 4, annotations: [], logprobs: [] })
	})

	it.each([
		{ ...envelope, protocol: "unknown" },
		{ ...envelope, id: "x".repeat(1_025) },
		{ ...envelope, content: [{ type: "output_text", length: -1 }] },
		{ ...envelope, content: [{ type: "output_text", length: 1, annotations: ["x".repeat(32_768)] }] },
		{ ...envelope, content: [{ type: "output_text", length: 1, annotations: [() => "invalid"] }] },
	])("ignores invalid optional metadata: %j", (value) => {
		expect(snapshotProviderResponseItem(value)).toBeUndefined()
	})

	it("rejects cyclic and deeply nested provider metadata", () => {
		const cyclic: unknown[] = []
		cyclic.push(cyclic)
		expect(
			snapshotProviderResponseItem({
				...envelope,
				content: [{ type: "output_text", length: 0, annotations: cyclic }],
			}),
		).toBeUndefined()
		const deep = Array.from({ length: 16 }).reduce<unknown>((value) => [value], "leaf")
		expect(
			snapshotProviderResponseItem({
				...envelope,
				content: [{ type: "output_text", length: 0, annotations: [deep] }],
			}),
		).toBeUndefined()
	})
})
