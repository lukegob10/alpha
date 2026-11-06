import userEvent from "@testing-library/user-event"

import { act, cleanup, fireEvent, render, screen, waitFor } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"

import { ApiConfigSelector } from "../ApiConfigSelector"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const configurations = Array.from({ length: 7 }, (_, index) => ({
	id: `config-${index + 1}`,
	name: `Config ${index + 1}`,
}))

const selector = (onChange = vi.fn(), isVisible?: boolean) => (
	<div hidden={isVisible === false}>
		<ApiConfigSelector
			value="config-1"
			displayName="Config 1"
			title="Profile"
			listApiConfigMeta={configurations}
			togglePinnedApiConfig={vi.fn()}
			onChange={onChange}
			isVisible={isVisible}
		/>
	</div>
)

const getTrigger = () => screen.getByTestId("dropdown-trigger")

const flushPopoverEffects = async () => {
	await act(async () => {
		await vi.runOnlyPendingTimersAsync()
	})
}

describe("composer selector visibility", () => {
	let restoreFocus: () => void
	let portal: HTMLDivElement
	const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")

	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
		Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() })
		portal = document.createElement("div")
		portal.id = "alpha-portal"
		document.body.append(portal)
	})

	afterEach(() => {
		cleanup()
		portal.remove()
		restoreFocus()
		if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor)
		else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("closes the profile portal on hide without restoring focus to its hidden trigger or reopening on return", async () => {
		const onChange = vi.fn()
		const view = render(selector(onChange))
		const trigger = getTrigger()
		fireEvent.click(trigger)
		expect(portal).toContainElement(screen.getByRole("dialog"))
		const focus = vi.spyOn(trigger, "focus")

		vi.useFakeTimers()
		view.rerender(selector(onChange, false))
		await flushPopoverEffects()
		expect(screen.queryByRole("dialog", { hidden: true })).not.toBeInTheDocument()
		expect(getTrigger()).toBe(trigger)
		expect(focus).not.toHaveBeenCalled()

		fireEvent.click(trigger)
		view.rerender(selector(onChange))
		await flushPopoverEffects()
		expect(getTrigger()).toBe(trigger)
		expect(trigger).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("retains keyboard open, Escape focus restoration, and profile selection while visible", async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(selector(onChange))
		const trigger = getTrigger()
		trigger.focus()
		await user.keyboard("{Enter}")
		expect(screen.getByRole("dialog")).toBeInTheDocument()
		await user.keyboard("{Escape}")
		await waitFor(() => expect(trigger).toHaveFocus())
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

		await user.keyboard("{Enter}")
		await user.click(screen.getByRole("button", { name: "Config 2" }))
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith("config-2")
	})

	it("preserves an unfinished profile search when hidden and reopened", async () => {
		const onChange = vi.fn()
		const view = render(selector(onChange))
		fireEvent.click(getTrigger())
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Config 2" } })
		vi.useFakeTimers()
		view.rerender(selector(onChange, false))
		await flushPopoverEffects()
		expect(screen.queryByRole("dialog", { hidden: true })).not.toBeInTheDocument()

		view.rerender(selector(onChange))
		fireEvent.click(getTrigger())
		expect(screen.getByRole("textbox")).toHaveValue("Config 2")
		expect(onChange).not.toHaveBeenCalled()
	})
})
