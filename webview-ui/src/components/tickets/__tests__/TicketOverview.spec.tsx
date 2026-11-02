import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TicketOverview as TicketOverviewData } from "@alpha-code/types"
import { TicketOverview } from "../TicketOverview"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		i18n: { resolvedLanguage: "en" },
		t: (key: string, options?: Record<string, string | number>) => {
			if (key === "overview.percentage") return `${options?.percent}% complete`
			if (key === "overview.completedCount") return `${options?.complete} of ${options?.total} complete`
			if (key === "overview.pointSummary")
				return `${options?.date}: ${options?.complete} completed of ${options?.total}`
			if (key === "overview.completedValue") return `Completed: ${options?.count}`
			if (key === "overview.scopeValue") return `Total scope: ${options?.count}`
			return key
		},
	}),
}))

const overview: TicketOverviewData = {
	total: 30,
	complete: 18,
	inProgress: 4,
	backlog: 8,
	canceled: 2,
	points: [
		{ date: "2026-10-01", total: 20, complete: 0 },
		{ date: "2026-10-15", total: 24, complete: 6 },
		{ date: "2026-10-31", total: 30, complete: 18 },
	],
	invalidFiles: [],
}

let disconnect: ReturnType<typeof vi.fn>
beforeEach(() => {
	disconnect = vi.fn()
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect = disconnect
		},
	)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("TicketOverview", () => {
	it("renders the approved completion ring and completed/scope history", () => {
		const { container, unmount } = render(<TicketOverview overview={overview} loading={false} onRetry={() => {}} />)
		expect(screen.getByRole("img", { name: "60% complete" })).toBeVisible()
		expect(screen.getByRole("heading", { name: "18 of 30 complete" })).toBeVisible()
		expect(screen.getByRole("img", { name: "overview.chart" })).toBeVisible()
		expect(container.querySelector(".ticket-overview-complete-path")).toHaveAttribute(
			"d",
			expect.stringContaining(" C "),
		)
		expect(container.querySelector(".ticket-overview-scope-path")).toHaveAttribute(
			"d",
			expect.stringContaining(" C "),
		)
		unmount()
		expect(disconnect).toHaveBeenCalledOnce()
	})

	it("supports keyboard date inspection using exact integer observations", () => {
		render(<TicketOverview overview={overview} loading={false} onRetry={() => {}} />)
		const slider = screen.getByRole("slider", { name: "overview.inspectDate" })
		fireEvent.focus(slider)
		expect(slider).toHaveAttribute("aria-valuetext", "Oct 31, 2026: 18 completed of 30")
		fireEvent.change(slider, { target: { value: "1" } })
		expect(slider).toHaveAttribute("aria-valuetext", "Oct 15, 2026: 6 completed of 24")
		expect(screen.getByRole("status")).toHaveTextContent("Oct 15, 2026: 6 completed of 24")
		expect(screen.getByText("Completed: 6")).toBeVisible()
		expect(screen.getByText("Total scope: 24")).toBeVisible()
	})
	it("supports touch selection at narrow widths without announcing transient hover changes", () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 320, left: 0 } as DOMRect)
		const { container } = render(<TicketOverview overview={overview} loading={false} onRetry={() => {}} />)
		const chart = screen.getByRole("img", { name: "overview.chart" })
		expect(chart).toHaveAttribute("viewBox", "0 0 320 280")
		fireEvent(chart, new MouseEvent("pointerdown", { clientX: 44, bubbles: true }))
		fireEvent.pointerLeave(chart)
		expect(screen.getByText("Completed: 0")).toBeVisible()
		expect(screen.getByRole("status")).toHaveTextContent("Oct 1, 2026: 0 completed of 20")
		fireEvent(chart, new MouseEvent("pointermove", { clientX: 304, bubbles: true }))
		expect(screen.getByText("Completed: 18")).toBeVisible()
		expect(screen.getByRole("status")).toHaveTextContent("Oct 1, 2026: 0 completed of 20")
		expect(container.querySelector(".ticket-overview-tooltip")).toHaveStyle({ left: "120px" })
	})
	it("reserves 100 percent for an actually completed scope", () => {
		render(
			<TicketOverview
				overview={{ ...overview, total: 1000, complete: 999 }}
				loading={false}
				onRetry={() => {}}
			/>,
		)
		expect(screen.getByRole("img", { name: "99% complete" })).toBeVisible()
	})

	it("uses only the single observed day when history is new", () => {
		const { container } = render(
			<TicketOverview
				overview={{ ...overview, points: overview.points.slice(-1) }}
				loading={false}
				onRetry={() => {}}
			/>,
		)
		expect(screen.getByText("overview.firstObservation")).toBeVisible()
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		expect(container.querySelector(".ticket-overview-complete-path")?.getAttribute("d")).not.toContain("C")
		expect(container.querySelectorAll(".ticket-overview-complete-dot")).toHaveLength(1)
	})

	it("handles an empty project without NaN or an invented percentage", () => {
		render(
			<TicketOverview
				overview={{ ...overview, total: 0, complete: 0, points: [] }}
				loading={false}
				onRetry={() => {}}
			/>,
		)
		expect(screen.getByRole("img", { name: "0% complete" })).toBeVisible()
		expect(screen.getByText("overview.empty")).toBeVisible()
		expect(screen.getByText("overview.noHistory")).toBeVisible()
		expect(screen.queryByRole("img", { name: "overview.chart" })).not.toBeInTheDocument()
	})

	it("offers retry on failure and exposes initial loading", () => {
		const onRetry = vi.fn()
		const { rerender } = render(<TicketOverview overview={undefined} loading={true} onRetry={onRetry} />)
		expect(screen.getByRole("status")).toHaveTextContent("overview.loading")
		expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true")
		rerender(<TicketOverview overview={undefined} loading={false} error="Storage unavailable" onRetry={onRetry} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Storage unavailable")
		fireEvent.click(screen.getByRole("button", { name: "reload" }))
		expect(onRetry).toHaveBeenCalledOnce()
	})

	it("clears a selected day when the history date set changes", () => {
		const { rerender } = render(<TicketOverview overview={overview} loading={false} onRetry={() => {}} />)
		fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } })
		expect(screen.getByRole("status")).toHaveTextContent("Oct 1, 2026")
		rerender(
			<TicketOverview
				overview={{ ...overview, points: overview.points.slice(-1) }}
				loading={false}
				onRetry={() => {}}
			/>,
		)
		expect(screen.getByRole("status")).toBeEmptyDOMElement()
	})
})
