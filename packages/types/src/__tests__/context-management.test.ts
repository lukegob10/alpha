import { describe, it, expect } from "vitest"
import { CONTEXT_MANAGEMENT_EVENTS, isContextManagementEvent } from "../context-management.js"
import { contextCondenseSchema } from "../message.js"
import { modelInfoSchema } from "../model.js"

describe("context-management", () => {
	it("reads old compression events and round-trips the optional unchanged outcome", () => {
		const old = { cost: 0, prevContextTokens: 800, newContextTokens: 200, summary: "Summary" }
		expect(contextCondenseSchema.parse(old)).toEqual(old)
		const unchanged = { ...old, outcome: "unchanged", newContextTokens: 800, summary: "" }
		expect(contextCondenseSchema.parse(JSON.parse(JSON.stringify(unchanged)))).toEqual(unchanged)
	})
	it("retains an explicit input-only provider context limit", () => {
		expect(
			modelInfoSchema.parse({
				contextWindow: 200_000,
				supportsPromptCache: false,
				contextWindowIncludesOutput: false,
			}).contextWindowIncludesOutput,
		).toBe(false)
	})
	describe("CONTEXT_MANAGEMENT_EVENTS", () => {
		it("should contain all expected event types", () => {
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("condense_context")
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("condense_context_error")
			expect(CONTEXT_MANAGEMENT_EVENTS).toContain("sliding_window_truncation")
			expect(CONTEXT_MANAGEMENT_EVENTS).toHaveLength(3)
		})
	})

	describe("isContextManagementEvent", () => {
		it("should return true for valid context management events", () => {
			expect(isContextManagementEvent("condense_context")).toBe(true)
			expect(isContextManagementEvent("condense_context_error")).toBe(true)
			expect(isContextManagementEvent("sliding_window_truncation")).toBe(true)
		})

		it("should return false for non-context-management events", () => {
			expect(isContextManagementEvent("text")).toBe(false)
			expect(isContextManagementEvent("error")).toBe(false)
			expect(isContextManagementEvent(null)).toBe(false)
			expect(isContextManagementEvent(undefined)).toBe(false)
		})
	})
})
