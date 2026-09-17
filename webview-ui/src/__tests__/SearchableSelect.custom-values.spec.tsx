import { act, cleanup, fireEvent, render, screen } from "@/utils/test-utils"

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

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("renders a selected custom value when custom values are enabled", () => {
		render(<SearchableSelect {...defaultProps} value="custom-location1" allowCustomValue />)

		expect(screen.getByRole("combobox")).toHaveTextContent("custom-location1")
	})

	it("allows selecting trimmed custom search text", async () => {
		vi.useFakeTimers()
		const onValueChange = vi.fn()
		render(
			<SearchableSelect
				{...defaultProps}
				onValueChange={onValueChange}
				allowCustomValue
				customValueLabel={(value) => `Use custom: ${value}`}
				data-testid="custom-select"
			/>,
		)

		fireEvent.click(screen.getByRole("combobox"))
		fireEvent.change(screen.getByPlaceholderText("Search options..."), {
			target: { value: "  custom-location1  " },
		})
		await act(async () => vi.advanceTimersByTimeAsync(100))
		expect(screen.getByPlaceholderText("Search options...")).toHaveValue("  custom-location1  ")
		fireEvent.click(screen.getByTestId("custom-select-custom-option"))

		expect(onValueChange).toHaveBeenCalledWith("custom-location1")
	})

	it("preserves new search text when reopened before an old reset would run", async () => {
		vi.useFakeTimers()
		render(<SearchableSelect {...defaultProps} allowCustomValue />)
		fireEvent.click(screen.getByRole("combobox"))
		fireEvent.change(screen.getByPlaceholderText("Search options..."), { target: { value: "old search" } })
		fireEvent.keyDown(screen.getByPlaceholderText("Search options..."), { key: "Escape" })
		fireEvent.click(screen.getByRole("combobox"))
		fireEvent.change(screen.getByPlaceholderText("Search options..."), { target: { value: "new search" } })
		await act(async () => vi.advanceTimersByTimeAsync(100))
		expect(screen.getByPlaceholderText("Search options...")).toHaveValue("new search")
	})
})
