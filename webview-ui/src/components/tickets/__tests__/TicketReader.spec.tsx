import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Ticket, TicketSummary } from "@alpha-code/types"
import { TicketReader } from "../TicketReader"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, string | number>) => {
			const labels: Record<string, string> = {
				description: "Description",
				context: "Context",
				successCriteria: "Success criteria",
				implementationSummary: "Implementation summary",
				priority: "Priority",
				noPriority: "No priority",
				type: "Type",
				work: "Work on ticket",
				edit: "Edit ticket",
				delete: "Delete ticket",
				addChild: "Add child ticket",
				linkedWork: "Linked work",
				subtickets: "Subtickets",
				noSubtickets: "No subtickets",
				noLinkedWork: "No linked conversations",
				relationsLoading: "Loading related tickets…",
				relationsError: "Related tickets could not be loaded",
				savingProperty: "Saving property…",
				updated: "Updated",
				parentTicket: "Parent ticket",
				openParent: "Open parent ticket",
			}
			if (key === "statusOf") return `Status of ${options?.ticket}`
			if (key === "openLinkedConversation") return `Open conversation ${options?.number}`
			if (key === "linkedConversation") return `Conversation ${options?.number}`
			if (key === "types.bug") return "Bug"
			if (key === "types.improvement") return "Improvement"
			if (key === "priorities.high") return "High"
			if (key === "priorities.medium") return "Medium"
			if (key === "priorities.low") return "Low"
			return labels[key] ?? key
		},
	}),
}))

const ticket: Ticket = {
	schemaVersion: 1,
	id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
	reference: "AC-42",
	name: "Preserve ticket drafts on reload",
	status: "in-progress",
	type: "bug",
	priority: "high",
	createdAt: "2026-09-07T00:00:00.000Z",
	updatedAt: "2026-09-25T12:00:00.000Z",
	linkedTaskIds: ["task-linked-1", "task-linked-2"],
	revision: "v1",
	description: "Keep **unsaved edits** intact after a reload.",
	context: "The editor can receive an external file update.",
	successCriteria: "- [x] Restore a draft\n- [ ] Report conflicts",
	implementationSummary: "Preserve the draft and show a review notice.",
}

const summary = (id: string, name: string, reference: string): TicketSummary => ({
	id,
	name,
	reference,
	status: "backlog",
	type: "feature",
	updatedAt: "2026-09-25T12:00:00.000Z",
	revision: "v1",
	childCount: 0,
	completedChildCount: 0,
})

const makeProps = (overrides: Partial<Parameters<typeof TicketReader>[0]> = {}) => ({
	ticket,
	busy: false,
	changed: false,
	onEdit: vi.fn(),
	onAddChild: vi.fn(),
	onWork: vi.fn(),
	onReload: vi.fn(),
	onDelete: vi.fn(),
	onOpenRelated: vi.fn(),
	onOpenLinkedTask: vi.fn(),
	childTickets: [],
	relationsLoading: false,
	onStatusChange: vi.fn(),
	onPriorityChange: vi.fn(),
	onTypeChange: vi.fn(),
	statusPending: false,
	...overrides,
})

const withFocusTracking = (run: () => void) => {
	const previousFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
	const previousActiveElement = Object.getOwnPropertyDescriptor(document, "activeElement")
	const focusState: { activeElement: Element } = { activeElement: document.body }

	Object.defineProperty(document, "activeElement", {
		configurable: true,
		get: () => {
			if (focusState.activeElement instanceof HTMLSelectElement && focusState.activeElement.disabled) {
				focusState.activeElement = document.body
			}
			return focusState.activeElement
		},
	})
	Object.defineProperty(HTMLElement.prototype, "focus", {
		configurable: true,
		value: function (this: HTMLElement) {
			if (this instanceof HTMLSelectElement && this.disabled) return
			focusState.activeElement = this
			this.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
		},
	})

	try {
		run()
	} finally {
		if (previousFocus) Object.defineProperty(HTMLElement.prototype, "focus", previousFocus)
		if (previousActiveElement) Object.defineProperty(document, "activeElement", previousActiveElement)
		else
			Object.defineProperty(document, "activeElement", {
				configurable: true,
				get: () => document.body,
			})
	}
}

