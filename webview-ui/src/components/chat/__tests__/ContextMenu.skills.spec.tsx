import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import ContextMenu from "../ContextMenu"
import { ContextMenuOptionType } from "@/utils/context-mentions"
import { vscode } from "@/utils/vscode"

vi.mock("i18next", () => ({ t: (key: string) => key }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("vscode-material-icons", () => ({
	getIconForFilePath: vi.fn(),
	getIconUrlByName: vi.fn(),
	getIconForDirectoryPath: vi.fn(),
}))

it("keeps slash skill selection and opens Skills settings from the menu", () => {
	const onSelect = vi.fn()
	render(
		<ContextMenu
			id="slash-skills"
			onSelect={onSelect}
			searchQuery="/"
			onMouseDown={vi.fn()}
			onMouseUp={vi.fn()}
			selectedIndex={0}
			setSelectedIndex={vi.fn()}
			options={[
				{
					type: ContextMenuOptionType.Command,
					value: "review",
					slashCommand: "/review",
					description: "Review changes",
				},
			]}
		/>,
	)
	fireEvent.click(screen.getByRole("option", { name: /review/i }))
	expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.Command, "review")
	fireEvent.click(screen.getByRole("button", { name: "chat:slashSkills.manageSkills" }))
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "switchTab",
		tab: "settings",
		values: { section: "skills" },
	})
})
