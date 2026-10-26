import userEvent from "@testing-library/user-event"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { ActivityStep } from "../ActivityStep"

describe("ActivityStep", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it("stops the collapsed activity animation while keeping expanded work busy", () => {
		const onToggleExpand = vi.fn()
		const props = { summary: "Thinking", active: true, onToggleExpand, children: <div>Activity details</div> }
		const { rerender } = render(<ActivityStep {...props} isExpanded={false} />)
		const button = screen.getByRole("button", { name: "Thinking", expanded: false })
		const detailsId = button.getAttribute("aria-controls")!

		expect(button).toHaveAttribute("aria-busy", "true")
		expect(button.querySelector(".activity-step-toggle--active")).toBeInTheDocument()
		expect(document.getElementById(detailsId)).not.toBeVisible()
		fireEvent.click(button)
		expect(onToggleExpand).toHaveBeenCalledTimes(1)

		rerender(<ActivityStep {...props} isExpanded />)
		expect(button).toHaveAttribute("aria-expanded", "true")
		expect(button).toHaveAttribute("aria-busy", "true")
		expect(button.querySelector(".activity-step-toggle--active")).not.toBeInTheDocument()
		expect(document.getElementById(detailsId)).toBeVisible()

		rerender(<ActivityStep {...props} active={false} isExpanded={false} />)
		expect(button).not.toHaveAttribute("aria-busy")
		expect(button.querySelector(".activity-step-toggle--active")).not.toBeInTheDocument()
		expect(button).toHaveAttribute("aria-controls", detailsId)
		expect(document.getElementById(detailsId)).not.toBeVisible()
	})

	it.each([false, true])(
		"restores focus when collapse hides details (children removed: %s)",
		async (removeChildren) => {
			const user = userEvent.setup()
			const props = { summary: "Tool details", onToggleExpand: vi.fn() }
			const { rerender } = render(
				<ActivityStep {...props} isExpanded>
					<button type="button">Detail action</button>
				</ActivityStep>,
			)
			const toggle = screen.getByRole("button", { name: "Tool details" })
			await user.tab()
			await user.tab()
			expect(screen.getByRole("button", { name: "Detail action" })).toHaveFocus()

			rerender(
				<ActivityStep {...props} isExpanded={false}>
					{removeChildren ? null : <button type="button">Detail action</button>}
				</ActivityStep>,
			)

			expect(toggle).toHaveFocus()
			expect(toggle).toHaveAttribute("aria-expanded", "false")
		},
	)

	it("does not steal focus after the reader moves to the composer", async () => {
		const user = userEvent.setup()
		const props = { summary: "Tool details", onToggleExpand: vi.fn() }
		const content = (isExpanded: boolean) => (
			<>
				<ActivityStep {...props} isExpanded={isExpanded}>
					<button type="button">Detail action</button>
				</ActivityStep>
				<input aria-label="Composer" />
			</>
		)
		const { rerender } = render(content(true))
		await user.tab()
		await user.tab()
		await user.tab()
		const composer = screen.getByRole("textbox", { name: "Composer" })
		expect(composer).toHaveFocus()

		rerender(content(false))

		expect(composer).toHaveFocus()
	})

	it("does not reclaim focus after a deliberate blur to the document", async () => {
		const user = userEvent.setup()
		const props = { summary: "Tool details", onToggleExpand: vi.fn() }
		const content = (isExpanded: boolean) => (
			<ActivityStep {...props} isExpanded={isExpanded}>
				<button type="button">Detail action</button>
			</ActivityStep>
		)
		const { rerender } = render(content(true))
		await user.tab()
		await user.tab()
		await user.click(document.body)
		expect(document.body).toHaveFocus()

		rerender(content(false))

		expect(document.body).toHaveFocus()
	})

	it("leaves focus restoration to an outer disclosure when this header is also hidden", async () => {
		const user = userEvent.setup()
		const props = { summary: "Tool details", onToggleExpand: vi.fn() }
		const content = (isExpanded: boolean) => (
			<div hidden={!isExpanded}>
				<ActivityStep {...props} isExpanded={isExpanded}>
					<button type="button">Detail action</button>
				</ActivityStep>
			</div>
		)
		const { rerender } = render(content(true))
		const toggle = screen.getByRole("button", { name: "Tool details" })
		await user.tab()
		await user.tab()

		rerender(content(false))

		expect(toggle).not.toHaveFocus()
	})
})
