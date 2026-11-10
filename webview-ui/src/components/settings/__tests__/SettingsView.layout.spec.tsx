import React from "react"
import { fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { expect } from "vitest"

import SettingsView from "../SettingsView"
import type { PreferencesSettingsProps } from "../PreferencesSettings"
import type { SettingsCachedState, SetSettingsCachedStateField } from "../managed-agent-settings"

const { postMessage, resourceRequests, providerMounts, extensionState } = vi.hoisted(() => ({
	postMessage: vi.fn(),
	resourceRequests: vi.fn(),
	providerMounts: vi.fn(),
	extensionState: {
		didHydrateState: true,
		showWelcome: false,
		currentApiConfigName: "default",
		listApiConfigMeta: [{ id: "profile-a", name: "default" }],
		apiConfiguration: { apiProvider: "openai" as "openai" | undefined },
		uriScheme: "vscode",
		renderContext: "sidebar",
		allowedCommands: [],
		deniedCommands: [],
		experiments: {},
	},
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) => (options?.label ? key + ":" + options.label : key),
	}),
}))
vi.mock("../ApiConfigManager", () => ({ default: () => null }))
vi.mock("../ApiOptions", () => ({
	default: function MockProviderOptions({
		setErrorMessage,
	}: {
		setErrorMessage: (message: string | undefined) => void
	}) {
		const [draft, setDraft] = React.useState("")
		React.useEffect(() => {
			providerMounts()
		}, [])
		return (
			<input
				aria-label="Provider output limit"
				value={draft}
				onChange={(event) => {
					setDraft(event.target.value)
					setErrorMessage(event.target.value === "1e" ? "Invalid provider output limit" : undefined)
				}}
			/>
		)
	},
}))
vi.mock("../AutoApproveSettings", () => ({ AutoApproveSettings: () => <p>Permissions controls</p> }))
vi.mock("../ToolsAgentsSettings", () => ({
	ToolsAgentsSettings: ({
		values,
		setCachedStateField,
		isActive,
	}: {
		values: Pick<SettingsCachedState, "subagentsEnabled">
		setCachedStateField: SetSettingsCachedStateField
		isActive: boolean
	}) => {
		React.useEffect(() => {
			resourceRequests()
		}, [])
		return (
			<button
				data-testid="agent-toggle"
				data-is-active={isActive}
				aria-pressed={values.subagentsEnabled !== false}
				onClick={() => setCachedStateField("subagentsEnabled", values.subagentsEnabled === false)}>
				Toggle agents
			</button>
		)
	},
}))
vi.mock("../UISettings", () => ({
	UISettings: ({ setCachedStateField }: Pick<PreferencesSettingsProps, "setCachedStateField">) => (
		<button data-testid="edit-preference" onClick={() => setCachedStateField("soundEnabled", true)}>
			Enable sound
		</button>
	),
}))
vi.mock("../NotificationSettings", () => ({ NotificationSettings: () => null }))
vi.mock("../MemorySettings", () => ({ MemorySettings: () => null }))
vi.mock("../AdvancedSettings", () => ({ AdvancedSettings: () => <p>Advanced controls</p> }))

function selectPage(section: string) {
	const tab = screen.getByTestId("tab-" + section)
	fireEvent.click(tab)
	return tab
}

function getPanel(section: string): HTMLElement {
	const panel = document.querySelector<HTMLElement>('[role="tabpanel"][data-settings-section="' + section + '"]')
	if (!panel) throw new Error("Missing settings panel: " + section)
	return panel
}

function installSettingsWidth(width: number) {
	const original = globalThis.ResizeObserver
	vi.stubGlobal(
		"ResizeObserver",
		class implements ResizeObserver {
			constructor(private callback: ResizeObserverCallback) {}
			observe(target: Element) {
				const size = { inlineSize: width, blockSize: 600 }
				this.callback(
					[
						{
							target,
							contentRect: new DOMRect(0, 0, width, 600),
							borderBoxSize: [size],
							contentBoxSize: [size],
							devicePixelContentBoxSize: [size],
						},
					],
					this,
				)
			}
			unobserve() {}
			disconnect() {}
		},
	)
	return () => vi.stubGlobal("ResizeObserver", original)
}

