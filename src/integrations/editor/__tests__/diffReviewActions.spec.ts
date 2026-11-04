const { executeCommand, getCommands, showQuickPick, tabGroups } = vi.hoisted(() => ({
	executeCommand: vi.fn(),
	getCommands: vi.fn(),
	showQuickPick: vi.fn(),
	tabGroups: { activeTabGroup: { activeTab: {} as object | undefined } },
}))

vi.mock("vscode", () => ({ commands: { executeCommand, getCommands }, window: { showQuickPick, tabGroups } }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { showDiffReviewActions } from "../diffReviewActions"

describe("diff review actions", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		getCommands.mockResolvedValue(["diffEditor.setViewMode.sideBySide", "diffEditor.setViewMode.inline"])
		tabGroups.activeTabGroup.activeTab = {}
	})

	it.each(["collapseAll", "expandAll", "goToNextChange", "goToPreviousChange"])(
		"executes native %s",
		async (action) => {
			showQuickPick.mockImplementation(async (items: { command: string }[]) =>
				items.find(({ command }) => command === `multiDiffEditor.${action}`),
			)
			await showDiffReviewActions()
			expect(executeCommand).toHaveBeenCalledExactlyOnceWith(`multiDiffEditor.${action}`)
		},
	)

	it("ignores a cancelled picker", async () => {
		showQuickPick.mockResolvedValue(undefined)
		await showDiffReviewActions()
		expect(executeCommand).not.toHaveBeenCalled()
	})

	it("does not act on another editor when the picker outlives its tab", async () => {
		showQuickPick.mockImplementation(async (items: object[]) => {
			tabGroups.activeTabGroup.activeTab = {}
			return items[0]
		})
		await showDiffReviewActions()
		expect(executeCommand).not.toHaveBeenCalled()
	})
	it.each(["sideBySide", "inline"])("selects the native %s layout only after an explicit choice", async (mode) => {
		showQuickPick.mockImplementation(async (items: { command: string }[]) =>
			items.find(({ command }) => command === `diffEditor.setViewMode.${mode}`),
		)
		await showDiffReviewActions()
		expect(executeCommand).toHaveBeenCalledExactlyOnceWith(`diffEditor.setViewMode.${mode}`)
	})

	it("uses the minimum host's layout toggle when explicit view modes are unavailable", async () => {
		getCommands.mockResolvedValue([])
		showQuickPick.mockImplementation(async (items: { command: string }[]) => {
			expect(items.some(({ command }) => command.startsWith("diffEditor.setViewMode."))).toBe(false)
			return items.find(({ command }) => command === "toggle.diff.renderSideBySide")
		})
		await showDiffReviewActions()
		expect(executeCommand).toHaveBeenCalledExactlyOnceWith("toggle.diff.renderSideBySide")
	})
})
