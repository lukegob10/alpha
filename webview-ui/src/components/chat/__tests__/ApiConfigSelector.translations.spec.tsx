import { fireEvent, render, screen, within } from "@/utils/test-utils"
import i18n from "@/i18n/setup"

import { ApiConfigSelector } from "../ApiConfigSelector"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({ useAlphaPortal: () => document.body }))

describe("ApiConfigSelector with real translations", () => {
	it.each([0, 3, 6, 7])("keeps the %i-profile dropdown free of internal labels", (profileCount) => {
		const onChange = vi.fn()
		render(
			<ApiConfigSelector
				value="profile-1"
				displayName="Profile 1"
				title={i18n.t("chat:selectApiConfig")}
				onChange={onChange}
				listApiConfigMeta={Array.from({ length: profileCount }, (_, index) => ({
					id: `profile-${index + 1}`,
					name: `Profile ${index + 1}`,
				}))}
				togglePinnedApiConfig={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByTestId("dropdown-trigger"))

		const dropdown = screen.getByRole("dialog")
		expect(dropdown).toHaveAccessibleName("Select API configuration")
		expect(dropdown).not.toHaveTextContent(/apiConfiguration\.(title|select)/)
		expect(within(dropdown).queryByRole("heading")).not.toBeInTheDocument()
		expect(within(dropdown).getByRole("button", { name: "Edit..." })).toBeInTheDocument()
		if (profileCount > 6) {
			expect(within(dropdown).getByRole("textbox")).toBeInTheDocument()
		} else {
			expect(within(dropdown).queryByRole("textbox")).not.toBeInTheDocument()
		}

		if (profileCount > 1) {
			fireEvent.click(within(dropdown).getByRole("button", { name: "Profile 2" }))
			expect(onChange).toHaveBeenCalledTimes(1)
			expect(onChange).toHaveBeenCalledWith("profile-2")
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		}
	})
})
