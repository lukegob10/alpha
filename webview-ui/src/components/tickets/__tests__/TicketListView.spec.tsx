import { useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { TicketList, TicketStatus } from "@alpha-code/types"
import { TicketListView } from "../TicketListView"

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const list: TicketList = {
	tickets: [
		{
			id: "active",
			name: "Active ticket",
			status: "in-progress",
			updatedAt: "2026-09-07T00:00:00.000Z",
			revision: "v1",
			childCount: 0,
			completedChildCount: 0,
		},
		{
			id: "backlog",
			name: "Backlog ticket",
			status: "backlog",
			updatedAt: "2026-09-07T00:00:00.000Z",
			revision: "v1",
			childCount: 0,
			completedChildCount: 0,
		},
	],
	total: 2,
	invalidFiles: [],
}
function List({
	data = list,
	initiallyCollapsed = [],
	returnToTicket,
	onOpen = () => {},
}: {
	data?: TicketList
	initiallyCollapsed?: TicketStatus[]
	returnToTicket?: string
	onOpen?: (id: string) => void
}) {
	const [collapsedStatuses, setCollapsedStatuses] = useState<TicketStatus[]>(initiallyCollapsed)
	return (
		<TicketListView
			list={data}
			query=""
			typeFilter={undefined}
			onTypeFilterChange={() => {}}
			offset={0}
			busy={false}
			returnToTicket={returnToTicket}
			onQueryChange={() => {}}
			onPageChange={() => {}}
			onOpen={onOpen}
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
	it("renders one table with compact ticket, priority, type, and update columns", () => {
		render(<List />)
		const table = screen.getByRole("table", { name: "title" })
		expect(screen.getAllByRole("table")).toHaveLength(1)
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((header) => header.textContent),
		).toEqual(["ticketColumn", "priority", "type", "updated"])
	})
	it("shows a child beneath its parent across statuses and expands it independently of the group", () => {
		const data: TicketList = {
			...list,
			tickets: [
				{ ...list.tickets[0], id: "parent", name: "Parent", childCount: 1, completedChildCount: 1 },
				{ ...list.tickets[1], id: "child", name: "Child", parentId: "parent", status: "complete" },
			],
		}
		const onOpen = vi.fn()
		render(<List data={data} onOpen={onOpen} />)
		expect(screen.getByRole("button", { name: /^in-progress/ })).toHaveTextContent("2")
		expect(screen.queryByRole("button", { name: /^complete/ })).not.toBeInTheDocument()
		const child = screen.getByRole("button", { name: /^Child/ }).closest("tr")!
		expect(child).toHaveAttribute("data-depth", "1")
		const expander = screen.getByRole("button", { name: "collapseChildren" })
		fireEvent.click(expander)
		expect(onOpen).not.toHaveBeenCalled()
		expect(expander).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("button", { name: /^Child/ })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "expandChildren" }))
		fireEvent.click(screen.getByRole("button", { name: /^Child/ }))
		expect(screen.getByRole("button", { name: /^Child/ })).toBeVisible()
		expect(onOpen).toHaveBeenCalledWith("child")
	})
	it("shows project-wide progress even when children are outside the current page", () => {
		render(
			<List
				data={{ ...list, tickets: [{ ...list.tickets[0], childCount: 3, completedChildCount: 2 }], total: 4 }}
			/>,
		)
		const row = screen.getByRole("button", { name: /Active ticket/ })
		expect(within(row).getByText("2/3")).toHaveAttribute("aria-label", "childProgress")
		expect(screen.queryByRole("button", { name: "collapseChildren" })).not.toBeInTheDocument()
	})
	it("keeps a filtered child visible when its parent is not on the page", () => {
		render(<List data={{ ...list, tickets: [{ ...list.tickets[1], parentId: "outside-page" }], total: 1 }} />)
		expect(screen.getByRole("button", { name: /Backlog ticket/ })).toBeVisible()
		expect(screen.getByRole("button", { name: /Backlog ticket/ }).closest("tr")).toHaveAttribute("data-depth", "0")
	})
	it("keeps malformed cyclic parent links visible as separate roots", () => {
		render(
			<List
				data={{
					...list,
					tickets: [
						{ ...list.tickets[0], parentId: "backlog" },
						{ ...list.tickets[1], parentId: "active" },
					],
				}}
			/>,
		)
		expect(screen.getByRole("button", { name: /Active ticket/ }).closest("tr")).toHaveAttribute("data-depth", "0")
		expect(screen.getByRole("button", { name: /Backlog ticket/ }).closest("tr")).toHaveAttribute("data-depth", "0")
	})
	it("shows ticket status without editable controls in list rows", () => {
		render(<List />)
		expect(screen.getByRole("row", { name: /Active ticket/ })).toHaveAttribute("data-status", "in-progress")
		expect(screen.queryByRole("combobox", { name: "statusOf" })).not.toBeInTheDocument()
	})
	it("shows classification labels on rows and leaves legacy rows untagged", () => {
		render(<List data={{ ...list, tickets: [{ ...list.tickets[0], type: "bug" }, list.tickets[1]] }} />)
		expect(within(screen.getByRole("row", { name: /Active ticket/ })).getByText("types.bug")).toBeVisible()
		expect(
			within(screen.getByRole("row", { name: /Backlog ticket/ })).queryByText("types.bug"),
		).not.toBeInTheDocument()
	})
	it("shows a neutral dash for missing priority and labels persisted priorities", () => {
		render(<List data={{ ...list, tickets: [{ ...list.tickets[0], priority: "high" }, list.tickets[1]] }} />)
		const active = screen.getByRole("row", { name: /Active ticket/ })
		const backlog = screen.getByRole("row", { name: /Backlog ticket/ })
		expect(within(active).getByText("priorities.high", { selector: ".ticket-priority" })).toBeVisible()
		expect(within(backlog).getByLabelText("noPriority")).toHaveTextContent("—")
	})
	it("adds an accessible inline priority label to the ticket title cell", () => {
		render(<List data={{ ...list, tickets: [{ ...list.tickets[0], priority: "high" }, list.tickets[1]] }} />)
		const active = screen.getByRole("row", { name: /Active ticket/ })
		const activeInline = active.querySelector(".ticket-priority-inline")
		expect(activeInline).toHaveAttribute("data-priority", "high")
		expect(activeInline).toHaveTextContent("priorities.high")
		expect(
			within(active).getByRole("button", { name: /Active ticket.*priority: priorities\.high/ }),
		).toBeInTheDocument()

		const backlog = screen.getByRole("row", { name: /Backlog ticket/ })
		const backlogInline = backlog.querySelector(".ticket-priority-inline")
		expect(backlogInline).toHaveAttribute("data-priority", "none")
		expect(backlogInline).toHaveTextContent("—")
		expect(within(backlog).getByRole("button", { name: /Backlog ticket.*noPriority/ })).toBeInTheDocument()
	})
	it("hides status group headings when the collection is empty", () => {
		render(<List data={{ tickets: [], total: 0, invalidFiles: [] }} />)
		expect(
			screen.queryByRole("button", { name: /^in-progress|^backlog|^complete|^canceled/ }),
		).not.toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("empty")
	})
	it("collapses each visible section independently", () => {
		render(<List />)
		const active = screen.getByRole("button", { name: /^in-progress/ })
		fireEvent.click(active)
		expect(active).toHaveAttribute("aria-expanded", "false")
		expect(document.getElementById(active.getAttribute("aria-controls")!)).not.toBeVisible()
		expect(screen.queryByRole("button", { name: /Active ticket/ })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Backlog ticket/ })).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2)
		fireEvent.click(active)
		expect(screen.getByRole("button", { name: /Active ticket/ })).toBeVisible()
		expect(screen.queryByRole("button", { name: /Backlog ticket/ })).not.toBeInTheDocument()
	})
	it.each([false, true])("restores focus to the collapsed group for a returning child: %s", (isChild) => {
		// Shared test setup mocks DOM focus; verify the requested focus target here, keyboard activation in-browser.
		const focus = vi.fn()
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, get: () => focus })
		try {
			const data = isChild
				? {
						...list,
						tickets: [
							{ ...list.tickets[1], childCount: 1 },
							{ ...list.tickets[0], parentId: "backlog" },
						],
					}
				: list
			render(
				<List data={data} initiallyCollapsed={["backlog"]} returnToTicket={isChild ? "active" : "backlog"} />,
			)
			expect(focus.mock.contexts.at(-1)).toBe(screen.getByRole("button", { name: /^backlog/ }))
			expect(focus).toHaveBeenCalledWith({ preventScroll: true })
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", original)
		}
	})
	it("restores collapse choice when a filtered section reappears", () => {
		const view = render(<List />)
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		view.rerender(<List data={{ ...list, tickets: [list.tickets[0]], total: 1 }} />)
		expect(screen.queryByRole("button", { name: /^backlog/ })).not.toBeInTheDocument()
		view.rerender(<List />)
		expect(screen.getByRole("button", { name: /^backlog/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("button", { name: /Backlog ticket/ })).not.toBeInTheDocument()
	})
})
