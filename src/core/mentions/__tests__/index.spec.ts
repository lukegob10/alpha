// npx vitest core/mentions/__tests__/index.spec.ts

import * as vscode from "vscode"

import { parseMentions } from "../index"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

describe("parseMentions - URL mention handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should replace URL mentions with quoted URL reference", async () => {
		const result = await parseMentions("Check @https://example.com", "/test")

		// URL mentions are now replaced with a quoted reference (no fetching)
		expect(result.text).toContain("'https://example.com'")
	})
})

describe("parseMentions - built-in Plan command", () => {
	it("switches mode and removes the command while preserving its inline prompt", async () => {
		const result = await parseMentions("<user_message>\n/plan inspect the provider flow\n</user_message>", "/test")

		expect(result.mode).toBe("architect")
		expect(result.text).toBe("<user_message>\ninspect the provider flow\n</user_message>")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("does not claim similarly named workspace commands", async () => {
		const result = await parseMentions("<user_message>\n/planner inspect the flow\n</user_message>", "/test")

		expect(result.mode).toBeUndefined()
		expect(result.text).toContain("/planner")
	})
})
