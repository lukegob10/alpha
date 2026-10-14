import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ProviderSettingsEntry } from "@alpha-code/types"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import { AgentsSettings } from "../AgentsSettings"
import { getManagedAgentSettingsError } from "../agents-settings-validation"
import {
	withManagedAgentSettingsDefaults,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "../managed-agent-settings"
import { SearchIndexProvider } from "../useSettingsSearch"

const profiles: ProviderSettingsEntry[] = [
	{ id: "profile-local", name: "Local model", apiProvider: "openai", modelId: "local-model" },
	{ id: "profile-copilot", name: "Copilot", apiProvider: "vscode-lm", modelId: "gpt-6-luna" },
	{ id: "profile-empty", name: "Unconfigured" },
]
const defaults = () => withManagedAgentSettingsDefaults({} as ExtensionStateContextType)

function BufferHarness({ initial = defaults() }: { initial?: SettingsCachedState }) {
	const [values, setValues] = useState(initial)
	const setField: SetSettingsCachedStateField = (field, value) => setValues((state) => ({ ...state, [field]: value }))
	return (
		<>
			<AgentsSettings values={values} setCachedStateField={setField} listApiConfigMeta={profiles} />
			<button disabled={!!getManagedAgentSettingsError(values)}>Buffered Save</button>
		</>
	)
}

const advanced = () => {
	const details = screen.getByText("Advanced agent settings").closest("details")
	if (!details) throw new Error("Advanced settings container was not rendered")
	details.open = true
	return details
}

describe("AgentsSettings", () => {
	it("shows discoverable basic settings with conservative runtime defaults and scoped units", () => {
		render(<BufferHarness />)
		expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument()
		expect(screen.getByRole("spinbutton", { name: "Maximum concurrent managed agents" })).toHaveValue(2)
		expect(screen.getByRole("combobox", { name: "Delegation policy" })).toHaveValue("explicit-only")
		expect(screen.getByRole("combobox", { name: "Default child model/API profile" })).toHaveValue("")
		expect(screen.getByText(/Live children across one root task/)).toHaveTextContent(/excluding the root itself/)
		expect(screen.getByText(/Live children across one root task/)).toHaveTextContent(
			/maximum concurrent tasks setting can further restrict/,
		)
		expect(screen.getByText(/Limits are captured/)).toHaveTextContent(/including reloads/)
		expect(screen.getByText(/Limits are captured/)).toHaveTextContent(/Proactive cannot widen/)
		expect(screen.getByTestId("agents-task-capacity")).toHaveTextContent(
			"Configured extension task capacity: 3 tasks",
		)
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})

	it("explains the configured global task cap without claiming live child availability", () => {
		render(<BufferHarness initial={{ ...defaults(), maxConcurrentSubagents: 8, maxConcurrentTasks: 4 }} />)
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toHaveValue(8)
		expect(screen.getByTestId("agents-task-capacity")).toHaveTextContent(
			"Configured extension task capacity: 4 tasks",
		)
		expect(screen.getByTestId("agents-task-capacity")).toHaveTextContent(
			/Available child slots depend on running tasks/,
		)
	})

	it("edits only the supplied cached fields for concurrency, policy and default child profile", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				values={defaults()}
				setCachedStateField={setCachedStateField}
				listApiConfigMeta={profiles}
			/>,
		)
		fireEvent.change(screen.getByLabelText("Maximum concurrent managed agents"), { target: { value: "6" } })
		fireEvent.change(screen.getByLabelText("Delegation policy"), { target: { value: "proactive" } })
		fireEvent.change(screen.getByLabelText("Default child model/API profile"), {
			target: { value: "profile-copilot" },
		})
		expect(setCachedStateField.mock.calls).toEqual([
			["maxConcurrentSubagents", 6],
			["subagentDelegationPolicy", "proactive"],
			["subagentDefaultApiConfigId", "profile-copilot"],
		])
	})

	it("keeps invalid numeric edits visible with accessible errors and blocks buffered Save", () => {
		render(<BufferHarness />)
		const input = screen.getByLabelText("Maximum concurrent managed agents")
		fireEvent.change(input, { target: { value: "17" } })
		expect(input).toHaveValue(17)
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(input).toHaveAccessibleDescription(/Choose a whole number from 1 to 16/)
		expect(screen.getByRole("alert")).toHaveTextContent(/Choose a whole number from 1 to 16/)
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(input, { target: { value: "" } })
		expect(input).toHaveValue(null)
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(input, { target: { value: "3" } })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})

	it("preserves saved millisecond precision and edits only the selected timeout role", () => {
		const values = defaults()
		values.subagentRoleTimeoutsMs = { ...values.subagentRoleTimeoutsMs, review: 90_901 }
		const setCachedStateField = vi.fn()
		render(<AgentsSettings values={values} setCachedStateField={setCachedStateField} />)
		advanced()
		expect(screen.getByLabelText("Review timeout per run (seconds)")).toHaveValue(90.901)
		fireEvent.change(screen.getByLabelText("Review timeout per run (seconds)"), { target: { value: "123.456" } })
		expect(setCachedStateField).toHaveBeenCalledWith("subagentRoleTimeoutsMs", {
			explore: 120_000,
			review: 123_456,
			worker: 900_000,
		})
	})

	it("clears optional tree budgets to explicit null values in the edit buffer", () => {
		const values = { ...defaults(), subagentRootTokenBudget: 5_000, subagentRootCostBudget: 0.5 }
		const setCachedStateField = vi.fn()
		render(<AgentsSettings values={values} setCachedStateField={setCachedStateField} />)
		advanced()
		fireEvent.change(screen.getByLabelText("Token budget for one managed-agent tree"), { target: { value: "" } })
		fireEvent.change(screen.getByLabelText("Cost budget for one managed-agent tree (USD)"), {
			target: { value: "" },
		})
		expect(setCachedStateField.mock.calls).toEqual([
			["subagentRootTokenBudget", null],
			["subagentRootCostBudget", null],
		])
	})

	it("blocks Save for an unfinished optional number instead of treating it as a cleared budget", () => {
		render(<BufferHarness initial={{ ...defaults(), subagentRootCostBudget: 0.5 }} />)
		advanced()
		const input = screen.getByLabelText("Cost budget for one managed-agent tree (USD)")
		// Browsers keep partial numeric text while exposing an empty value and badInput.
		Object.defineProperty(input, "validity", { value: { badInput: true }, configurable: true })
		fireEvent.change(input, { target: { value: "" } })
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		expect(screen.getByRole("alert")).toHaveTextContent(/finite amount greater than zero/)
	})

	it("reveals Advanced errors and validates token budgets and positive uncapped root cost", () => {
		render(<BufferHarness />)
		const details = screen.getByText("Advanced agent settings").closest("details")
		expect(details).not.toHaveAttribute("open")
		fireEvent.change(screen.getByLabelText("Input-token limit per child"), { target: { value: "0" } })
		expect(details).toHaveAttribute("open")
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(screen.getByLabelText("Input-token limit per child"), { target: { value: "250000" } })
		fireEvent.change(screen.getByLabelText("Cost budget for one managed-agent tree (USD)"), {
			target: { value: "250000" },
		})
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
		fireEvent.change(screen.getByLabelText("Cost budget for one managed-agent tree (USD)"), {
			target: { value: "0" },
		})
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(screen.getByLabelText("Cost budget for one managed-agent tree (USD)"), {
			target: { value: "" },
		})
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
		expect(screen.getByText(/Token and cost limits stop agents/)).toHaveTextContent(/not prepaid spending caps/)
	})

	it("keeps unavailable and unconfigured profiles visible until the user replaces the reference", () => {
		const setCachedStateField = vi.fn()
		const values = {
			...defaults(),
			subagentDefaultApiConfigId: "deleted",
			subagentApiConfigByRole: { review: "profile-empty" },
		}
		render(
			<AgentsSettings values={values} setCachedStateField={setCachedStateField} listApiConfigMeta={profiles} />,
		)
		expect(screen.getByLabelText("Default child model/API profile")).toHaveValue("deleted")
		expect(screen.getByRole("option", { name: "Unavailable profile (deleted)" })).toBeInTheDocument()
		expect(screen.getByText(/The saved profile is unavailable/)).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
		advanced()
		expect(screen.getByLabelText("Review model/API profile")).toHaveValue("profile-empty")
		expect(screen.getByText(/This profile has no configured provider/)).toBeInTheDocument()
		fireEvent.change(screen.getByLabelText("Default child model/API profile"), { target: { value: "" } })
		expect(setCachedStateField).toHaveBeenCalledWith("subagentDefaultApiConfigId", undefined)
	})

	it("updates one role route while preserving other routes", () => {
		const setCachedStateField = vi.fn()
		const values = {
			...defaults(),
			subagentApiConfigByRole: { explore: "profile-local", worker: "deleted-worker" },
		}
		render(
			<AgentsSettings values={values} setCachedStateField={setCachedStateField} listApiConfigMeta={profiles} />,
		)
		advanced()
		fireEvent.change(screen.getByLabelText("Review model/API profile"), { target: { value: "profile-copilot" } })
		expect(setCachedStateField).toHaveBeenCalledWith("subagentApiConfigByRole", {
			explore: "profile-local",
			review: "profile-copilot",
			worker: "deleted-worker",
		})
		fireEvent.change(screen.getByLabelText("Explore model/API profile"), { target: { value: "" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("subagentApiConfigByRole", { worker: "deleted-worker" })
	})

	it("edits a type route while preserving and displaying saved model, reasoning and instruction overrides", () => {
		const definition = {
			description: "Review changes",
			role: "review" as const,
			apiConfigId: "deleted-type",
			model: "custom-model",
			reasoningEffort: "high" as const,
			developerInstructions: "Check observable behavior.",
		}
		const values = { ...defaults(), subagentAgentTypes: { reviewer: definition } }
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings values={values} setCachedStateField={setCachedStateField} listApiConfigMeta={profiles} />,
		)
		advanced()
		expect(screen.getByLabelText("reviewer model/API profile")).toHaveValue("deleted-type")
		expect(screen.getByText("Saved model override: custom-model")).toBeInTheDocument()
		expect(screen.getByText("Saved reasoning override: high")).toBeInTheDocument()
		expect(screen.getByText("This type has saved developer instructions.")).toBeInTheDocument()
		fireEvent.change(screen.getByLabelText("reviewer model/API profile"), { target: { value: "profile-copilot" } })
		expect(setCachedStateField).toHaveBeenCalledWith("subagentAgentTypes", {
			reviewer: { ...definition, apiConfigId: "profile-copilot" },
		})
	})

	it("adds and removes valid named types through the shared buffer and rejects duplicate or invalid names", () => {
		render(<BufferHarness />)
		advanced()
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "Reviewer" } })
		fireEvent.change(screen.getByLabelText("New agent type description"), { target: { value: "Review code" } })
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		expect(screen.getByRole("alert")).toHaveTextContent(/unique valid type name/)
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "reviewer" } })
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		expect(screen.getByLabelText("reviewer description")).toHaveValue("Review code")
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "reviewer" } })
		fireEvent.change(screen.getByLabelText("New agent type description"), { target: { value: "Duplicate" } })
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		expect(screen.getByRole("alert")).toHaveTextContent(/unique valid type name/)
		fireEvent.click(screen.getByRole("button", { name: "Remove reviewer" }))
		expect(screen.queryByLabelText("reviewer description")).not.toBeInTheDocument()
	})

	it("resyncs from supplied values without writing back or dropping routing maps", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(<AgentsSettings values={defaults()} setCachedStateField={setCachedStateField} />)
		const incoming = {
			...defaults(),
			maxConcurrentSubagents: 8,
			subagentDefaultApiConfigId: "deleted-import",
			subagentApiConfigByRole: { review: "deleted-role" },
			subagentAgentTypes: { audit: { description: "Audit changes", apiConfigId: "deleted-type" } },
		}
		rerender(<AgentsSettings values={incoming} setCachedStateField={setCachedStateField} />)
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toHaveValue(8)
		expect(screen.getByLabelText("Default child model/API profile")).toHaveValue("deleted-import")
		advanced()
		expect(screen.getByLabelText("Review model/API profile")).toHaveValue("deleted-role")
		expect(screen.getByLabelText("audit model/API profile")).toHaveValue("deleted-type")
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("registers Advanced settings for search while the disclosure is collapsed", () => {
		const registerSetting = vi.fn()
		render(
			<SearchIndexProvider value={{ registerSetting }}>
				<AgentsSettings values={defaults()} setCachedStateField={vi.fn()} />
			</SearchIndexProvider>,
		)
		expect(screen.getByText("Advanced agent settings").closest("details")).not.toHaveAttribute("open")
		expect(registerSetting).toHaveBeenCalledWith({
			settingId: "agents-root-cost",
			section: "agents",
			label: "Cost budget for one managed-agent tree (USD)",
		})
		expect(registerSetting).toHaveBeenCalledWith({
			settingId: "agents-profile-review",
			section: "agents",
			label: "Review model/API profile",
		})
	})
})
