import { expect } from "vitest"
import { DEFAULT_MEMORY_SETTINGS, settingsForApprovalMode } from "@alpha-code/types"

import { fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { PreferencesSettings, type PreferencesSettingsValues } from "../PreferencesSettings"
import { DebugSettings } from "../DebugSettings"
import { revealSettingDetails } from "../settingsNavigation"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) =>
			key === "settings:helpFor" ? "Help for " + options?.label : key,
	}),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

function makeValues(overrides: Partial<PreferencesSettingsValues> = {}): PreferencesSettingsValues {
	return {
		...settingsForApprovalMode("ask"),
		allowedCommands: [],
		deniedCommands: [],
		followupAutoApproveTimeoutMs: 0,
		reasoningBlockCollapsed: true,
		enterBehavior: "send",
		autoSteer: false,
		soundEnabled: false,
		soundVolume: 0.5,
		memorySettings: DEFAULT_MEMORY_SETTINGS,
		...overrides,
	}
}

function findSetting(container: HTMLElement, settingId: string): HTMLElement {
	const setting = container.querySelector<HTMLElement>('[data-setting-id="' + settingId + '"]')
	if (!setting) throw new Error("Missing settings control: " + settingId)
	return setting
}

function openAdvancedPermissions() {
	fireEvent.click(screen.getByText("settings:autoApprove.advanced"))
}

