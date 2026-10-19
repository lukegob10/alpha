import { describe, expect, it } from "vitest"

import { snapshotVscodeLmThinking } from "../vscode-lm-thinking.js"

describe("snapshotVscodeLmThinking", () => {
	it("snapshots the JSON wire state without flattening values or interpreting metadata", () => {
		const source = {
			value: ["a", "b"],
			id: "block",
			metadata: { nested: { signature: "opaque" }, absent: undefined },
		}
		const snapshot = snapshotVscodeLmThinking(source)
		source.value.push("changed")
		source.metadata.nested.signature = "changed"
		expect(snapshot).toEqual({ value: ["a", "b"], id: "block", metadata: { nested: { signature: "opaque" } } })
	})

	it.each([
		{ signature: BigInt(1) },
		{ signature: () => "opaque" },
		{ signature: Symbol("opaque") },
		{ signature: Number.NaN },
		{ signature: new Date(0) },
		{ toJSON: () => null },
		[],
	])("rejects metadata that cannot round-trip as an object unchanged: %#", (metadata) => {
		expect(snapshotVscodeLmThinking({ value: "", metadata })).toBeUndefined()
	})

	it("bounds malformed cyclic and excessively deep metadata without throwing", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(snapshotVscodeLmThinking({ value: "", metadata: cyclic })).toBeUndefined()
		let deep: Record<string, unknown> = {}
		for (let index = 0; index < 70; index++) deep = { nested: deep }
		expect(snapshotVscodeLmThinking({ value: "", metadata: deep })).toBeUndefined()
	})

	it("rejects sparse arrays before they expand during JSON serialization", () => {
		expect(snapshotVscodeLmThinking({ value: new Array(2) })).toBeUndefined()
		expect(snapshotVscodeLmThinking({ value: "", metadata: { sparse: new Array(1_000_000) } })).toBeUndefined()
	})

	it("rejects hidden serialization hooks and malformed getters without throwing", () => {
		const metadata = Object.defineProperty({}, "toJSON", { value: () => null })
		expect(snapshotVscodeLmThinking({ value: "", metadata })).toBeUndefined()
		const malformed = Object.defineProperty({}, "value", {
			get: () => {
				throw new Error("invalid")
			},
		})
		expect(snapshotVscodeLmThinking(malformed)).toBeUndefined()
	})
})
