import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import {
	getManagedAgentSettingsError,
	getManagedAgentSettingsIssues,
	parseManagedAgentNumericInput,
	parseManagedAgentTimeoutSeconds,
	parseOptionalManagedAgentNumericInput,
} from "../agents-settings-validation"
import { withManagedAgentSettingsDefaults, type SettingsCachedState } from "../managed-agent-settings"

const defaults = () => withManagedAgentSettingsDefaults({} as ExtensionStateContextType)

describe("Agents settings validation", () => {
	it("accepts runtime defaults and inheritance without inventing profile authority", () => {
		expect(getManagedAgentSettingsError(defaults())).toBeUndefined()
	})

	it.each([
		["maxConcurrentSubagents", 0, "agents:validation.concurrency"],
		["maxConcurrentSubagents", 17, "agents:validation.concurrency"],
		["maxConcurrentSubagents", 1.5, "agents:validation.concurrency"],
		["maxConcurrentSubagents", Number.NaN, "agents:validation.concurrency"],
		["subagentMaxDepth", 0, "agents:validation.depth"],
		["subagentMaxDepth", 6, "agents:validation.depth"],
		["subagentMaxInputTokens", 0, "agents:validation.childTokens"],
		["subagentMaxOutputTokens", 10_000_001, "agents:validation.childTokens"],
		["subagentMaxOutputTokens", Number.POSITIVE_INFINITY, "agents:validation.childTokens"],
		["subagentRootTokenBudget", 0, "agents:validation.rootTokens"],
		["subagentRootTokenBudget", 1.1, "agents:validation.rootTokens"],
		["subagentRootCostBudget", 0, "agents:validation.rootCost"],
		["subagentRootCostBudget", -0.01, "agents:validation.rootCost"],
		["subagentRootCostBudget", Number.POSITIVE_INFINITY, "agents:validation.rootCost"],
	] as const)("rejects %s = %s without silently clamping it", (field, value, expected) => {
		const state = { ...defaults(), [field]: value }
		expect(getManagedAgentSettingsError(state)).toBe(expected)
		expect(state[field]).toBe(value)
	})

	it.each([
		[1, 1, 1, 1, 1, 0.00001],
		[16, 5, 10_000_000, 10_000_000, 10_000_000, 250_000],
	] as const)(
		"accepts schema boundaries and every finite positive cost",
		(concurrency, depth, input, output, tokens, cost) => {
			expect(
				getManagedAgentSettingsError({
					...defaults(),
					maxConcurrentSubagents: concurrency,
					subagentMaxDepth: depth,
					subagentMaxInputTokens: input,
					subagentMaxOutputTokens: output,
					subagentRootTokenBudget: tokens,
					subagentRootCostBudget: cost,
				}),
			).toBeUndefined()
		},
	)

	it.each([9_999, 3_600_001, 90_900.1, Number.NaN])("rejects invalid role timeout %s milliseconds", (timeout) => {
		const state = defaults()
		state.subagentRoleTimeoutsMs = { ...state.subagentRoleTimeoutsMs, review: timeout }
		expect(getManagedAgentSettingsIssues(state)).toEqual([
			{ settingId: "agents-timeout-review", translationKey: "agents:validation.timeout" },
		])
	})

	it.each(["10", "90.901", "120", "3600"])("preserves integer millisecond precision for %s seconds", (seconds) => {
		const parsed = parseManagedAgentTimeoutSeconds(seconds)
		const state = defaults()
		state.subagentRoleTimeoutsMs = { ...state.subagentRoleTimeoutsMs, explore: parsed }
		expect(parsed).toBe(Math.round(Number(seconds) * 1_000))
		expect(getManagedAgentSettingsError(state)).toBeUndefined()
	})

	it("preserves empty and sub-millisecond drafts as invalid instead of changing their meaning", () => {
		expect(parseManagedAgentNumericInput("")).toBeNaN()
		expect(parseManagedAgentNumericInput(" ")).toBeNaN()
		expect(parseManagedAgentNumericInput("1.5")).toBe(1.5)
		expect(parseManagedAgentTimeoutSeconds("90.9001")).toBeCloseTo(90_900.1)
		const state = defaults()
		state.subagentRoleTimeoutsMs = { ...state.subagentRoleTimeoutsMs, worker: parseManagedAgentTimeoutSeconds("") }
		expect(getManagedAgentSettingsError(state)).toBe("agents:validation.timeout")
	})

	it("distinguishes intentionally empty optional budgets from unfinished browser numbers", () => {
		expect(parseOptionalManagedAgentNumericInput("", false)).toBeNull()
		expect(parseOptionalManagedAgentNumericInput("", true)).toBeNaN()
		expect(parseOptionalManagedAgentNumericInput("0.25", false)).toBe(0.25)
	})

	it("allows null optional budgets and preserves dangling saved model/API profile IDs", () => {
		const state: SettingsCachedState = {
			...defaults(),
			subagentDefaultApiConfigId: "deleted-default",
			subagentApiConfigByRole: { review: "deleted-role" },
			subagentAgentTypes: {
				custom_review: { description: "Review changes", role: "review", apiConfigId: "deleted-type" },
			},
		}
		expect(getManagedAgentSettingsError(state)).toBeUndefined()
		expect(state.subagentDefaultApiConfigId).toBe("deleted-default")
		expect(state.subagentApiConfigByRole?.review).toBe("deleted-role")
		expect(state.subagentAgentTypes?.custom_review.apiConfigId).toBe("deleted-type")
	})

	it("validates named types using the shared schema, including names, descriptions, overrides and count", () => {
		const state = defaults()
		const invalidTypes = [
			{ Uppercase: { description: "Review" } },
			{ reviewer: { description: " " } },
			{ reviewer: { description: "Review", model: "x".repeat(257) } },
			Object.fromEntries(
				Array.from({ length: 25 }, (_, index) => [`review_${index}`, { description: "Review" }]),
			),
		]
		for (const subagentAgentTypes of invalidTypes) {
			expect(getManagedAgentSettingsError({ ...state, subagentAgentTypes })).toBe("agents:validation.agentTypes")
		}
	})
})
