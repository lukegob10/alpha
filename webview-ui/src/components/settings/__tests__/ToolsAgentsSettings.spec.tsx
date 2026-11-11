import { expect } from "vitest"
import { fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react"

import { vscode } from "@/utils/vscode"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ToolsAgentsSettings } from "../ToolsAgentsSettings"
import {
	withManagedAgentSettingsDefaults,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "../managed-agent-settings"

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/components/ui", () => ({
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		onChange,
		children,
	}: {
		checked: boolean
		onChange: (event: React.ChangeEvent<HTMLInputElement>) => void
		children: React.ReactNode
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))
vi.mock("../SkillsSettings", () => ({
	SkillsSettings: ({
		onDisabledBuiltinSkillsChange,
	}: {
		onDisabledBuiltinSkillsChange: (names: string[]) => void
	}) => (
		<section aria-label="Skills">
			<button onClick={() => onDisabledBuiltinSkillsChange(["review-agent"])}>Disable built-in skill</button>
		</section>
	),
}))
vi.mock("../AgentsSettings", () => ({
	AgentsSettings: ({ setCachedStateField }: { setCachedStateField: SetSettingsCachedStateField }) => (
		<section aria-label="Agents">
			<button onClick={() => setCachedStateField("subagentsEnabled", false)}>Disable agents</button>
		</section>
	),
}))
vi.mock("../../mcp/McpView", () => ({
	default: ({
		mcpEnabled,
		alwaysAllowMcp,
		onMcpEnabledChange,
		onAlwaysAllowMcpChange,
	}: {
		mcpEnabled: boolean
		alwaysAllowMcp: boolean
		onMcpEnabledChange: (enabled: boolean) => void
		onAlwaysAllowMcpChange: (enabled: boolean) => void
	}) => (
		<section aria-label="MCP servers">
			<button onClick={() => onMcpEnabledChange(!mcpEnabled)}>Toggle MCP</button>
			<button onClick={() => onAlwaysAllowMcpChange(!alwaysAllowMcp)}>Toggle saved grants</button>
		</section>
	),
}))

function defaults(): SettingsCachedState {
	return withManagedAgentSettingsDefaults({
		mcpEnabled: true,
		alwaysAllowMcp: false,
		experiments: { customTools: false, preventFocusDisruption: false },
	} as ExtensionStateContextType)
}

function render(component: React.ReactNode) {
	return renderComponent(component, {
		wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
	})
}

function openAdvanced() {
	const details = screen.getByText("settings:tools.advanced").closest("details")!
	details.open = true
	fireEvent(details, new Event("toggle"))
	return details
}

describe("ToolsAgentsSettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("groups the existing managers under one Tools & agents page", () => {
		const { container } = render(
			<ToolsAgentsSettings
				values={defaults()}
				setCachedStateField={vi.fn()}
				setExperimentEnabled={vi.fn()}
				isActive
				committedCustomToolsEnabled={false}
			/>,
		)

		expect(screen.getByRole("heading", { name: "settings:sections.tools", level: 3 })).toBeVisible()
		expect(screen.getByRole("region", { name: "Skills" })).toBeVisible()
		expect(screen.getByRole("region", { name: "Agents" })).toBeVisible()
		expect(screen.getByRole("region", { name: "MCP servers" })).toBeVisible()
		const pageCard = container.querySelector('[data-settings-page-card="tools"]')
		expect(pageCard).toBeInTheDocument()
		expect(container.querySelectorAll(".surface-raised")).toHaveLength(1)
		for (const name of ["Skills", "Agents", "MCP servers"]) {
			expect(screen.getByRole("region", { name }).closest(".surface-raised")).toBe(pageCard)
		}

		expect(container.querySelector('[data-setting-id="mcp-management"]')).toHaveAttribute(
			"data-setting-section",
			"tools",
		)
		expect(container.querySelector('[data-setting-id="custom-tools-management"]')).toHaveAttribute(
			"data-setting-section",
			"tools",
		)
		expect(screen.getByText("settings:tools.advanced").closest("details")).not.toHaveAttribute("open")
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("embeds the managers without a duplicate page header or introduction", () => {
		render(
			<ToolsAgentsSettings
				embedded
				values={defaults()}
				setCachedStateField={vi.fn()}
				setExperimentEnabled={vi.fn()}
				isActive
				committedCustomToolsEnabled={false}
			/>,
		)

		expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		expect(screen.queryByText("settings:tools.description")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:tools.managementDescription")).not.toBeInTheDocument()
		expect(screen.getByRole("region", { name: "Skills" })).toBeVisible()
		expect(screen.getByRole("region", { name: "Agents" })).toBeVisible()
		expect(screen.getByRole("region", { name: "MCP servers" })).toBeVisible()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("routes manager preferences to the shared edit buffer without committing them", () => {
		const values = defaults()
		const setCachedStateField = vi.fn()
		const setExperimentEnabled = vi.fn()
		render(
			<ToolsAgentsSettings
				values={values}
				setCachedStateField={setCachedStateField}
				setExperimentEnabled={setExperimentEnabled}
				isActive
				committedCustomToolsEnabled={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Disable built-in skill" }))
		fireEvent.click(screen.getByRole("button", { name: "Disable agents" }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle MCP" }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle saved grants" }))
		openAdvanced()
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:customTools.name" }))

		expect(setCachedStateField.mock.calls).toEqual([
			["disabledBuiltinSkills", ["review-agent"]],
			["subagentsEnabled", false],
			["mcpEnabled", false],
			["alwaysAllowMcp", true],
		])
		expect(setExperimentEnabled).toHaveBeenCalledExactlyOnceWith("customTools", true)
		expect(values.mcpEnabled).toBe(true)
		expect(values.alwaysAllowMcp).toBe(false)
		expect(values.experiments.customTools).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not load saved executable tools until their advanced details are opened", async () => {
		const values = { ...defaults(), experiments: { customTools: true, preventFocusDisruption: false } }
		render(
			<ToolsAgentsSettings
				values={values}
				setCachedStateField={vi.fn()}
				setExperimentEnabled={vi.fn()}
				isActive
				committedCustomToolsEnabled
			/>,
		)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		openAdvanced()
		await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "refreshCustomTools" }))
	})

	it("keeps hidden settings-index mounts inactive even with saved tools and open details", async () => {
		const values = { ...defaults(), experiments: { customTools: true, preventFocusDisruption: false } }
		const props = {
			values,
			setCachedStateField: vi.fn(),
			setExperimentEnabled: vi.fn(),
			committedCustomToolsEnabled: true,
		}
		const { rerender } = render(<ToolsAgentsSettings {...props} isActive={false} />)
		openAdvanced()
		expect(vscode.postMessage).not.toHaveBeenCalled()

		rerender(<ToolsAgentsSettings {...props} isActive />)
		await waitFor(() => expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "refreshCustomTools" }))
	})
})
