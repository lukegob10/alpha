import { describe, expect, it } from "vitest"

import { parseVsCodeLmModelSelector, stringifyVsCodeLmModelSelector } from "../vsCodeSelectorUtils"

describe("vsCodeSelectorUtils", () => {
	it("stringifies the full VS Code LM selector", () => {
		expect(
			stringifyVsCodeLmModelSelector({
				vendor: "copilot",
				family: "gpt-5.5",
				version: "high",
				id: "copilot-gpt-5.5-high",
			}),
		).toBe("copilot/gpt-5.5/high/copilot-gpt-5.5-high")
	})

	it("preserves legacy vendor/family selectors", () => {
		expect(stringifyVsCodeLmModelSelector({ vendor: "copilot", family: "gpt-5.5" })).toBe("copilot/gpt-5.5")
	})

	it("parses full selectors back to selector objects", () => {
		expect(parseVsCodeLmModelSelector("copilot/gpt-5.5/high/copilot-gpt-5.5-high")).toEqual({
			vendor: "copilot",
			family: "gpt-5.5",
			version: "high",
			id: "copilot-gpt-5.5-high",
		})
	})
})
