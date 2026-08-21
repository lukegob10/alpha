import { fireEvent, render, screen } from "@testing-library/react"

import { AgentsSettings } from "../AgentsSettings"
import { DEFAULT_MANAGED_AGENT_SETTINGS } from "../managed-agent-settings"

vi.mock("@/components/ui", () => ({
	SearchableSelect: ({ options, onValueChange, ...props }: any) => (
		<select {...props} onChange={(event) => onValueChange(event.target.value)}>
			{options.map((option: any) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: { id?: string }) =>
			key === "settings:agents.unavailableProfile" ? `Unavailable profile (${values?.id})` : key,
	}),
}))

const profiles = [
	{
		id: "fast-id",
		name: "Fast",
		apiProvider: "openrouter" as const,
		modelId: "fast/model",
	},
	{
		id: "review-id",
		name: "Reviewer",
		apiProvider: "anthropic" as const,
		modelId: "claude-review",
	},
]

describe("AgentsSettings", () => {
	it("shows stable-ID profile options with provider and model metadata", () => {
		render(
			<AgentsSettings
				profiles={profiles}
				defaultProfileId="fast-id"
				profileByRole={{ review: "review-id" }}
				managedAgentSettings={DEFAULT_MANAGED_AGENT_SETTINGS}
				setCachedStateField={vi.fn()}
			/>,
		)

		expect(screen.getAllByText("Fast · openrouter · fast/model").length).toBeGreaterThan(0)
		expect(screen.getAllByText("Reviewer · anthropic · claude-review").length).toBeGreaterThan(0)
		expect(screen.getByLabelText("settings:agents.defaultProfile.label")).toHaveValue("fast-id")
		expect(screen.getByText("settings:agents.roles.title")).toBeInTheDocument()
	})

	it("writes selections only through the cached-state callback", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				profiles={profiles}
				profileByRole={{}}
				managedAgentSettings={DEFAULT_MANAGED_AGENT_SETTINGS}
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByLabelText("settings:agents.defaultProfile.label"), {
			target: { value: "fast-id" },
		})
		fireEvent.change(screen.getByLabelText("settings:agents.roles.review.label"), {
			target: { value: "review-id" },
		})
		fireEvent.change(screen.getByLabelText("settings:agents.roles.worker.label"), {
			target: { value: "fast-id" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("subagentDefaultApiConfigId", "fast-id")
		expect(setCachedStateField).toHaveBeenCalledWith("subagentApiConfigByRole", { review: "review-id" })
		expect(setCachedStateField).toHaveBeenCalledWith("subagentApiConfigByRole", { worker: "fast-id" })
	})

	it("keeps an imported stale selection visible with a parent-fallback warning", () => {
		render(
			<AgentsSettings
				profiles={profiles}
				defaultProfileId="deleted-id"
				managedAgentSettings={DEFAULT_MANAGED_AGENT_SETTINGS}
				setCachedStateField={vi.fn()}
			/>,
		)

		expect(screen.getByText("Unavailable profile (deleted-id)")).toBeInTheDocument()
		expect(screen.getByText("settings:agents.staleWarning")).toBeInTheDocument()
	})

	it("routes orchestration guardrails through the cached-state callback", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				profiles={profiles}
				managedAgentSettings={DEFAULT_MANAGED_AGENT_SETTINGS}
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("max-concurrent-subagents-input"), { target: { value: "6" } })
		fireEvent.change(screen.getByLabelText("Delegation policy"), { target: { value: "proactive" } })
		fireEvent.change(screen.getByTestId("subagent-explore-timeout-input"), { target: { value: "420" } })
		fireEvent.change(screen.getByTestId("subagent-max-input-tokens-input"), { target: { value: "24000" } })
		fireEvent.change(screen.getByTestId("subagent-max-output-tokens-input"), { target: { value: "8000" } })
		fireEvent.change(screen.getByTestId("subagent-root-token-budget-input"), { target: { value: "256000" } })
		fireEvent.change(screen.getByTestId("subagent-root-cost-budget-input"), { target: { value: "12.5" } })
		fireEvent.change(screen.getByTestId("subagent-max-depth-input"), { target: { value: "3" } })

		expect(setCachedStateField).toHaveBeenCalledWith("maxConcurrentSubagents", 6)
		expect(setCachedStateField).toHaveBeenCalledWith("subagentDelegationPolicy", "proactive")
		expect(setCachedStateField).toHaveBeenCalledWith("subagentRoleTimeoutsMs", {
			explore: 420_000,
			review: 120_000,
			worker: 900_000,
		})
		expect(setCachedStateField).toHaveBeenCalledWith("subagentMaxInputTokens", 24_000)
		expect(setCachedStateField).toHaveBeenCalledWith("subagentMaxOutputTokens", 8_000)
		expect(setCachedStateField).toHaveBeenCalledWith("subagentRootTokenBudget", 256_000)
		expect(setCachedStateField).toHaveBeenCalledWith("subagentRootCostBudget", 12.5)
		expect(setCachedStateField).toHaveBeenCalledWith("subagentMaxDepth", 3)
	})

	it("keeps the optional root cost ceiling clearable", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				profiles={profiles}
				managedAgentSettings={{ ...DEFAULT_MANAGED_AGENT_SETTINGS, subagentRootCostBudget: 5 }}
				setCachedStateField={setCachedStateField}
			/>,
		)

		fireEvent.change(screen.getByTestId("subagent-root-cost-budget-input"), { target: { value: "" } })

		expect(setCachedStateField).toHaveBeenCalledWith("subagentRootCostBudget", null)
	})

	it("uses the shared root token ceiling and accepts every finite positive root cost", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				profiles={profiles}
				managedAgentSettings={DEFAULT_MANAGED_AGENT_SETTINGS}
				setCachedStateField={setCachedStateField}
			/>,
		)

		expect(screen.getByTestId("subagent-root-token-budget-input")).toHaveAttribute("max", "10000000")
		fireEvent.change(screen.getByTestId("subagent-root-cost-budget-input"), {
			target: { value: "250000" },
		})

		expect(setCachedStateField).toHaveBeenCalledWith("subagentRootCostBudget", 250_000)
	})
})
