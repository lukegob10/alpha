import { cleanup, fireEvent, render, screen } from "@/utils/test-utils"
import userEvent from "@testing-library/user-event"

import { SearchableSelect } from "@/components/ui/searchable-select"

describe("SearchableSelect custom values", () => {
	const defaultProps = {
		options: [
			{ value: "option1", label: "Option 1" },
			{ value: "option2", label: "Option 2" },
		],
		placeholder: "Select an option",
		searchPlaceholder: "Search options...",
		emptyMessage: "No options found",
		onValueChange: vi.fn(),
	}

	afterEach(() => cleanup())

	it("renders a selected custom value when custom values are enabled", () => {
		render(<SearchableSelect {...defaultProps} value="custom-location1" allowCustomValue />)

		expect(screen.getByRole("combobox")).toHaveTextContent("custom-location1")
	})

	it("allows selecting trimmed custom search text", async () => {
		const onValueChange = vi.fn()
		const user = userEvent.setup()
		render(
			<SearchableSelect
				{...defaultProps}
				onValueChange={onValueChange}
				allowCustomValue
				customValueLabel={(value) => `Use custom: ${value}`}
				data-testid="custom-select"
			/>,
		)

		await user.click(screen.getByRole("combobox"))
		fireEvent.change(screen.getByPlaceholderText("Search options..."), {
			target: { value: "  custom-location1  " },
		})
		fireEvent.click(await screen.findByTestId("custom-select-custom-option"))

		expect(onValueChange).toHaveBeenCalledWith("custom-location1")
	})
})
