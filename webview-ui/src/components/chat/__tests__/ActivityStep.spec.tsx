import { fireEvent, render, screen } from "@testing-library/react"
import { ActivityStep } from "../ActivityStep"

describe("ActivityStep", () => {
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
})
