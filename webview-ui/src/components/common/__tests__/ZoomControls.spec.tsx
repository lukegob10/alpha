import { fireEvent, render, screen } from "@/utils/test-utils"

import { ZoomControls } from "../ZoomControls"

const renderContinuousZoom = (adjustZoom: (amount: number) => void) =>
	render(
		<ZoomControls
			zoomLevel={1}
			zoomInTitle="Zoom in"
			zoomOutTitle="Zoom out"
			useContinuousZoom
			adjustZoom={adjustZoom}
			zoomInStep={0.2}
			zoomOutStep={-0.2}
		/>,
	)

describe("ZoomControls", () => {
	it.each([
		["Enter", "Enter"],
		["Space", " "],
	])("applies one continuous zoom step when activated with %s", (_name, key) => {
		const adjustZoom = vi.fn()
		renderContinuousZoom(adjustZoom)

		const zoomIn = screen.getByRole("button", { name: "Zoom in" })
		const eventWasNotCancelled = fireEvent.keyDown(zoomIn, { key })

		expect(eventWasNotCancelled).toBe(false)
		expect(adjustZoom).toHaveBeenCalledTimes(1)
		expect(adjustZoom).toHaveBeenCalledWith(0.2)
	})

	it("does not add a click step after the initial continuous mouse step", () => {
		const adjustZoom = vi.fn()
		renderContinuousZoom(adjustZoom)

		const zoomOut = screen.getByRole("button", { name: "Zoom out" })
		fireEvent.mouseDown(zoomOut)
		fireEvent.click(zoomOut)
		fireEvent.mouseUp(zoomOut)

		expect(adjustZoom).toHaveBeenCalledTimes(1)
		expect(adjustZoom).toHaveBeenCalledWith(-0.2)
	})
})
