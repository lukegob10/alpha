import { fireEvent, render, screen, within } from "@/utils/test-utils"
import { DEFAULT_MEMORY_SETTINGS } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { MemorySettings } from "../MemorySettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("MemorySettings", () => {
	beforeEach(() => vi.clearAllMocks())

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
