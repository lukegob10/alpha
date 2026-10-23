import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { getManagedAgentSettingsError, parseManagedAgentNumericInput } from "../agents-settings-validation"
import { withManagedAgentSettingsDefaults } from "../managed-agent-settings"
const defaults = () => withManagedAgentSettingsDefaults({} as ExtensionStateContextType)
describe("Agents settings validation", () => {
	it("accepts defaults and inherited routes", () => expect(getManagedAgentSettingsError(defaults())).toBeUndefined())
	it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid concurrency %s without changing the edit",
		(value) => {
			const state = { ...defaults(), maxConcurrentSubagents: value }
			expect(getManagedAgentSettingsError(state)).toBe("agents:validation.concurrency")
			expect(state.maxConcurrentSubagents).toBe(value)
		},
	)
	it("validates model and effort settings", () => {
		expect(getManagedAgentSettingsError({ ...defaults(), subagentDefaultModel: "x".repeat(257) })).toBe(
			"agents:validation.model",
		)
		expect(getManagedAgentSettingsError({ ...defaults(), subagentDefaultReasoningEffort: "ultra" })).toBeUndefined()
	})
	it("ignores retired limits even if an old host sends them", () => {
		expect(
			getManagedAgentSettingsError(
				Object.assign(defaults(), {
					subagentMaxDepth: 1,
					subagentMaxInputTokens: 0,
					subagentRoleTimeoutsMs: { worker: 0 },
				}),
			),
		).toBeUndefined()
	})
	it("preserves invalid numeric drafts", () => {
		expect(parseManagedAgentNumericInput("")).toBeNaN()
		expect(parseManagedAgentNumericInput("1.5")).toBe(1.5)
	})
	it("validates custom agent definitions", () => {
		expect(
			getManagedAgentSettingsError({ ...defaults(), subagentAgentTypes: { reviewer: { description: " " } } }),
		).toBe("agents:validation.agentTypes")
	})
})
