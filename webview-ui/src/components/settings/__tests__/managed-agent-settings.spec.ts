import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import {
	DEFAULT_MANAGED_AGENT_SETTINGS,
	toManagedAgentSettingsSavePayload,
	withManagedAgentSettingsDefaults,
} from "../managed-agent-settings"

const extensionState = {} as ExtensionStateContextType

describe("managed-agent settings adapter", () => {
	it("supplies conservative defaults when the shared state has no guardrail contract", () => {
		const state = withManagedAgentSettingsDefaults(extensionState)

		expect(state).toMatchObject(DEFAULT_MANAGED_AGENT_SETTINGS)
		expect(state.subagentDelegationPolicy).toBe("explicit-only")
		expect(state.subagentMaxDepth).toBe(1)
	})

	it("normalizes runtime values at the settings boundary", () => {
		const state = withManagedAgentSettingsDefaults({
			...extensionState,
			maxConcurrentSubagents: 500,
			subagentDelegationPolicy: "proactive",
			subagentRoleTimeoutsMs: { explore: 0, review: 90_900.9, worker: Number.NaN },
			subagentMaxInputTokens: 0,
			subagentMaxOutputTokens: 12.9,
			subagentRootTokenBudget: 50_000_000,
			subagentRootCostBudget: -5,
			subagentMaxDepth: 99,
		} as ExtensionStateContextType)

		expect(state.maxConcurrentSubagents).toBe(16)
		expect(state.subagentRoleTimeoutsMs).toEqual({ explore: 10_000, review: 90_900, worker: 900_000 })
		expect(state.subagentMaxInputTokens).toBe(1)
		expect(state.subagentMaxOutputTokens).toBe(12)
		expect(state.subagentRootTokenBudget).toBe(50_000_000)
		expect(state.subagentRootCostBudget).toBe(0.01)
		expect(state.subagentMaxDepth).toBe(5)
	})

	it("serializes an empty optional cost ceiling as null so Save can clear it", () => {
		const state = withManagedAgentSettingsDefaults(extensionState)

		expect(toManagedAgentSettingsSavePayload(state).subagentRootCostBudget).toBeNull()
	})
})
