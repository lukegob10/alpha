import { fireEvent, render, screen } from "@testing-library/react"

import { AgentsSettings } from "../AgentsSettings"

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
		render(<AgentsSettings profiles={profiles} profileByRole={{}} setCachedStateField={setCachedStateField} />)

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
		render(<AgentsSettings profiles={profiles} defaultProfileId="deleted-id" setCachedStateField={vi.fn()} />)

		expect(screen.getByText("Unavailable profile (deleted-id)")).toBeInTheDocument()
		expect(screen.getByText("settings:agents.staleWarning")).toBeInTheDocument()
	})
})
