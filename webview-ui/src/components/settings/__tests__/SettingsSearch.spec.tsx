import { act, fireEvent, render, screen } from "@testing-library/react"

import { SettingsSearch } from "../SettingsSearch"
import type { SearchableSettingData } from "../useSettingsSearch"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const index: SearchableSettingData[] = [
	{ settingId: "ui-first", section: "ui", label: "Search a", sectionLabel: "UI" },
	{ settingId: "terminal", section: "terminal", label: "Search bc", sectionLabel: "Terminal" },
	{ settingId: "ui-second", section: "ui", label: "Search def", sectionLabel: "UI" },
]

function renderSearch() {
	const onNavigate = vi.fn()
	render(<SettingsSearch index={index} onNavigate={onNavigate} sections={[]} />)
	const input = screen.getByTestId("settings-search-input")
	fireEvent.focus(input)
	fireEvent.change(input, { target: { value: "Search" } })
	return { input, onNavigate }
}

describe("SettingsSearch", () => {
	afterEach(() => vi.useRealTimers())

	it("names the input and exposes the open list and active option", () => {
		const { input } = renderSearch()
		const listbox = screen.getByRole("listbox")
		const firstOption = screen.getAllByRole("option")[0]

		expect(input).toHaveAccessibleName("settings:search.placeholder")
		expect(input).toHaveAttribute("role", "combobox")
		expect(input).toHaveAttribute("aria-expanded", "true")
		expect(input).toHaveAttribute("aria-controls", listbox.id)
		expect(input).toHaveAttribute("aria-activedescendant", firstOption.id)
		expect(screen.getAllByRole("option").every((option) => option.tabIndex === -1)).toBe(true)
	})

	it("moves through grouped results in their visible order", () => {
		const { input, onNavigate } = renderSearch()
		const options = screen.getAllByRole("option")
		expect(options.map((option) => option.id)).toEqual([
			"settings-search-result-ui-first",
			"settings-search-result-ui-second",
			"settings-search-result-terminal",
		])

		fireEvent.keyDown(input, { key: "ArrowDown" })
		expect(options[1]).toHaveAttribute("aria-selected", "true")
		expect(input).toHaveAttribute("aria-activedescendant", options[1].id)
		fireEvent.keyDown(input, { key: "Enter" })
		expect(onNavigate).toHaveBeenCalledWith("ui", "ui-second")
		expect(input).toHaveValue("")
	})

	it("keeps results open when focus returns before the old blur delay", () => {
		vi.useFakeTimers()
		const { input } = renderSearch()
		fireEvent.blur(input, { relatedTarget: null })
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
		fireEvent.focus(input)
		act(() => vi.advanceTimersByTime(200))
		expect(screen.getByRole("listbox")).toBeInTheDocument()
	})

	it("keeps internal focus transitions open and returns focus after clearing", () => {
		const { input } = renderSearch()
		const clearButton = screen.getByRole("button", { name: "history:clearSearch" })
		fireEvent.blur(input, { relatedTarget: clearButton })
		expect(screen.getByRole("listbox")).toBeInTheDocument()
		// The shared FAST fixture exposes focus through an accessor; replace only this input's method.
		const focus = vi.fn()
		Object.defineProperty(input, "focus", { configurable: true, value: focus })
		fireEvent.click(clearButton)
		expect(input).toHaveValue("")
		expect(input).toHaveAttribute("aria-expanded", "false")
		expect(focus).toHaveBeenCalledTimes(1)
	})

	it("dismisses with Escape and reopens at the last result with ArrowUp", () => {
		const { input } = renderSearch()
		const blur = vi.spyOn(input, "blur")
		fireEvent.keyDown(input, { key: "Escape" })
		expect(input).toHaveAttribute("aria-expanded", "false")
		expect(input).not.toHaveAttribute("aria-activedescendant")
		expect(blur).not.toHaveBeenCalled()
		fireEvent.keyDown(input, { key: "ArrowUp" })
		const options = screen.getAllByRole("option")
		expect(input).toHaveAttribute("aria-activedescendant", options.at(-1)?.id)
		blur.mockRestore()
	})
})
