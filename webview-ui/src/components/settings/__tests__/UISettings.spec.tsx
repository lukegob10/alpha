import { render, fireEvent, waitFor } from "@/utils/test-utils"
import { describe, it, expect, vi } from "vitest"
import { UISettings } from "../UISettings"

describe("UISettings", () => {
	const defaultProps = {
		reasoningBlockCollapsed: true,
		enterBehavior: "send" as const,
		autoSteer: false,
		setCachedStateField: vi.fn(),
	}

	it("renders automatic steering disabled unless explicitly enabled", () => {
		const { getByTestId, rerender } = render(<UISettings {...defaultProps} />)
		const checkbox = getByTestId("auto-steer-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)

		rerender(<UISettings {...defaultProps} autoSteer={true} />)
		expect(checkbox.checked).toBe(true)
	})

	it("buffers the automatic steering choice", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		fireEvent.click(getByTestId("auto-steer-checkbox"))

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("autoSteer", true)
		})
	})

	it("renders the collapse thinking checkbox", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("displays the correct initial state", () => {
		const { getByTestId } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("calls setCachedStateField when checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId } = render(<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = getByTestId("collapse-thinking-checkbox")
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("reasoningBlockCollapsed", false)
		})
	})

	it("updates checkbox state when prop changes", () => {
		const { getByTestId, rerender } = render(<UISettings {...defaultProps} reasoningBlockCollapsed={false} />)
		const checkbox = getByTestId("collapse-thinking-checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(false)

		rerender(<UISettings {...defaultProps} reasoningBlockCollapsed={true} />)
		expect(checkbox.checked).toBe(true)
	})

	it.each(["send", "newline"] as const)(
		"buffers Enter behavior when the current choice is %s",
		async (enterBehavior) => {
			const setCachedStateField = vi.fn()
			const { getByTestId } = render(
				<UISettings
					{...defaultProps}
					enterBehavior={enterBehavior}
					setCachedStateField={setCachedStateField}
				/>,
			)

			fireEvent.click(getByTestId("enter-behavior-checkbox"))

			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith(
					"enterBehavior",
					enterBehavior === "send" ? "newline" : "send",
				)
			})
		},
	)

	it("keeps task capacity out of chat preferences", () => {
		const { queryByRole, queryByTestId } = render(<UISettings {...defaultProps} />)

		expect(queryByRole("spinbutton")).not.toBeInTheDocument()
		expect(queryByTestId("max-concurrent-tasks-input")).not.toBeInTheDocument()
	})

	it("can render inside Preferences without a duplicate page heading", () => {
		const { queryByRole, getByTestId, rerender } = render(<UISettings {...defaultProps} embedded />)

		expect(queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		expect(getByTestId("collapse-thinking-checkbox")).toBeInTheDocument()
		expect(getByTestId("enter-behavior-checkbox")).toBeInTheDocument()
		expect(getByTestId("auto-steer-checkbox")).toBeInTheDocument()

		rerender(<UISettings {...defaultProps} />)
		expect(queryByRole("heading", { level: 3 })).toBeInTheDocument()
	})

	it("indexes the retained chat choices under Preferences", () => {
		const { container } = render(<UISettings {...defaultProps} />)
		const settings = container.querySelectorAll("[data-searchable]")

		expect(settings).toHaveLength(3)
		for (const setting of settings) expect(setting).toHaveAttribute("data-setting-section", "preferences")
	})

	it("can share its parent's card without adding a nested frame", () => {
		const { container, getByTestId } = render(<UISettings {...defaultProps} embedded unframed />)

		expect(container.querySelector(".surface-raised")).not.toBeInTheDocument()
		expect(getByTestId("collapse-thinking-checkbox")).toBeInTheDocument()
		expect(getByTestId("enter-behavior-checkbox")).toBeInTheDocument()
		expect(getByTestId("auto-steer-checkbox")).toBeInTheDocument()
	})

	it("uses supplied buffered preferences without writing on a resync", async () => {
		const setCachedStateField = vi.fn()
		const { getByTestId, rerender } = render(
			<UISettings {...defaultProps} setCachedStateField={setCachedStateField} />,
		)

		rerender(
			<UISettings
				{...defaultProps}
				reasoningBlockCollapsed={false}
				enterBehavior="newline"
				autoSteer={true}
				setCachedStateField={setCachedStateField}
			/>,
		)

		await waitFor(() => {
			expect(getByTestId("collapse-thinking-checkbox")).not.toBeChecked()
			expect(getByTestId("enter-behavior-checkbox")).toBeChecked()
			expect(getByTestId("auto-steer-checkbox")).toBeChecked()
		})
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})
