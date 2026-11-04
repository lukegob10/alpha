import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { TicketImportPreview } from "@alpha-code/types"
import { TicketExportDialog, TicketImportDialog } from "../TicketTransfer"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const preview: TicketImportPreview = {
	kind: "importPreview",
	token: "e79288ad-9c54-4c46-9073-a5fb6098142b",
	tickets: [
		{
			id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
			name: "Shared work",
			status: "complete",
			disposition: "conflict",
			changes: [{ field: "description", before: "Local requirements", after: "Shared requirements" }],
		},
	],
	warnings: [],
}

describe("ticket transfer review", () => {
	it("defaults to copies with backlog status and requires explicit review for updates", () => {
		const onImport = vi.fn()
		render(<TicketImportDialog preview={preview} busy={false} onCancel={() => {}} onImport={onImport} />)
		const commit = screen.getByRole("button", { name: "transfer.confirmImport" })
		fireEvent.click(commit)
		expect(onImport).toHaveBeenLastCalledWith("copy", true)
		fireEvent.click(screen.getByRole("radio", { name: "transfer.update" }))
		expect(screen.getByText("Local requirements")).toBeVisible()
		expect(screen.getByText("Shared requirements")).toBeVisible()
		expect(screen.getByRole("checkbox", { name: "transfer.resetStatus" })).not.toBeChecked()
		expect(commit).toBeDisabled()
		fireEvent.click(screen.getByRole("checkbox", { name: "transfer.reviewedUpdates" }))
		fireEvent.click(commit)
		expect(onImport).toHaveBeenLastCalledWith("update", false)
	})

	it("exports an explicit scope and descendant preference", () => {
		const onExport = vi.fn()
		render(
			<TicketExportDialog
				selectedCount={2}
				filteredCount={80}
				busy={false}
				onCancel={() => {}}
				onExport={onExport}
			/>,
		)
		expect(screen.getByRole("radio", { name: "transfer.scope.selected" })).toBeChecked()
		fireEvent.click(screen.getByRole("radio", { name: "transfer.scope.filtered" }))
		fireEvent.click(screen.getByRole("checkbox", { name: "transfer.includeDescendants" }))
		fireEvent.click(screen.getByRole("button", { name: "transfer.saveExport" }))
		expect(onExport).toHaveBeenCalledWith("filtered", false)
	})

	it("prevents double commits and cancellation while the import is saving", () => {
		const onCancel = vi.fn()
		const onImport = vi.fn()
		render(<TicketImportDialog preview={preview} busy onCancel={onCancel} onImport={onImport} />)
		expect(screen.getByRole("button", { name: "transfer.importing" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "cancel" })).toBeDisabled()
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" })
		expect(onCancel).not.toHaveBeenCalled()
		expect(onImport).not.toHaveBeenCalled()
	})
})
