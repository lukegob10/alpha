import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
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
	it("matches the rendered extension-host probe's current control and accessible-label contract", () => {
		render(<BufferHarness />)
		for (const [id, tag, label] of renderedAgentSettingsControls) {
			const control = screen.getByLabelText(label)
			expect(control).toHaveAttribute("id", id)
			expect(control.tagName.toLowerCase()).toBe(tag)
		}
	})
	it("shows Codex agent settings and no retired Alpha controls", () => {
		render(<BufferHarness />)
		expect(screen.getByLabelText("Enable subagents")).toBeChecked()
		expect(screen.getByLabelText("Maximum concurrent managed agents")).toHaveValue(3)
		expect(screen.getByLabelText("Default subagent model")).toHaveValue("")
		expect(screen.getByLabelText("Default subagent reasoning effort")).toHaveValue("")
		expect(screen.getByLabelText("Record agent interruption messages")).toBeChecked()
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
		fireEvent.change(screen.getByLabelText("Default subagent model"), { target: { value: "model-id" } })
		fireEvent.change(screen.getByLabelText("Default subagent reasoning effort"), { target: { value: "high" } })
		fireEvent.click(screen.getByLabelText("Record agent interruption messages"))
		expect(setCachedStateField.mock.calls).toEqual([
			["subagentsEnabled", false],
			["maxConcurrentSubagents", 64],
			["subagentDefaultModel", "model-id"],
			["subagentDefaultReasoningEffort", "high"],
			["subagentInterruptMessage", false],
		])
	})
	it("retains invalid numeric edits and blocks Save", () => {
		render(<BufferHarness />)
		const input = screen.getByLabelText("Maximum concurrent managed agents")
		fireEvent.change(input, { target: { value: "1.5" } })
		expect(input).toHaveValue(1.5)
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeDisabled()
		fireEvent.change(input, { target: { value: "64" } })
		expect(screen.getByRole("button", { name: "Buffered Save" })).toBeEnabled()
	})
	it("edits model, effort, and instructions while retaining saved authority metadata", () => {
		const definition = {
			description: "Review changes",
			role: "review" as const,
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
	it("adds and removes a custom agent", () => {
		render(<BufferHarness />)
		fireEvent.change(screen.getByLabelText("New agent type name"), { target: { value: "researcher" } })
		fireEvent.change(screen.getByLabelText("New agent type description"), {
			target: { value: "Inspect the repository" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Add agent type" }))
		expect(screen.getByLabelText("researcher developer instructions")).toHaveValue("")
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
