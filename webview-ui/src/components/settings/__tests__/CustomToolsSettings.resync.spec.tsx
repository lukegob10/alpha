import { render, screen, waitFor } from "@/utils/test-utils"
import { describe, expect, it, vi } from "vitest"

import { CustomToolsSettings } from "../CustomToolsSettings"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("editing settings with the real VS Code checkbox", () => {
	it("does not turn saved custom-tool enablement updates into buffered edits", async () => {
		const onChange = vi.fn()
		const props = { committedEnabled: false, isActive: false, onChange }
		const { rerender } = render(<CustomToolsSettings {...props} enabled={false} />)
		const warningId = screen.getByText("settings:customTools.executableWarning").id
		expect(warningId).not.toBe("")
		expect(screen.getByRole("checkbox")).toHaveAttribute("aria-describedby", warningId)

		rerender(<CustomToolsSettings {...props} enabled />)
		await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("checked", true))
		rerender(<CustomToolsSettings {...props} enabled={false} />)
		await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("checked", false))
		expect(screen.getByText("settings:customTools.executableWarning")).toHaveAttribute("id", warningId)
		expect(screen.getByRole("checkbox")).toHaveAttribute("aria-describedby", warningId)

		expect(onChange).not.toHaveBeenCalled()
	})
})
