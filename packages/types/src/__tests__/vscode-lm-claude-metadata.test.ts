import { describe, expect, it } from "vitest"

import {
	getVscodeLlmContextWindow,
	getVscodeLlmExtendedContextSize,
	getVscodeLlmModelInfo,
	mergeVscodeLlmModels,
} from "../providers/vscode-llm.js"

// VS Code 1.125.0 LanguageModelChat.maxInputTokens is the request ceiling;
// Copilot's configured context size must never increase that advertised budget.
describe("Claude Copilot model metadata", () => {
	it.each(["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"])(
		"bounds %s standard and extended context by each live route's input limit",
		(family) => {
			const standard = { vendor: "copilot", family, id: "opaque-standard", maxInputTokens: 199_793 }
			const extended = { ...standard, id: "opaque-extended", maxInputTokens: 935_793 }
			const constrained = { ...standard, id: "opaque-constrained", maxInputTokens: 64_000 }

			expect(getVscodeLlmContextWindow(standard)).toBe(199_793)
			expect(getVscodeLlmExtendedContextSize(standard)).toBeUndefined()
			expect(getVscodeLlmContextWindow(standard, 936_000)).toBe(199_793)
			expect(getVscodeLlmContextWindow(extended)).toBe(200_000)
			expect(getVscodeLlmExtendedContextSize(extended)).toBe(936_000)
			expect(getVscodeLlmContextWindow(extended, 936_000)).toBe(935_793)
			expect(getVscodeLlmContextWindow(extended, 1_000_000)).toBe(200_000)
			expect(getVscodeLlmContextWindow(constrained, 936_000)).toBe(64_000)

			const original = [standard, extended, constrained]
			expect(mergeVscodeLlmModels(original)).toEqual(original)
		},
	)

	it.each(["claude-opus-5.50", "claude-sonnet-5.50", "claude-haiku-5.50"])(
		"uses live capacity without inheriting an older release's capabilities for %s",
		(family) => {
			const model = { vendor: "copilot", family, id: "future-opaque-route", maxInputTokens: 196_793 }

			expect(getVscodeLlmModelInfo(model)).toBeUndefined()
			expect(getVscodeLlmExtendedContextSize(model)).toBeUndefined()
			expect(getVscodeLlmContextWindow(model, 936_000)).toBe(196_793)
			expect(mergeVscodeLlmModels([model])).toEqual([model])
		},
	)

	it("keeps same-name Claude routes isolated by vendor and opaque ID", () => {
		const family = "claude-sonnet-5.5"
		const name = "Claude Sonnet 5.5"
		const routes = [
			{ vendor: "copilot", family, name, id: "route-a", maxInputTokens: 199_793 },
			{ vendor: "copilot", family, name, id: "route-b", maxInputTokens: 935_793 },
			{ vendor: "other", family, name, id: "route-a", maxInputTokens: 300_000 },
		]

		expect(mergeVscodeLlmModels(routes)).toEqual(routes)
		expect(getVscodeLlmModelInfo(routes[2]!)).toBeUndefined()
		expect(getVscodeLlmExtendedContextSize(routes[2]!)).toBeUndefined()
		expect(getVscodeLlmContextWindow(routes[2]!, 936_000)).toBe(300_000)
	})
})