describe("PreferencesSettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("keeps permissions, chat, sound, and memories visible in one shared card", async () => {
		const setCachedStateField = vi.fn()
		const { container } = render(
			<PreferencesSettings values={makeValues()} setCachedStateField={setCachedStateField} />,
		)

		expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1)
		expect(screen.getByRole("heading", { level: 3, name: "settings:sections.preferences" })).toBeInTheDocument()
		expect(
			Array.from(container.querySelectorAll("[data-settings-group]"), (group) =>
				group.getAttribute("data-settings-group"),
			),
		).toEqual(["permissions", "chat-and-sound", "memories"])
		for (const name of [
			"settings:preferences.permissions",
			"settings:preferences.chatAndSound",
			"settings:preferences.memories",
		]) {
			expect(screen.getByRole("heading", { level: 4, name })).toHaveClass("font-semibold")
		}

		await waitFor(() => expect(screen.getByTestId("collapse-thinking-checkbox")).toBeChecked())
		expect(screen.getByTestId("approval-mode-ask")).toHaveAttribute("aria-pressed", "true")
		const pageCard = container.querySelector('[data-settings-page-card="preferences"]')
		expect(pageCard).toBeInTheDocument()
		expect(container.querySelectorAll(".surface-raised")).toHaveLength(1)
		for (const settingId of ["auto-approve-mode", "notifications-sound", "memory-enabled"]) {
			const setting = findSetting(container, settingId)
			expect(setting.closest(".surface-raised")).toBe(pageCard)
			expect(setting).toBeVisible()
		}
		expect(container.querySelector("details[data-settings-preferences]")).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("embeds the grouped preferences without another page heading or introductory copy", async () => {
		render(<PreferencesSettings embedded values={makeValues()} setCachedStateField={vi.fn()} />)

		expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		expect(screen.queryByText("settings:preferences.description")).not.toBeInTheDocument()
		await waitFor(() => expect(screen.getByTestId("collapse-thinking-checkbox")).toBeChecked())
		expect(screen.getByTestId("sound-enabled-checkbox")).not.toBeChecked()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([undefined, false, true])(
		"omits retired preferences without rewriting legacy background value %s on mount",
		async (preventFocusDisruption) => {
			const setCachedStateField = vi.fn()
			const legacyValues = {
				...makeValues(),
				experiments: { preventFocusDisruption, customTools: true },
				telemetrySetting: "enabled",
			}
			const { container } = render(
				<PreferencesSettings values={legacyValues} setCachedStateField={setCachedStateField} />,
			)

			await waitFor(() => expect(screen.getByTestId("collapse-thinking-checkbox")).toBeChecked())
			expect(screen.queryByRole("checkbox", { name: "settings:backgroundEditing.label" })).not.toBeInTheDocument()
			expect(
				screen.queryByRole("button", { name: "Help for settings:backgroundEditing.label" }),
			).not.toBeInTheDocument()
			expect(
				container.querySelector('[data-setting-id="experimental-prevent_focus_disruption"]'),
			).not.toBeInTheDocument()
			expect(container.querySelector('[data-setting-id="about-telemetry"]')).not.toBeInTheDocument()
			expect(screen.queryByText("Allow anonymous error and usage reporting")).not.toBeInTheDocument()
			expect(setCachedStateField).not.toHaveBeenCalled()
			expect(vscode.postMessage).not.toHaveBeenCalled()
		},
	)

	it("routes independent sound and memory edits through the parent buffer without resetting hidden choices", async () => {
		const setCachedStateField = vi.fn()
		const memorySettings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, extractModel: "saved-memory-model" }
		render(
			<PreferencesSettings values={makeValues({ memorySettings })} setCachedStateField={setCachedStateField} />,
		)

		fireEvent.click(screen.getByTestId("sound-enabled-checkbox"))
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:memory.generateMemories.label" }))

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("soundEnabled", true)
			expect(setCachedStateField).toHaveBeenCalledWith("memorySettings", {
				...memorySettings,
				generateMemories: false,
			})
		})
		expect(setCachedStateField).toHaveBeenCalledTimes(2)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps inherited and editable command rules in the Preferences permission controls", async () => {
		const setCachedStateField = vi.fn()
		const { container } = render(
			<PreferencesSettings
				values={makeValues({ allowedCommands: ["pnpm test"], deniedCommands: ["git push"] })}
				inheritedCommandRules={[
					{ source: "workspace", allowedCommands: ["rg"], deniedCommands: ["git reset"] },
				]}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvancedPermissions()
		expect(screen.getByTestId("remove-command-0")).toHaveTextContent("pnpm test")
		expect(screen.getByTestId("remove-denied-command-0")).toHaveTextContent("git push")
		const inherited = findSetting(container, "auto-approve-inherited-commands")
		expect(inherited).toHaveTextContent("rg")
		expect(inherited).toHaveTextContent("git reset")
		for (const setting of container.querySelectorAll('[data-setting-id^="auto-approve-"]')) {
			expect(setting).toHaveAttribute("data-setting-section", "preferences")
		}

		const input = screen.getByTestId("command-input")
		fireEvent.change(input, { target: { value: "pnpm lint" } })
		fireEvent.keyDown(input, { key: "Enter" })

		await waitFor(() =>
			expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("allowedCommands", ["pnpm test", "pnpm lint"]),
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains the Full Access confirmation before buffering approval changes", () => {
		const setCachedStateField = vi.fn()
		render(<PreferencesSettings values={makeValues()} setCachedStateField={setCachedStateField} />)

		fireEvent.click(screen.getByTestId("approval-mode-bypass"))
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("approval-mode-bypass-confirm"))
		expect(Object.fromEntries(setCachedStateField.mock.calls)).toEqual(
			settingsForApprovalMode("bypass", { approvalModeBypassAcknowledged: true }),
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains protected-file, MCP and question-wait permission controls", async () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<PreferencesSettings
				values={makeValues(settingsForApprovalMode("auto"))}
				setCachedStateField={setCachedStateField}
			/>,
		)
		openAdvancedPermissions()
		fireEvent.click(screen.getByTestId("always-allow-write-protected-checkbox"))
		fireEvent.click(screen.getByTestId("always-allow-mcp-checkbox"))

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowWriteProtected", true)
			expect(setCachedStateField).toHaveBeenCalledWith("alwaysAllowMcp", true)
		})
		expect(setCachedStateField).toHaveBeenCalledTimes(2)
		setCachedStateField.mockClear()

		rerender(
			<PreferencesSettings
				values={makeValues({ ...settingsForApprovalMode("bypass"), followupAutoApproveTimeoutMs: 45_000 })}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(
			screen.getByRole("spinbutton", { name: "settings:autoApprove.followupQuestions.timeoutLabel" }),
		).toHaveValue(45)
		fireEvent.click(screen.getByTestId("wait-for-question-answers-checkbox"))

		await waitFor(() =>
			expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("followupAutoApproveTimeoutMs", 0),
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains visible controls and pending command drafts across resync and search", async () => {
		const setCachedStateField = vi.fn()
		const values = makeValues()
		const { container, rerender } = render(
			<PreferencesSettings values={values} setCachedStateField={setCachedStateField} />,
		)
		const thinking = screen.getByTestId("collapse-thinking-checkbox")
		const sound = screen.getByTestId("sound-enabled-checkbox")
		const memory = findSetting(container, "memory-enabled")
		expect(sound.closest("details")).toBeNull()
		expect(memory.closest("details")).toBeNull()
		expect(sound).toBeVisible()
		expect(memory).toBeVisible()

		openAdvancedPermissions()
		const command = screen.getByTestId("command-input")
		fireEvent.change(command, { target: { value: "pnpm pending-draft" } })
		rerender(
			<PreferencesSettings
				values={{ ...values, soundEnabled: true, soundVolume: 0.4 }}
				setCachedStateField={setCachedStateField}
			/>,
		)
		await waitFor(() => expect(sound).toBeChecked())
		expect(screen.getByTestId("collapse-thinking-checkbox")).toBe(thinking)
		expect(screen.getByTestId("sound-enabled-checkbox")).toBe(sound)
		expect(screen.getByTestId("command-input")).toBe(command)
		expect(command).toHaveValue("pnpm pending-draft")

		revealSettingDetails(findSetting(container, "notifications-sound"))
		revealSettingDetails(memory)
		expect(sound).toBeVisible()
		expect(memory.closest("details")).toBeNull()
		expect(within(memory).getByRole("checkbox", { name: "settings:memory.enabled.label" })).toBeVisible()
		expect(findSetting(container, "memory-enabled")).toBe(memory)
		expect(setCachedStateField).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("resynchronizes retained chat and sound choices without writing to the edit buffer", async () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<PreferencesSettings values={makeValues()} setCachedStateField={setCachedStateField} />,
		)

		rerender(
			<PreferencesSettings
				values={makeValues({
					reasoningBlockCollapsed: false,
					enterBehavior: "newline",
					autoSteer: true,
					soundEnabled: true,
					soundVolume: 0.4,
				})}
				setCachedStateField={setCachedStateField}
			/>,
		)
		await waitFor(() => {
			expect(screen.getByTestId("collapse-thinking-checkbox")).not.toBeChecked()
			expect(screen.getByTestId("enter-behavior-checkbox")).toBeChecked()
			expect(screen.getByTestId("auto-steer-checkbox")).toBeChecked()
			expect(screen.getByTestId("sound-enabled-checkbox")).toBeChecked()
		})
		expect(screen.getByRole("slider", { name: "settings:notifications.sound.volumeLabel" })).toHaveAttribute(
			"aria-valuenow",
			"0.4",
		)
		expect(setCachedStateField).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})

describe("relocated diagnostics preferences", () => {
	beforeEach(() => vi.clearAllMocks())

	it("resynchronizes diagnostics without writing and keeps it in Advanced", () => {
		const setDebug = vi.fn()
		const { container, rerender } = render(<DebugSettings debug={false} setDebug={setDebug} />)

		rerender(<DebugSettings debug setDebug={setDebug} />)
		expect(screen.getByRole("checkbox", { name: "settings:about.debugMode.label" })).toBeChecked()
		expect(setDebug).not.toHaveBeenCalled()
		expect(container.querySelector('[data-setting-id="about-debug-mode"]')).toHaveAttribute(
			"data-setting-section",
			"advanced",
		)

		fireEvent.click(screen.getByRole("checkbox", { name: "settings:about.debugMode.label" }))
		expect(setDebug).toHaveBeenCalledExactlyOnceWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
