import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { TicketList, TicketStatus } from "@alpha-code/types"
import { TicketListView } from "../TicketListView"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const list: TicketList = {
	tickets: [
		{ id: "active", name: "Active ticket", status: "in-progress", updatedAt: "2026-09-07T00:00:00.000Z" },
		{ id: "backlog", name: "Backlog ticket", status: "backlog", updatedAt: "2026-09-07T00:00:00.000Z" },
	],
	total: 2,
	invalidFiles: [],
}
function List({
	data = list,
	initiallyCollapsed = [],
	returnToTicket,
}: {
	data?: TicketList
	initiallyCollapsed?: TicketStatus[]
	returnToTicket?: string
}) {
	const [collapsedStatuses, setCollapsedStatuses] = useState<TicketStatus[]>(initiallyCollapsed)
	return (
		<TicketListView
			list={data}
			query=""
			offset={0}
			busy={false}
			returnToTicket={returnToTicket}
			onQueryChange={() => {}}
			onPageChange={() => {}}
			onOpen={() => {}}
			collapsedStatuses={collapsedStatuses}
			onToggleStatus={(status) =>
				setCollapsedStatuses((current) =>
					current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
				)
			}
		/>
	)
}

describe("ticket status sections", () => {
	it("keeps all three headings visible when the collection is empty", () => {
		render(<List data={{ tickets: [], total: 0, invalidFiles: [] }} />)
		expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
			"in-progress0",
			"backlog0",
			"complete0",
		])
		for (const status of ["in-progress", "backlog", "complete"])
			expect(screen.getByRole("button", { name: new RegExp(status) })).toHaveAttribute("aria-expanded", "true")
	})
	it("collapses each section independently while keeping every header visible", () => {
		render(<List />)
		const active = screen.getByRole("button", { name: /^in-progress/ })
		fireEvent.click(active)
		expect(active).toHaveAttribute("aria-expanded", "false")
		expect(document.getElementById(active.getAttribute("aria-controls")!)).not.toBeVisible()
		expect(screen.queryByRole("button", { name: /Active ticket/ })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Backlog ticket/ })).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		fireEvent.click(screen.getByRole("button", { name: /^complete/ }))
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3)
		fireEvent.click(active)
		expect(screen.getByRole("button", { name: /Active ticket/ })).toBeVisible()
		expect(screen.queryByRole("button", { name: /Backlog ticket/ })).not.toBeInTheDocument()
	})
	it("restores focus to the header when the returning ticket's section is collapsed", () => {
		// Shared test setup mocks DOM focus; verify the requested focus target here, keyboard activation in-browser.
		const focus = vi.fn()
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, get: () => focus })
		try {
			render(<List initiallyCollapsed={["backlog"]} returnToTicket="backlog" />)
			expect(focus.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /^backlog/ }))
			expect(focus).toHaveBeenCalledWith({ preventScroll: true })
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", original)
		}
	})
	it("keeps headers and collapse choices when filtering leaves a section empty", () => {
		const view = render(<List />)
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		view.rerender(<List data={{ tickets: [], total: 0, invalidFiles: [] }} />)
		expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
			"in-progress0",
			"backlog0",
			"complete0",
		])
		expect(screen.getByRole("button", { name: /^backlog/ })).toHaveAttribute("aria-expanded", "false")
		view.rerender(<List />)
		expect(screen.getByRole("button", { name: /^backlog/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("button", { name: /Backlog ticket/ })).not.toBeInTheDocument()
	})
})