describe("TicketReader", () => {
	it("shows the ticket brief, compact metadata, and the real primary work action", () => {
		const props = makeProps()
		const { container } = render(<TicketReader {...props} />)

		expect(screen.getByRole("heading", { name: ticket.name, level: 1 })).toBeVisible()
		expect(screen.getByRole("heading", { name: "Description" })).toBeVisible()
		expect(screen.getByRole("heading", { name: "Context" })).toBeVisible()
		expect(screen.getByRole("heading", { name: "Success criteria" })).toBeVisible()
		expect(screen.getByRole("heading", { name: "Implementation summary" })).toBeVisible()
		expect(screen.queryByRole("heading", { name: "Activity" })).not.toBeInTheDocument()
		expect(container.querySelector("strong")).toHaveTextContent("unsaved edits")
		expect(screen.getByText("AC-42")).toBeVisible()
		expect(screen.getByText("Bug", { selector: ".ticket-type-label" })).toBeVisible()
		expect(screen.getByRole("button", { name: "Work on ticket" })).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "Work on ticket" }))
		expect(props.onWork).toHaveBeenCalledOnce()
	})

	it("updates status, priority, and type through the captured property callbacks", () => {
		const props = makeProps()
		render(<TicketReader {...props} />)

		fireEvent.change(screen.getByRole("combobox", { name: "Status of Preserve ticket drafts on reload" }), {
			target: { value: "complete" },
		})
		fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "medium" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "improvement" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "" } })

		expect(props.onStatusChange).toHaveBeenCalledWith("complete")
		expect(props.onPriorityChange).toHaveBeenNthCalledWith(1, "medium")
		expect(props.onPriorityChange).toHaveBeenNthCalledWith(2, null)
		expect(props.onTypeChange).toHaveBeenNthCalledWith(1, "improvement")
		expect(props.onTypeChange).toHaveBeenNthCalledWith(2, null)
	})

	it("opens actual linked tasks and subtickets, with Add child kept in the Subtickets section", () => {
		const parent = summary("parent-ticket", "Parent ticket", "AC-41")
		const child = summary("child-ticket", "Draft conflict review", "AC-43")
		const props = makeProps({
			ticket: { ...ticket, parentId: parent.id },
			parent,
			childTickets: [child],
		})
		const { container } = render(<TicketReader {...props} />)

		const linkedWork = screen.getByRole("region", { name: "Linked work" })
		const conversation = within(linkedWork).getByRole("button", { name: "Open conversation 1" })
		expect(conversation).toHaveTextContent("Conversation 1")
		expect(conversation).toHaveAttribute("title", "task-linked-1")
		fireEvent.click(conversation)
		expect(props.onOpenLinkedTask).toHaveBeenCalledWith("task-linked-1")

		const subtickets = screen.getByRole("region", { name: "Subtickets" })
		fireEvent.click(within(subtickets).getByRole("button", { name: /AC-43.*Draft conflict review/ }))
		expect(props.onOpenRelated).toHaveBeenCalledWith(child.id)
		fireEvent.click(within(subtickets).getByRole("button", { name: "Add child ticket" }))
		expect(props.onAddChild).toHaveBeenCalledOnce()
		fireEvent.click(screen.getByRole("button", { name: /AC-41.*Parent ticket/ }))
		expect(props.onOpenRelated).toHaveBeenCalledWith(parent.id)
		expect(container.querySelector(".ticket-reader-actions")).not.toHaveTextContent("Add child ticket")
	})

	it("distinguishes loading, error, and empty relations instead of implying missing subtickets", () => {
		const loading = makeProps({ relationsLoading: true })
		const { rerender } = render(<TicketReader {...loading} />)
		expect(screen.getByRole("status")).toHaveTextContent("Loading related tickets…")
		expect(screen.queryByText("No subtickets")).not.toBeInTheDocument()

		const failed = makeProps({ relationsError: "Network unavailable" })
		rerender(<TicketReader {...failed} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Related tickets could not be loaded: Network unavailable")
		expect(screen.queryByText("No subtickets")).not.toBeInTheDocument()

		const loaded = makeProps()
		rerender(<TicketReader {...loaded} />)
		expect(screen.getByText("No subtickets")).toBeVisible()
	})

	it("shows property progress and a single conflict error while disabling all property controls", () => {
		const props = makeProps({ statusPending: true, statusError: "Ticket changed" })
		render(<TicketReader {...props} />)

		expect(screen.getByRole("status")).toHaveTextContent("Saving property…")
		expect(screen.getAllByRole("alert")).toHaveLength(1)
		for (const name of ["Status of Preserve ticket drafts on reload", "Priority", "Type"]) {
			expect(screen.getByRole("combobox", { name })).toBeDisabled()
		}
	})

	it.each(["success", "failure"] as const)("restores the changed property focus after a save %s", (result) => {
		withFocusTracking(() => {
			const initial = makeProps()
			const { rerender } = render(<TicketReader {...initial} />)
			const priority = screen.getByRole("combobox", { name: "Priority" })
			priority.focus()
			fireEvent.change(priority, { target: { value: "medium" } })
			expect(initial.onPriorityChange).toHaveBeenCalledWith("medium")

			rerender(<TicketReader {...makeProps({ busy: true, statusPending: true })} />)
			expect(priority).toBeDisabled()
			expect(document.activeElement).not.toBe(priority)

			const updatedTicket = result === "success" ? { ...ticket, priority: "medium" as const } : ticket
			rerender(
				<TicketReader
					{...makeProps({
						ticket: updatedTicket,
						busy: false,
						statusPending: false,
						statusError: result === "failure" ? "Ticket changed" : undefined,
					})}
				/>,
			)
			expect(screen.getByRole("combobox", { name: "Priority" })).toBe(priority)
			expect(document.activeElement).toBe(priority)
		})
	})

	it("keeps focus where the user moves while a property save is pending", () => {
		withFocusTracking(() => {
			const initial = makeProps()
			const { rerender } = render(
				<>
					<button type="button">Outside</button>
					<TicketReader {...initial} />
				</>,
			)
			const priority = screen.getByRole("combobox", { name: "Priority" })
			const outside = screen.getByRole("button", { name: "Outside" })
			priority.focus()
			fireEvent.change(priority, { target: { value: "medium" } })

			rerender(
				<>
					<button type="button">Outside</button>
					<TicketReader {...makeProps({ busy: true, statusPending: true })} />
				</>,
			)
			screen.getByRole("button", { name: "Outside" }).focus()
			expect(document.activeElement).toBe(outside)

			rerender(
				<>
					<button type="button">Outside</button>
					<TicketReader {...makeProps({ busy: false, statusPending: false })} />
				</>,
			)
			expect(document.activeElement).toBe(outside)
		})
	})

	it("does not restore focus to another ticket after related-ticket navigation", () => {
		withFocusTracking(() => {
			const initial = makeProps()
			const { rerender } = render(<TicketReader {...initial} />)
			const priority = screen.getByRole("combobox", { name: "Priority" })
			priority.focus()
			fireEvent.change(priority, { target: { value: "medium" } })

			rerender(<TicketReader {...makeProps({ busy: true, statusPending: true })} />)
			const related = { ...ticket, id: "c92c97c8-414f-4888-8e39-3be1c06a720d", name: "Related ticket" }
			rerender(<TicketReader {...makeProps({ ticket: related, busy: false, statusPending: false })} />)

			expect(screen.getByRole("heading", { name: "Related ticket" })).toBeVisible()
			expect(document.activeElement).not.toBe(screen.getByRole("combobox", { name: "Priority" }))
		})
	})

	it.each(["complete", "canceled"] as const)("does not offer Work for a %s ticket", (status) => {
		render(<TicketReader {...makeProps({ ticket: { ...ticket, status } })} />)
		expect(screen.queryByRole("button", { name: "Work on ticket" })).not.toBeInTheDocument()
	})
})
