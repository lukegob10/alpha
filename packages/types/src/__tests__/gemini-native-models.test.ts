import {
	geminiDefaultModelId,
	geminiModels,
	geminiResponseSchema,
	snapshotGeminiResponse,
} from "../providers/gemini.js"

describe("native Gemini model capabilities", () => {
	it("uses a small explicit native model catalog", () => {
		expect(geminiDefaultModelId).toBe("gemini-4-argon")
		expect(Object.keys(geminiModels)).toEqual(["gemini-4-argon"])
	})

	it.each(Object.entries(geminiModels))("declares only verified reasoning choices for %s", (_id, info) => {
		expect(info.supportsReasoningEffort).toEqual(["low", "medium", "high"])
		expect(info.reasoningEffort).toBe("medium")
		expect(info.requiredReasoningEffort).toBe(true)
		expect(info.supportsTemperature).toBe(false)
		expect(info.maxTokens).toBe(65_536)
		expect(info.contextWindow).toBe(1_048_576)
	})

	it("keeps Argon's unified input and output context explicit", () => {
		expect(geminiModels["gemini-4-argon"].contextWindowIncludesOutput).toBe(true)
	})
})

describe("Gemini response replay boundary", () => {
	it("preserves a defensive copy of signed and opaque provider fields", () => {
		const state = {
			modelId: "gemini-4-argon",
			parts: [{ text: "", thoughtSignature: "signature", providerMetadata: { nested: [true, null, 1] } }],
		}
		const snapshot = snapshotGeminiResponse(state)
		expect(snapshot).toEqual(state)
		state.parts[0]!.providerMetadata.nested.push(false)
		expect(snapshot?.parts[0]?.providerMetadata).toEqual({ nested: [true, null, 1] })
	})

	it.each([undefined, () => true, Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Map()])(
		"rejects non-JSON opaque metadata (%s)",
		(value) => {
			const state = { modelId: "gemini-4-argon", parts: [{ text: "", metadata: value }] }
			expect(geminiResponseSchema.safeParse(state).success).toBe(false)
			expect(snapshotGeminiResponse(state)).toBeUndefined()
		},
	)

	it("rejects circular provider state without invoking accessors or toJSON", () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		const getter = vi.fn(() => "signature")
		const opaque = Object.defineProperty({}, "signature", { enumerable: true, get: getter })
		for (const metadata of [circular, opaque]) {
			expect(snapshotGeminiResponse({ modelId: "gemini-4-argon", parts: [{ metadata }] })).toBeUndefined()
		}
		expect(getter).not.toHaveBeenCalled()
	})

	it("preserves own JSON __proto__ keys in signed arguments and opaque part metadata", () => {
		const state = JSON.parse(
			'{"modelId":"gemini-4-argon","parts":[{"functionCall":{"name":"tool","args":{"__proto__":{"path":"a.ts"}}},"thoughtSignature":"signature","__proto__":{"version":1}}]}',
		)
		const snapshot = snapshotGeminiResponse(state)
		expect(snapshot).toEqual(state)
		expect(Object.hasOwn(snapshot!.parts[0]!.functionCall!.args!, "__proto__")).toBe(true)
		expect(Object.hasOwn(snapshot!.parts[0]!, "__proto__")).toBe(true)
		expect(geminiResponseSchema.parse(state)).toEqual(state)
	})

	it("rejects oversized or empty response state", () => {
		expect(snapshotGeminiResponse({ modelId: "gemini-4-argon", parts: [] })).toBeUndefined()
		expect(
			snapshotGeminiResponse({ modelId: "gemini-4-argon", parts: [{ text: "x".repeat(16 * 1024 * 1024) }] }),
		).toBeUndefined()
	})
})
