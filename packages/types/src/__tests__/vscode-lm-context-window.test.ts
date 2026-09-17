import { describe, expect, it } from "vitest"

import { getVscodeLlmContextWindow } from "../providers/vscode-llm.js"

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
})
