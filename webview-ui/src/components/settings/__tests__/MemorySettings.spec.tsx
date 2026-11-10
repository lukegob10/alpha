import userEvent from "@testing-library/user-event"

import { cleanup, fireEvent, render, screen, waitFor, within } from "@/utils/test-utils"
import { DEFAULT_MEMORY_SETTINGS } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { MemorySettings } from "../MemorySettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("MemorySettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("embeds memories in Preferences with matching search destinations", () => {
		const { container } = render(<MemorySettings onChange={vi.fn()} embedded section="preferences" />)

		expect(screen.getByRole("heading", { level: 4, name: "settings:memory.title" })).toBeInTheDocument()
		expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		expect(container.querySelector('[data-setting-id="memory-enabled"]')).toHaveAttribute(
			"data-setting-section",
			"preferences",
		)
	})

	it("uses its parent group heading and frame without dropping the cost notice or consent controls", () => {
		const onChange = vi.fn()
		const { container } = render(<MemorySettings onChange={onChange} embedded unframed />)

		expect(container.querySelector(".surface-raised")).not.toBeInTheDocument()
		expect(screen.queryByRole("heading")).not.toBeInTheDocument()
		expect(screen.getByText("settings:memory.costNotice")).toBeVisible()
		expect(screen.getByRole("checkbox", { name: "settings:memory.enabled.label" })).not.toBeChecked()
		expect(screen.getByRole("checkbox", { name: "settings:memory.useMemories.label" })).toBeDisabled()
		expect(onChange).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps cost and storage visible while opening preference help without changing consent", async () => {
		const onChange = vi.fn()
		const { container } = render(
			<MemorySettings memorySettings={{ ...DEFAULT_MEMORY_SETTINGS, enabled: true }} onChange={onChange} />,
		)
		expect(screen.getByText("settings:memory.costNotice")).toBeVisible()
		for (const key of ["enabled", "useMemories", "generateMemories"]) {
			expect(screen.getByRole("checkbox", { name: `settings:memory.${key}.label` })).toBeInTheDocument()
			expect(screen.queryByText(`settings:memory.${key}.description`)).not.toBeInTheDocument()
		}
		const setting = container.querySelector<HTMLElement>('[data-setting-id="memory-useMemories"]')!
		fireEvent.click(within(setting).getByRole("button", { name: "settings:helpFor" }))

		const help = await screen.findByRole("dialog", { name: "settings:helpFor" })
		expect(within(help).getByText("settings:memory.useMemories.description")).toBeVisible()
		expect(onChange).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("defaults to opt-in and only updates the parent edit buffer", () => {
		const onChange = vi.fn()
		render(<MemorySettings onChange={onChange} />)
		expect(screen.getByRole("checkbox", { name: "settings:memory.enabled.label" })).not.toBeChecked()
		expect(screen.getByRole("checkbox", { name: "settings:memory.useMemories.label" })).toBeDisabled()
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:memory.enabled.label" }))
		expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_MEMORY_SETTINGS, enabled: true })
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps reading and generation independent", () => {
		const onChange = vi.fn()
		render(<MemorySettings memorySettings={{ ...DEFAULT_MEMORY_SETTINGS, enabled: true }} onChange={onChange} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:memory.useMemories.label" }))
		expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_MEMORY_SETTINGS, enabled: true, useMemories: false })
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:memory.generateMemories.label" }))
		expect(onChange).toHaveBeenLastCalledWith({
			...DEFAULT_MEMORY_SETTINGS,
			enabled: true,
			generateMemories: false,
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("shows the Codex controls and preserves configuration-only overrides when edited", () => {
		const onChange = vi.fn()
		const settings = {
			...DEFAULT_MEMORY_SETTINGS,
			enabled: true,
			dedicatedTools: true,
			disableOnExternalContext: true,
			maxRolloutsPerStartup: 4,
			extractModel: "custom-extraction-model",
		}
		render(<MemorySettings memorySettings={settings} onChange={onChange} />)
		expect(screen.getAllByRole("checkbox")).toHaveLength(3)
		expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:memory.useMemories.label" }))
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith({ ...settings, useMemories: false })
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("requires confirmation before resetting and leaves form values alone", () => {
		const onChange = vi.fn()
		render(<MemorySettings onChange={onChange} />)
		fireEvent.click(screen.getByRole("button", { name: "settings:memory.reset" }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		const dialog = screen.getByRole("alertdialog", { name: "settings:memory.resetTitle" })
		fireEvent.click(within(dialog).getByRole("button", { name: "settings:memory.cancel" }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "settings:memory.reset" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:memory.confirmReset" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "memoryReset" })
		expect(onChange).not.toHaveBeenCalled()
	})

	it("opens the store while the feature is off without enabling it", () => {
		const onChange = vi.fn()
		render(<MemorySettings onChange={onChange} />)
		fireEvent.click(screen.getByRole("button", { name: "settings:memory.openFolder" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "memoryOpenFolder" })
		expect(onChange).not.toHaveBeenCalled()
	})
})

describe("memory reset keyboard focus", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		vi.clearAllMocks()
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it.each(["Cancel", "Escape"])("returns focus to Reset memories after %s without resetting", async (dismiss) => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<MemorySettings onChange={onChange} />)
		const reset = screen.getByRole("button", { name: "settings:memory.reset" })
		reset.focus()
		expect(reset).toHaveFocus()

		await user.keyboard("{Enter}")

		const dialog = screen.getByRole("alertdialog", { name: "settings:memory.resetTitle" })
		expect(dialog).toHaveClass("settings-confirmation-dialog")
		const cancel = within(dialog).getByRole("button", { name: "settings:memory.cancel" })
		await waitFor(() => expect(cancel).toHaveFocus())
		await user.keyboard(dismiss === "Cancel" ? "{Enter}" : "{Escape}")

		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		await waitFor(() => expect(reset).toHaveFocus())
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(onChange).not.toHaveBeenCalled()
	})
})
