import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import {
	DEFAULT_MANAGED_AGENT_SETTINGS,
	toManagedAgentSettingsSavePayload,
	withManagedAgentSettingsDefaults,
} from "../managed-agent-settings"

const initial = {} as ExtensionStateContextType
describe("managed-agent settings adapter", () => {
	it("uses Codex V2 defaults", () => {
		expect(withManagedAgentSettingsDefaults(initial)).toMatchObject(DEFAULT_MANAGED_AGENT_SETTINGS)
		expect(DEFAULT_MANAGED_AGENT_SETTINGS).toMatchObject({
			subagentsEnabled: true,
			maxConcurrentSubagents: 3,
			subagentInterruptMessage: true,
		})
	})
	it("does not impose Alpha's retired sixteen-agent maximum", () => {
		expect(
			withManagedAgentSettingsDefaults({ ...initial, maxConcurrentSubagents: 64 }).maxConcurrentSubagents,
		).toBe(64)
	})
	it("saves only current agent settings, with explicit inheritance clearing", () => {
		const state = withManagedAgentSettingsDefaults({
			...initial,
			subagentRoleTimeoutsMs: { worker: 10_000 },
			subagentRootCostBudget: 1,
		} as unknown as ExtensionStateContextType)
		expect(JSON.parse(JSON.stringify(toManagedAgentSettingsSavePayload(state)))).toEqual({
			subagentsEnabled: true,
			maxConcurrentSubagents: 3,
			subagentDefaultModel: "",
			subagentDefaultReasoningEffort: null,
			subagentInterruptMessage: true,
		})
	})
})