describe("SettingsView dedicated pages", () => {
	beforeEach(() => {
		postMessage.mockClear()
		resourceRequests.mockClear()
		providerMounts.mockClear()
		extensionState.showWelcome = false
		extensionState.apiConfiguration.apiProvider = "openai"
	})

	it("presents four labelled tabs and only one accessible selected panel", () => {
		render(<SettingsView onDone={vi.fn()} />)
		const tabs = screen.getAllByRole("tab")
		expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
			"settings:sections.providers",
			"settings:sections.tools",
			"settings:sections.preferences",
			"settings:sections.advanced",
		])
		expect(screen.getByRole("tablist")).toHaveAccessibleName("settings:header.title")
		expect(screen.getAllByRole("tabpanel")).toHaveLength(1)
		const selected = screen.getByRole("tab", { selected: true })
		const panel = screen.getByRole("tabpanel")
		expect(selected).toHaveAccessibleName("settings:sections.providers")
		expect(selected).toHaveAttribute("aria-controls", panel.id)
		expect(panel).toHaveAttribute("aria-labelledby", selected.id)
		expect(panel).toHaveAttribute("data-settings-section", "providers")
		expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([selected])
		for (const section of ["tools", "preferences", "advanced"]) expect(getPanel(section)).not.toBeVisible()
		expect(document.querySelector("[data-settings-section][data-settings-group]")).not.toBeInTheDocument()
		expect(resourceRequests).not.toHaveBeenCalled()
	})

	it("places Permissions first in Preferences without a separate navigation page", () => {
		render(<SettingsView onDone={vi.fn()} targetSection="preferences" />)
		const panel = screen.getByRole("tabpanel")
		const permissions = within(panel).getByText("Permissions controls")
		const preference = within(panel).getByTestId("edit-preference")
		expect(permissions).toBeVisible()
		expect(permissions.compareDocumentPosition(preference) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(screen.queryByTestId("tab-permissions")).not.toBeInTheDocument()
		expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("settings:sections.preferences")
	})

	it.each(["welcome", "missingProvider"] as const)("starts on Providers for %s setup", (reason) => {
		if (reason === "welcome") extensionState.showWelcome = true
		else extensionState.apiConfiguration.apiProvider = undefined
		render(<SettingsView onDone={vi.fn()} />)
		expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("settings:sections.providers")
		expect(screen.getByLabelText("Provider output limit")).toBeVisible()
	})

	it("loads Tools once on selection and retains its draft while inactive", async () => {
		render(<SettingsView onDone={vi.fn()} />)
		expect(screen.queryByTestId("agent-toggle")).not.toBeInTheDocument()
		expect(resourceRequests).not.toHaveBeenCalled()
		selectPage("tools")
		const toggle = await screen.findByTestId("agent-toggle")
		expect(resourceRequests).toHaveBeenCalledTimes(1)
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-pressed", "false")
		selectPage("preferences")
		await waitFor(() => expect(toggle).toHaveAttribute("data-is-active", "false"))
		expect(toggle).not.toBeVisible()
		expect(screen.getByTestId("agent-toggle")).toBe(toggle)
		selectPage("tools")
		await waitFor(() => expect(toggle).toHaveAttribute("data-is-active", "true"))
		expect(resourceRequests).toHaveBeenCalledTimes(1)
		expect(toggle).toHaveAttribute("aria-pressed", "false")
		expect(toggle).toBeVisible()
		expect(screen.getByTestId("save-button")).toBeEnabled()
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})

	it("retains a local invalid provider draft and its Save blocker after changing pages", async () => {
		render(<SettingsView onDone={vi.fn()} targetSection="preferences" />)
		expect(screen.queryByLabelText("Provider output limit")).not.toBeInTheDocument()
		expect(providerMounts).not.toHaveBeenCalled()
		selectPage("providers")
		const input = await screen.findByLabelText("Provider output limit")
		fireEvent.change(input, { target: { value: "1e" } })
		expect(screen.getByRole("alert")).toHaveTextContent("Invalid provider output limit")
		selectPage("preferences")
		fireEvent.click(screen.getByTestId("edit-preference"))
		expect(screen.getByTestId("save-button")).toBeDisabled()
		expect(screen.getByRole("alert")).toHaveTextContent("Invalid provider output limit")
		expect(screen.getByLabelText("Provider output limit")).toBe(input)
		expect(input).not.toBeVisible()
		expect(input).toHaveValue("1e")
		selectPage("providers")
		expect(providerMounts).toHaveBeenCalledTimes(1)
		expect(input).toBeVisible()
		expect(input).toHaveValue("1e")
		fireEvent.change(input, { target: { value: "10" } })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it.each([520, 320, 169])("retains keyboard navigation and panel labels at %spx", (width) => {
		const restoreFocus = installNativeTestFocus()
		const restoreWidth = installSettingsWidth(width)
		try {
			render(<SettingsView onDone={vi.fn()} />)
			const orientation = width < 300 ? "horizontal" : "vertical"
			expect(screen.getByRole("tablist")).toHaveAttribute("aria-orientation", orientation)
			expect(screen.getByRole("tablist")).toHaveAttribute("data-compact", String(width < 500))
			const providers = screen.getByRole("tab", { name: "settings:sections.providers" })
			const tools = screen.getByRole("tab", { name: "settings:sections.tools" })
			const advanced = screen.getByRole("tab", { name: "settings:sections.advanced" })
			providers.focus()
			fireEvent.keyDown(providers, { key: orientation === "horizontal" ? "ArrowRight" : "ArrowDown" })
			expect(tools).toHaveFocus()
			expect(tools).toHaveAttribute("aria-selected", "true")
			expect(providers).toHaveAttribute("tabindex", "-1")
			const panel = screen.getByRole("tabpanel")
			expect(panel).toHaveAttribute("aria-labelledby", tools.id)
			expect(tools).toHaveAttribute("aria-controls", panel.id)
			fireEvent.keyDown(tools, { key: "End" })
			expect(advanced).toHaveFocus()
			expect(advanced).toHaveAttribute("aria-selected", "true")
			fireEvent.keyDown(advanced, { key: "Home" })
			expect(providers).toHaveFocus()
			expect(providers).toHaveAttribute("aria-selected", "true")
		} finally {
			restoreWidth()
			restoreFocus()
		}
	})

	it("restores independent scroll positions when returning to a page", () => {
		render(<SettingsView onDone={vi.fn()} targetSection="preferences" />)
		const scroll = screen.getByTestId("settings-content")
		scroll.scrollTop = 120
		fireEvent.scroll(scroll)
		selectPage("advanced")
		expect(scroll.scrollTop).toBe(0)
		scroll.scrollTop = 75
		fireEvent.scroll(scroll)
		selectPage("preferences")
		expect(scroll.scrollTop).toBe(120)
		selectPage("advanced")
		expect(scroll.scrollTop).toBe(75)
	})

	it("keeps the wrapping header above page navigation", () => {
		render(<SettingsView onDone={vi.fn()} />)
		const header = screen.getByRole("heading", { name: "settings:header.title" }).closest(".glass-header")
		expect(header).toHaveClass("z-20", "flex-wrap", "min-w-0")
		expect(screen.getByTestId("settings-content")).toHaveClass("min-w-0")
	})

	it.each([
		["autoApprove", "preferences"],
		["permissions", "preferences"],
		["agents", "tools"],
		["notifications", "preferences"],
		["terminal", "advanced"],
	])("resolves retained %s links to the %s page", (targetSection, section) => {
		render(<SettingsView onDone={vi.fn()} targetSection={targetSection} />)
		expect(screen.getByRole("tab", { selected: true })).toHaveAccessibleName("settings:sections." + section)
		expect(screen.getByRole("tabpanel")).toBe(getPanel(section))
		expect(screen.getAllByRole("tab")).toHaveLength(4)
		expect(document.querySelector("[data-settings-section][data-settings-group]")).not.toBeInTheDocument()
	})

	it("opens About from the footer without creating a fifth page", () => {
		render(<SettingsView onDone={vi.fn()} />)
		expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "requestState" })
		postMessage.mockClear()
		fireEvent.click(screen.getByTestId("settings-about-button"))
		expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "switchTab", tab: "about" })
		expect(screen.getAllByRole("tab")).toHaveLength(4)
	})

	it("guards footer navigation until dirty preferences are explicitly discarded", () => {
		render(<SettingsView onDone={vi.fn()} targetSection="preferences" />)
		expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "requestState" })
		postMessage.mockClear()
		fireEvent.click(screen.getByTestId("edit-preference"))
		fireEvent.click(screen.getByTestId("settings-about-button"))
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:unsavedChangesDialog.cancelButton" }))
		fireEvent.click(screen.getByTestId("settings-about-button"))
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchTab" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:unsavedChangesDialog.discardButton" }))
		expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "switchTab", tab: "about" })
	})
})
