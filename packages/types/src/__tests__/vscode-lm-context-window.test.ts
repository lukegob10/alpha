import { describe, expect, it } from "vitest"

import { getVscodeLlmContextWindow, getVscodeLlmExtendedContextSize } from "../providers/vscode-llm.js"

describe("VS Code LM context window", () => {
	const selector = { vendor: "copilot", family: "claude-opus-4.7" }

	it.each([
		[undefined, 200_000],
		[200_000, 200_000],
		[936_000, 936_000],
		[922_000, 200_000],
		[1_000_000, 200_000],
	])("previews the supported saved selection %s before discovery", (configuredSize, expected) => {
		expect(getVscodeLlmContextWindow(selector, configuredSize)).toBe(expected)
	})

	it.each([
		[935_793, undefined, 200_000],
		[935_793, 200_000, 200_000],
		[935_793, 936_000, 935_793],
		[200_000, 936_000, 200_000],
		[199_793, 936_000, 199_793],
		[Number.NaN, 936_000, 200_000],
		[Number.POSITIVE_INFINITY, 936_000, 200_000],
		[0, 936_000, 200_000],
		[-1, 936_000, 200_000],
	])("constrains live input limit %s with selection %s", (maxInputTokens, configuredSize, expected) => {
		expect(getVscodeLlmContextWindow({ ...selector, maxInputTokens }, configuredSize)).toBe(expected)
	})

	it("does not apply Copilot settings to another vendor or an unsupported model", () => {
		expect(getVscodeLlmContextWindow({ ...selector, vendor: "other", maxInputTokens: 50_000 }, 936_000)).toBe(
			50_000,
		)
		expect(getVscodeLlmContextWindow({ ...selector, family: "claude-haiku-4.5" }, 936_000)).toBe(128_000)
	})

	it.each(["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"] as const)(
		"uses the supported default and extended context sizes for %s",
		(family) => {
			const model = { vendor: "copilot", family, maxInputTokens: 1_050_000 }
			expect(getVscodeLlmExtendedContextSize(model)).toBe(1_050_000)
			expect(getVscodeLlmContextWindow(model)).toBe(272_000)
			expect(getVscodeLlmContextWindow(model, 1_050_000)).toBe(1_050_000)
		},
	)

	describe("GPT-6.1 Sol host-declared input ceiling", () => {
		const sol61 = { vendor: "copilot", family: "gpt-6.1-sol" }

		it.each([undefined, 272_000, 922_000, 1_050_000])(
			"uses the observed input ceiling without inventing a context configuration for %s",
			(configuredSize) => {
				expect(getVscodeLlmContextWindow(sol61, configuredSize)).toBe(922_000)
				expect(getVscodeLlmExtendedContextSize(sol61)).toBeUndefined()
			},
		)

		it.each([
			[921_793, 921_793],
			[921_793.9, 921_793],
			[64_000, 64_000],
			[1_050_000, 922_000],
		])("constrains the observed ceiling by actual live input limit %s", (maxInputTokens, expected) => {
			const model = { ...sol61, maxInputTokens }
			expect(getVscodeLlmContextWindow(model)).toBe(expected)
			expect(getVscodeLlmContextWindow(model, 1_050_000)).toBe(expected)
			expect(getVscodeLlmExtendedContextSize(model)).toBeUndefined()
		})
	})
})
