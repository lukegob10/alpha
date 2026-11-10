import { useState, type ReactElement } from "react"
import { fireEvent, render as renderComponent, screen } from "@testing-library/react"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentsSettings } from "../AgentsSettings"
import { getManagedAgentSettingsError } from "../agents-settings-validation"
import {
	withManagedAgentSettingsDefaults,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "../managed-agent-settings"
import { SearchIndexProvider } from "../useSettingsSearch"
import { renderedAgentSettingsControls } from "../../../../../apps/vscode-e2e/src/ui/agentSettingsContract"

const defaults = () => withManagedAgentSettingsDefaults({} as ExtensionStateContextType)
const render = (ui: ReactElement) => renderComponent(<TooltipProvider>{ui}</TooltipProvider>)
const advancedSummary = () => screen.getByText("Advanced agent settings", { selector: "summary" })
const openAdvanced = () => fireEvent.click(advancedSummary())
function BufferHarness({ initial = defaults() }: { initial?: SettingsCachedState }) {
	const [values, setValues] = useState(initial)
	const setField: SetSettingsCachedStateField = (field, value) => setValues((state) => ({ ...state, [field]: value }))
	return (
		<>
			<AgentsSettings values={values} setCachedStateField={setField} />
			<button disabled={!!getManagedAgentSettingsError(values)}>Buffered Save</button>
		</>
	)
}
describe("AgentsSettings", () => {
	it("renders a subsection heading when embedded in Tools & agents", () => {
		render(<AgentsSettings embedded values={defaults()} setCachedStateField={vi.fn()} />)
		expect(screen.getByRole("heading", { name: "Agents", level: 4 })).toBeVisible()
		expect(screen.queryByRole("heading", { name: "Agents", level: 3 })).not.toBeInTheDocument()
	})
	it("matches the rendered extension-host probe's current control and accessible-label contract", () => {
		render(<BufferHarness />)
		openAdvanced()
		for (const [id, tag, label] of renderedAgentSettingsControls) {
			const control = screen.getByLabelText(label)
			expect(control).toHaveAttribute("id", id)
			expect(control.tagName.toLowerCase()).toBe(tag)
			expect(control).toBeVisible()
		}
	})
	it("shows Codex agent settings and no retired Alpha controls", () => {
		render(<BufferHarness />)
		expect(screen.getByLabelText("Enable subagents")).toBeChecked()
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toHaveValue(3)
		expect(screen.getByTestId("agents-total-capacity")).toHaveValue(3)
		expect(screen.getByLabelText("Default subagent model")).toHaveValue("")
		expect(screen.getByLabelText("Default subagent reasoning effort")).toHaveValue("")
		expect(screen.queryByLabelText("Record agent interruption messages")).not.toBeInTheDocument()
		expect(screen.getByLabelText("Default subagent model").closest("details")).not.toHaveAttribute("open")
		expect(screen.getByLabelText("Default subagent reasoning effort").closest("details")).not.toHaveAttribute(
			"open",
		)
		expect(screen.getByText("Custom agents", { selector: "h4" })).not.toBeVisible()
		expect(screen.getByLabelText("New agent type name")).not.toBeVisible()
		expect(screen.getByLabelText("New agent type description")).not.toBeVisible()
		expect(screen.getByLabelText("Enable subagents")).toBeVisible()
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toBeVisible()
		expect(screen.getByTestId("agents-total-capacity")).toBeVisible()
		expect(screen.queryByText("Role timeouts")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Delegation policy")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Maximum managed-agent depth")).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Input-token limit per child")).not.toBeInTheDocument()
		expect(screen.queryByText(/budget for one managed-agent tree/)).not.toBeInTheDocument()
		expect(screen.queryByLabelText("Default child model/API profile")).not.toBeInTheDocument()
	})
	it("edits only the cached values", () => {
		const setCachedStateField = vi.fn()
		render(<AgentsSettings values={defaults()} setCachedStateField={setCachedStateField} />)
		fireEvent.click(screen.getByLabelText("Enable subagents"))
		fireEvent.change(screen.getByLabelText("Maximum concurrent managed agents"), { target: { value: "64" } })
		fireEvent.change(screen.getByTestId("agents-total-capacity"), { target: { value: "8" } })
		openAdvanced()
		fireEvent.change(screen.getByLabelText("Default subagent model"), { target: { value: "model-id" } })
		fireEvent.change(screen.getByLabelText("Default subagent reasoning effort"), { target: { value: "high" } })
		expect(setCachedStateField.mock.calls).toEqual([
			["subagentsEnabled", false],
			["maxConcurrentSubagents", 64],
			["maxConcurrentTasks", 8],
			["subagentDefaultModel", "model-id"],
			["subagentDefaultReasoningEffort", "high"],
		])
	})
	it("shows the total-capacity constraint without changing the saved child maximum", () => {
		render(<BufferHarness />)
		expect(screen.queryByTestId("agents-task-capacity")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Help for Maximum concurrent tasks/i }))
		expect(screen.getByTestId("agents-task-capacity")).toHaveTextContent("2")
		fireEvent.change(screen.getByTestId("agents-total-capacity"), { target: { value: "1" } })
		expect(screen.getByTestId("agents-task-capacity")).toHaveTextContent("0")
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toHaveValue(3)
	})
	it("keeps introductory and field explanations behind help controls", () => {
		render(<BufferHarness />)
		expect(screen.queryByText(/Subagents share the parent's working directory/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Maximum live tasks across the extension/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Help for Maximum concurrent tasks/i }))
		expect(screen.getByText(/Maximum live tasks across the extension/)).toBeVisible()
	})
	it("retains invalid total-capacity edits and blocks Save", () => {
		render(<BufferHarness />)
		const input = screen.getByTestId("agents-total-capacity")
		fireEvent.change(input, { target: { value: "1.5" } })
		expect(input).toHaveValue(1.5)
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(input, { target: { value: "8" } })
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})
	it("opens Advanced when a saved override needs correction", () => {
		render(<BufferHarness initial={{ ...defaults(), subagentDefaultModel: "x".repeat(257) }} />)
		expect(screen.getByLabelText("Default subagent model").closest("details")).toHaveAttribute("open")
	})
	it("opens Advanced for invalid saved custom agents and exposes their correction", () => {
		render(<BufferHarness initial={{ ...defaults(), subagentAgentTypes: { reviewer: { description: "" } } }} />)
		expect(advancedSummary().closest("details")).toHaveAttribute("open")
		const description = screen.getByLabelText("reviewer description")
		expect(description).toBeVisible()
		expect(description).toHaveValue("")
		expect(description).toHaveAttribute("aria-invalid", "true")
		expect(screen.getByRole("alert")).toBeVisible()
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(description, { target: { value: "Review changes" } })
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})
	it("keeps saved custom agents inside the closed Advanced disclosure", () => {
		render(
			<BufferHarness
				initial={{ ...defaults(), subagentAgentTypes: { reviewer: { description: "Review changes" } } }}
			/>,
		)
		const description = screen.getByLabelText("reviewer description")
		expect(description.closest("details")).toBe(advancedSummary().closest("details"))
		expect(description).not.toBeVisible()
		openAdvanced()
		expect(description).toBeVisible()
	})
	it("keeps new-agent drafts mounted while Advanced is folded and reopened", () => {
		render(<BufferHarness />)
		openAdvanced()
		const name = screen.getByLabelText("New agent type name")
		const description = screen.getByLabelText("New agent type description")
		fireEvent.change(name, { target: { value: "researcher" } })
		fireEvent.change(description, { target: { value: "Inspect the repository" } })
		fireEvent.click(advancedSummary())
		expect(name).toBeInTheDocument()
		expect(name).not.toBeVisible()
		expect(description).not.toBeVisible()
		openAdvanced()
		expect(screen.getByLabelText("New agent type name")).toBe(name)
		expect(name).toHaveValue("researcher")
		expect(description).toHaveValue("Inspect the repository")
	})
	it("allows folding an invalid new-agent draft without clearing its fields or error", () => {
		render(<BufferHarness />)
		openAdvanced()
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "Invalid name" } })
		fireEvent.change(screen.getByLabelText("New agent type description"), {
			target: { value: "Keep this draft" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		const error = screen.getByRole("alert")
		expect(error).toBeVisible()
		fireEvent.click(advancedSummary())
		expect(advancedSummary().closest("details")).not.toHaveAttribute("open")
		expect(error).toBeInTheDocument()
		expect(error).not.toBeVisible()
		openAdvanced()
		expect(screen.getByLabelText("New agent type name")).toHaveValue("Invalid name")
		expect(screen.getByLabelText("New agent type description")).toHaveValue("Keep this draft")
		expect(error).toBeVisible()
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})
	it("retains invalid numeric edits and blocks Save", () => {
		render(<BufferHarness />)
		const input = screen.getByLabelText("Maximum concurrent managed agents")
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		fireEvent.change(input, { target: { value: "1.5" } })
		expect(input).toHaveValue(1.5)
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(screen.getByRole("alert")).toBeVisible()
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(input, { target: { value: "64" } })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})
	it("edits model, effort, and instructions while retaining saved authority metadata", () => {
		const definition = {
			description: "Review changes",
			role: "review" as const,
			apiConfigId: "saved-profile",
			model: "old-model",
			developerInstructions: "Inspect contracts",
		}
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				values={{ ...defaults(), subagentAgentTypes: { reviewer: definition } }}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		fireEvent.change(screen.getByLabelText("reviewer model"), { target: { value: "new-model" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("subagentAgentTypes", {
			reviewer: { ...definition, model: "new-model" },
		})
		fireEvent.change(screen.getByLabelText("reviewer reasoning effort"), { target: { value: "high" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("subagentAgentTypes", {
			reviewer: { ...definition, reasoningEffort: "high" },
		})
		fireEvent.change(screen.getByLabelText("reviewer developer instructions"), {
			target: { value: "Verify tests" },
		})
		expect(setCachedStateField).toHaveBeenLastCalledWith("subagentAgentTypes", {
			reviewer: { ...definition, developerInstructions: "Verify tests" },
		})
	})
	it("shows retained custom-agent connection and role overrides", () => {
		render(
			<BufferHarness
				initial={{
					...defaults(),
					listApiConfigMeta: [{ id: "saved-profile", name: "Saved connection", apiProvider: "anthropic" }],
					subagentAgentTypes: {
						reviewer: { description: "Review changes", role: "review", apiConfigId: "saved-profile" },
					},
				}}
			/>,
		)
		openAdvanced()
		expect(screen.queryByTestId("reviewer-connection")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Help for reviewer details/i }))
		expect(screen.getByTestId("reviewer-connection")).toHaveTextContent("Saved connection")
		expect(screen.getByTestId("reviewer-role")).toHaveTextContent("review")
	})
	it("identifies an unavailable saved connection without replacing it", () => {
		const setCachedStateField = vi.fn()
		render(
			<AgentsSettings
				values={{
					...defaults(),
					subagentAgentTypes: { reviewer: { description: "Review changes", apiConfigId: "missing-profile" } },
				}}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvanced()
		fireEvent.click(screen.getByRole("button", { name: /Help for reviewer details/i }))
		expect(screen.getByTestId("reviewer-connection")).toHaveTextContent("missing-profile")
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
	it("adds and removes a custom agent", () => {
		render(<BufferHarness />)
		openAdvanced()
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "researcher" } })
		fireEvent.change(screen.getByLabelText("New agent type description"), {
			target: { value: "Inspect the repository" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		expect(screen.getByLabelText("researcher developer instructions")).toHaveValue("")
		fireEvent.change(screen.getByLabelText("researcher developer instructions"), {
			target: { value: "Report verified findings" },
		})
		expect(screen.getByLabelText("researcher developer instructions")).toHaveValue("Report verified findings")
		fireEvent.click(screen.getByRole("button", { name: "Remove researcher" }))
		expect(screen.getByText("No custom agents configured.")).toBeInTheDocument()
	})
	it("registers current settings for search", () => {
		const register = vi.fn()
		render(
			<SearchIndexProvider value={{ registerSetting: register }}>
				<BufferHarness />
			</SearchIndexProvider>,
		)
		expect(register).toHaveBeenCalledWith(expect.objectContaining({ settingId: "agents-default-model" }))
		expect(register.mock.calls.some(([setting]) => setting.settingId.startsWith("agents-timeout"))).toBe(false)
	})
})
