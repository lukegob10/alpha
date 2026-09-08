import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ticket, TicketRequest } from "@alpha-code/types"
import TicketsView from "../TicketsView"
import { vscode } from "../../../utils/vscode"
import ticketLabels from "../../../i18n/locales/en/tickets.json"

vi.mock("../../../utils/vscode", () => ({
	vscode: { getState: vi.fn(), setState: vi.fn(), postTicketMessage: vi.fn() },
}))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { ticket?: string }) =>
			key === "implementationSummary"
				? ticketLabels.implementationSummary
				: key === "deleteDescription"
					? ticketLabels.deleteDescription.replace("{{ticket}}", options?.ticket ?? "")
					: key,
	}),
}))
vi.mock("../../../i18n/setup", () => ({ default: { changeLanguage: vi.fn(), t: (key: string) => key } }))

const ticket: Ticket = {
	schemaVersion: 1,
	id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
	name: "Original",
	status: "backlog",
	createdAt: "2026-09-07T00:00:00.000Z",
	updatedAt: "2026-09-07T00:00:00.000Z",
	linkedTaskIds: [],
	revision: "v1",
	description: "Description",
	context: "",
	successCriteria: "",
	implementationSummary: "",
}
const draft = {
	name: ticket.name,
	description: ticket.description,
	context: "",
	successCriteria: "",
	implementationSummary: "",
	status: ticket.status,
}
const reply = (message: unknown) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }))
	})

const projectsMessage = { type: "ticketProjects", projects: [{ id: "project", name: "Project" }], language: "en" }
const announceProjects = (message: { type: string }) => {
	if (message.type === "ticketsReady") window.dispatchEvent(new MessageEvent("message", { data: projectsMessage }))
}
const requests = (action: TicketRequest["operation"]["action"]) =>
	vi
		.mocked(vscode.postTicketMessage)
		.mock.calls.map(([message]) => message)
		.filter(
			(message): message is TicketRequest =>
				message.type === "ticketRequest" && message.operation.action === action,
		)
afterEach(() => vi.useRealTimers())

describe("ticket editor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket, draft })
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (
				message.type === "ticketRequest" &&
				(message.operation.action === "list" || message.operation.action === "read")
			)
				queueMicrotask(() => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "ticketResponse",
								requestId: message.requestId,
								result:
									message.operation.action === "read"
										? ticket
										: { tickets: [ticket], total: 1, invalidFiles: [] },
							},
						}),
					)
				})
		})
	})
	it("confirms the saved ticket identity and cancels deletion without sending a request", async () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			ticket: { ...ticket, reference: "PM-01" },
		})
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "delete" }))
		const dialog = screen.getByRole("alertdialog", { name: "deleteTitle" })
		expect(dialog).toHaveTextContent("PM-01 · Original will be permanently deleted. Linked tasks will remain.")
		expect(requests("delete")).toHaveLength(0)
		fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }))
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(screen.getByRole("article", { name: "Original" })).toBeVisible()
		expect(requests("delete")).toHaveLength(0)
	})

	it.each(["cancel", "Escape"])("focuses Cancel initially and restores Delete focus after %s", async (action) => {
		const focus = vi.fn()
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!
		Object.defineProperty(HTMLElement.prototype, "focus", { configurable: true, get: () => focus })
		try {
			render(<TicketsView />)
			const trigger = screen.getByRole("button", { name: "delete" })
			fireEvent.click(trigger)
			const dialog = screen.getByRole("alertdialog")
			const cancel = within(dialog).getByRole("button", { name: "cancel" })
			expect(focus.mock.contexts).toContain(cancel)
			if (action === "cancel") fireEvent.click(cancel)
			else fireEvent.keyDown(document, { key: "Escape" })
			await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
			await waitFor(() => expect(focus.mock.contexts.at(-1)).toBe(trigger))
			expect(requests("delete")).toHaveLength(0)
		} finally {
			Object.defineProperty(HTMLElement.prototype, "focus", original)
		}
	})

	it("preserves the ticket and dirty draft when deletion fails and prevents duplicate requests", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByRole("textbox", { name: "name" }), { target: { value: "Unsaved draft" } })
		fireEvent.click(screen.getByRole("button", { name: "delete" }))
		const dialog = screen.getByRole("alertdialog")
		const confirm = within(dialog).getByRole("button", { name: "deleteAction" })
		fireEvent.click(confirm)
		fireEvent.click(confirm)
		expect(requests("delete")).toHaveLength(1)
		expect(requests("delete")[0]).toMatchObject({
			project: "project",
			operation: { action: "delete", input: { id: ticket.id, expectedRevision: "v1" } },
		})
		expect(confirm).toBeDisabled()
		expect(within(dialog).getByRole("button", { name: "cancel" })).toBeDisabled()
		fireEvent.keyDown(document, { key: "Escape" })
		expect(dialog).toBeVisible()
		reply({ type: "ticketChanged", project: "project" })
		reply({ type: "ticketResponse", requestId: requests("delete")[0].requestId, error: "Ticket changed" })
		await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Ticket changed"))
		fireEvent.click(within(dialog).getByRole("button", { name: "cancel" }))
		expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Unsaved draft")
		expect(vscode.setState).toHaveBeenLastCalledWith(
			expect.objectContaining({ ticket, draft: expect.objectContaining({ name: "Unsaved draft" }) }),
		)
		expect(requests("update")).toHaveLength(0)
	})

	it("clears a deleted ticket, preserves the search, and ignores old list results and queued opens of it", async () => {
		vi.useFakeTimers()
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket, draft, query: "Original" })
		vi.mocked(vscode.postTicketMessage).mockImplementation(announceProjects)
		render(<TicketsView />)
		await act(() => vi.advanceTimersByTimeAsync(150))
		const oldList = requests("list")[0]
		fireEvent.click(screen.getByRole("button", { name: "delete" }))
		fireEvent.click(screen.getByRole("button", { name: "deleteAction" }))
		reply({ type: "ticketOpen", target: { project: "project", id: ticket.id } })
		reply({ type: "ticketResponse", requestId: requests("delete")[0].requestId, result: ticket })
		await act(async () => {})
		reply({
			type: "ticketResponse",
			requestId: oldList.requestId,
			result: { tickets: [ticket], total: 1, invalidFiles: [] },
		})
		await act(() => vi.advanceTimersByTimeAsync(150))
		const reload = requests("list").at(-1)!
		expect(reload.requestId).not.toBe(oldList.requestId)
		reply({
			type: "ticketResponse",
			requestId: reload.requestId,
			result: { tickets: [], total: 0, invalidFiles: [] },
		})
		await act(async () => {})
		expect(screen.getByRole("textbox", { name: "search" })).toHaveValue("Original")
		expect(screen.getByRole("status")).toHaveTextContent("empty")
		expect(screen.queryByRole("button", { name: /Original/ })).not.toBeInTheDocument()
		expect(screen.queryByRole("article")).not.toBeInTheDocument()
		expect(requests("read")).toHaveLength(0)
		expect(vscode.setState).toHaveBeenLastCalledWith(
			expect.objectContaining({ ticket: undefined, draft: undefined, editing: false, query: "Original" }),
		)
	})

	it("reloads the previous page when its last ticket is deleted", async () => {
		vi.useFakeTimers()
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket, draft, query: "Original", offset: 50 })
		vi.mocked(vscode.postTicketMessage).mockImplementation(announceProjects)
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "delete" }))
		fireEvent.click(screen.getByRole("button", { name: "deleteAction" }))
		reply({ type: "ticketResponse", requestId: requests("delete")[0].requestId, result: ticket })
		await act(async () => {})
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { query: "Original", offset: 50 } })
		reply({
			type: "ticketResponse",
			requestId: requests("list").at(-1)!.requestId,
			result: { tickets: [], total: 50, invalidFiles: [] },
		})
		await act(async () => {})
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { query: "Original", offset: 0 } })
		reply({
			type: "ticketResponse",
			requestId: requests("list").at(-1)!.requestId,
			result: { tickets: [{ ...ticket, id: "other", name: "Original remaining" }], total: 50, invalidFiles: [] },
		})
		await act(async () => {})
		expect(screen.getByRole("button", { name: /Original remaining/ })).toBeVisible()
		expect(vscode.setState).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, query: "Original" }))
	})
	it("waits for project discovery when restoring a saved collection and then loads its tickets", async () => {
		vi.useFakeTimers()
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		vi.mocked(vscode.postTicketMessage).mockImplementation(() => {})
		render(<TicketsView />)
		await act(() => vi.advanceTimersByTimeAsync(500))
		expect(vscode.postTicketMessage).toHaveBeenCalledExactlyOnceWith({ type: "ticketsReady" })
		expect(screen.queryByText("empty")).not.toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("activitySearching")
		reply(projectsMessage)
		await act(() => vi.advanceTimersByTimeAsync(150))
		const message = vi.mocked(vscode.postTicketMessage).mock.calls.at(-1)![0] as TicketRequest
		expect(message).toMatchObject({ project: "project", operation: { action: "list" } })
		reply({
			type: "ticketResponse",
			requestId: message.requestId,
			result: { tickets: [ticket], total: 1, invalidFiles: [] },
		})
		await act(async () => {})
		expect(screen.getByRole("button", { name: /Original/ })).toBeVisible()
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})
	it("preserves visible tickets through a failed refresh and recovers when the same project is reloaded", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		render(<TicketsView />)
		await screen.findByRole("button", { name: /Original/ })
		const originalPost = vi.mocked(vscode.postTicketMessage).getMockImplementation()!
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type === "ticketRequest")
				queueMicrotask(() =>
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "ticketResponse",
								requestId: message.requestId,
								error: "Storage unavailable",
							},
						}),
					),
				)
		})
		reply({ type: "ticketChanged", project: "project" })
		await screen.findByRole("alert")
		expect(screen.getByRole("button", { name: /Original/ })).toBeVisible()
		expect(screen.queryByText("empty")).not.toBeInTheDocument()
		vi.mocked(vscode.postTicketMessage).mockImplementation(originalPost)
		fireEvent.click(screen.getByRole("button", { name: "reload" }))
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
		expect(screen.getByRole("button", { name: /Original/ })).toBeVisible()
	})
	it("opens a ticket selected in chat without overwriting an unsaved draft", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Unsaved" } })
		reply({ type: "ticketOpen", target: { project: "other-project", id: ticket.id } })
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "cancel" }))
		expect(screen.getByLabelText("name")).toHaveValue("Unsaved")
		reply({ type: "ticketOpen", target: { project: "other-project", id: ticket.id } })
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "discardAction" }))
		await screen.findByRole("article", { name: "Original" })
		expect(vscode.postTicketMessage).toHaveBeenCalledWith(
			expect.objectContaining({ project: "other-project", operation: { action: "read", id: ticket.id } }),
		)
	})
	it("always groups in progress, backlog, then completed tickets", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type !== "ticketRequest" || message.operation.action !== "list") return
			queueMicrotask(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "ticketResponse",
							requestId: message.requestId,
							result: {
								tickets: [
									{ ...ticket, id: "c", name: "Completed", status: "complete" },
									ticket,
									{ ...ticket, id: "a", name: "Active", status: "in-progress" },
								],
								total: 3,
								invalidFiles: [],
							},
						},
					}),
				),
			)
		})
		render(<TicketsView />)
		await screen.findByRole("button", { name: /Active/ })
		expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
			"in-progress1",
			"backlog1",
			"complete1",
		])
	})
	it("starts expanded on reload while preserving manual collapses through ticket navigation", async () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			collapsedStatuses: ["in-progress", "backlog", "complete"],
		})
		const view = render(<TicketsView />)
		const row = await screen.findByRole("button", { name: /Original/ })
		for (const status of ["in-progress", "backlog", "complete"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${status}`) })).toHaveAttribute(
				"aria-expanded",
				"true",
			)
		}
		fireEvent.click(screen.getByRole("button", { name: /^complete/ }))
		fireEvent.click(screen.getByRole("button", { name: /^in-progress/ }))
		fireEvent.click(row)
		await screen.findByRole("article", { name: "Original" })
		fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "title" }))
		expect(screen.getByRole("button", { name: /^in-progress/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByRole("button", { name: /^complete/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByRole("button", { name: /^backlog/ })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		const saved = vi.mocked(vscode.setState).mock.calls.at(-1)![0]
		expect(saved).not.toHaveProperty("collapsedStatuses")
		view.unmount()
		vi.mocked(vscode.getState).mockReturnValue(saved)
		render(<TicketsView />)
		for (const status of ["in-progress", "backlog", "complete"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${status}`) })).toHaveAttribute(
				"aria-expanded",
				"true",
			)
		}
		expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3)
		expect(await screen.findByRole("button", { name: /Original/ })).toBeVisible()
	})

	it("shows a short reference throughout list, detail, breadcrumb, and editing", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type !== "ticketRequest") return
			const referenced = { ...ticket, reference: "PM-01" }
			queueMicrotask(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "ticketResponse",
							requestId: message.requestId,
							result:
								message.operation.action === "list"
									? { tickets: [referenced], total: 1, invalidFiles: [] }
									: referenced,
						},
					}),
				),
			)
		})
		render(<TicketsView />)
		fireEvent.click(await screen.findByRole("button", { name: /PM-01.*Original/ }))
		await screen.findByRole("heading", { name: "Original" })
		expect(screen.getByRole("navigation")).toHaveTextContent("PM-01 · Original")
		expect(screen.getByRole("article")).toHaveTextContent("PM-01")
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByText("PM-01")).toBeInTheDocument()
		expect(screen.queryByText(ticket.id)).not.toBeInTheDocument()
	})

	it("preserves dirty fields across disk notifications and conflict responses", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		reply({ type: "ticketProjects", projects: [{ id: "project", name: "Project" }], language: "en" })
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "My draft" } })
		reply({ type: "ticketChanged", project: "project" })
		expect(screen.getByLabelText("name")).toHaveValue("My draft")
		fireEvent.click(screen.getByText("save"))
		const request = vi
			.mocked(vscode.postTicketMessage)
			.mock.calls.map(([value]) => value)
			.find((value) => value.type === "ticketRequest" && value.operation.action === "update") as TicketRequest
		expect(request.operation).toMatchObject({ input: { name: "My draft", expectedRevision: "v1" } })
		reply({ type: "ticketResponse", requestId: request.requestId, error: "Ticket changed" })
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ticket changed"))
		expect(screen.getByLabelText("name")).toHaveValue("My draft")
	})

	it("asks before discarding a dirty ticket to create another", () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Unsaved" } })
		fireEvent.click(screen.getByText("new"))
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		expect(screen.getByLabelText("name")).toHaveValue("Unsaved")
		fireEvent.click(screen.getByText("discardAction"))
		expect(screen.getByLabelText("name")).toHaveValue("")
	})

	it("saves edits before starting linked work", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Updated" } })
		fireEvent.click(screen.getByText("work"))
		const request = vi
			.mocked(vscode.postTicketMessage)
			.mock.calls.map(([value]) => value)
			.find((value) => value.type === "ticketRequest" && value.operation.action === "update") as TicketRequest
		expect(
			vi
				.mocked(vscode.postTicketMessage)
				.mock.calls.some(([value]) => value.type === "ticketRequest" && value.operation.action === "work"),
		).toBe(false)
		reply({
			type: "ticketResponse",
			requestId: request.requestId,
			result: { ...ticket, name: "Updated", revision: "v2" },
		})
		await waitFor(() =>
			expect(vscode.postTicketMessage).toHaveBeenCalledWith(
				expect.objectContaining({ operation: { action: "work", id: ticket.id, expectedRevision: "v2" } }),
			),
		)
	})

	it("renders a readable ticket by default with formatted Markdown and safe links", () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			editing: false,
			ticket: {
				...ticket,
				description:
					"A **clear** description with `code`.\n\n[Docs](https://example.com) [Unsafe](command:workbench.action.closeWindow)\n\n![Image](https://example.com/image.png)",
				successCriteria: "- [x] Ticket is readable\n- [ ] Editing works",
			},
		})
		const { container } = render(<TicketsView />)
		expect(screen.getByRole("heading", { name: "Original" })).toBeInTheDocument()
		expect(screen.queryByRole("textbox", { name: "name" })).not.toBeInTheDocument()
		expect(container.querySelector("strong")).toHaveTextContent("clear")
		expect(container.querySelector("code")).toHaveTextContent("code")
		expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://example.com")
		expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument()
		expect(screen.queryByRole("img")).not.toBeInTheDocument()
		expect(screen.getAllByRole("checkbox")).toHaveLength(2)
		expect(screen.getAllByRole("checkbox")[0]).toBeChecked()
		expect(screen.getAllByRole("checkbox")[0]).toBeDisabled()
		expect(screen.getByRole("heading", { name: "Activity" })).toBeVisible()
	})

	it.each(["backlog", "in-progress", "complete"] as const)(
		"shows a blank Activity section before editing a %s ticket",
		(status) => {
			vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket: { ...ticket, status } })
			render(<TicketsView />)
			expect(screen.getByRole("region", { name: "Activity" })).toHaveTextContent(/^Activity$/)
			expect(screen.queryByRole("textbox", { name: "Activity" })).not.toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { name: "edit" }))
			expect(screen.getByRole("textbox", { name: "Activity" })).toHaveValue("")
		},
	)

	it("renders existing implementation notes as Activity and preserves them in the editor", () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			ticket: { ...ticket, implementationSummary: "Existing **implementation notes**" },
		})
		render(<TicketsView />)
		expect(screen.getByRole("region", { name: "Activity" })).toHaveTextContent("Existing implementation notes")
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByRole("textbox", { name: "Activity" })).toHaveValue("Existing **implementation notes**")
	})

	it("edits in the same view and returns to the rendered ticket after saving", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Original")
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Readable result" } })
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		const request = vi
			.mocked(vscode.postTicketMessage)
			.mock.calls.map(([value]) => value)
			.find((value) => value.type === "ticketRequest" && value.operation.action === "update") as TicketRequest
		reply({
			type: "ticketResponse",
			requestId: request.requestId,
			result: { ...ticket, name: "Readable result", revision: "v2" },
		})
		await waitFor(() => expect(screen.getByRole("heading", { name: "Readable result" })).toBeInTheDocument())
		expect(screen.queryByRole("textbox", { name: "name" })).not.toBeInTheDocument()
		expect(vscode.setState).toHaveBeenLastCalledWith(expect.objectContaining({ editing: false }))
	})

	it("returns to the saved ticket when cancelling and restores unsaved drafts in edit mode", () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket, draft: { ...draft, name: "Unsaved" } })
		render(<TicketsView />)
		expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Unsaved")
		fireEvent.click(screen.getByRole("button", { name: "cancel" }))
		expect(screen.getByRole("alertdialog")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "discardAction" }))
		expect(screen.getByRole("heading", { name: "Original" })).toBeInTheDocument()
		expect(screen.queryByRole("textbox", { name: "name" })).not.toBeInTheDocument()
	})

	it("opens tickets as a separate page and returns through the breadcrumb with the list context intact", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		const { container } = render(<TicketsView />)
		const row = await screen.findByRole("button", { name: /Original/ })
		expect(screen.getByRole("region", { name: "title" })).toBeInTheDocument()
		expect(screen.queryByRole("article")).not.toBeInTheDocument()
		fireEvent.change(screen.getByRole("textbox", { name: "search" }), { target: { value: "Original" } })
		const page = container.querySelector<HTMLDivElement>(".tickets-page")!
		page.scrollTop = 180
		fireEvent.click(row)
		await screen.findByRole("heading", { name: "Original" })
		expect(screen.queryByRole("region", { name: "title" })).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox", { name: "search" })).not.toBeInTheDocument()
		expect(page.scrollTop).toBe(0)
		const breadcrumb = screen.getByRole("navigation", { name: "navigation" })
		expect(within(breadcrumb).getByText("Original")).toHaveAttribute("aria-current", "page")
		fireEvent.click(within(breadcrumb).getByRole("button", { name: "title" }))
		expect(screen.queryByRole("article")).not.toBeInTheDocument()
		expect(screen.getByRole("textbox", { name: "search" })).toHaveValue("Original")
		expect(page.scrollTop).toBe(180)
		expect(vscode.setState).toHaveBeenLastCalledWith(
			expect.objectContaining({ ticket: undefined, draft: undefined, query: "Original" }),
		)
	})

	it("guards breadcrumb navigation while an edit is unsaved", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "Unsaved name" } })
		const breadcrumb = screen.getByRole("navigation", { name: "navigation" })
		expect(within(breadcrumb).getByText("edit")).toHaveAttribute("aria-current", "page")
		fireEvent.click(within(breadcrumb).getByRole("button", { name: "title" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "cancel" }))
		expect(screen.getByLabelText("name")).toHaveValue("Unsaved name")
		fireEvent.click(within(breadcrumb).getByRole("button", { name: "title" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "discardAction" }))
		await screen.findByRole("button", { name: /Original/ })
		expect(screen.queryByRole("textbox", { name: "name" })).not.toBeInTheDocument()
		expect(
			vi
				.mocked(vscode.postTicketMessage)
				.mock.calls.some(
					([message]) =>
						message.type === "ticketRequest" && ["create", "update"].includes(message.operation.action),
				),
		).toBe(false)
	})

	it("lets the ticket breadcrumb leave edit mode without leaving the ticket page", () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.click(
			within(screen.getByRole("navigation", { name: "navigation" })).getByRole("button", { name: "Original" }),
		)
		expect(screen.getByRole("article", { name: "Original" })).toBeInTheDocument()
		expect(screen.queryByRole("region", { name: "title" })).not.toBeInTheDocument()
		expect(screen.queryByRole("textbox", { name: "name" })).not.toBeInTheDocument()
	})

	it("restores the list's search and page when returning from a reloaded ticket", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket, draft, query: "Original", offset: 50 })
		render(<TicketsView />)
		fireEvent.click(
			within(screen.getByRole("navigation", { name: "navigation" })).getByRole("button", { name: "title" }),
		)
		expect(screen.getByRole("textbox", { name: "search" })).toHaveValue("Original")
		await waitFor(() =>
			expect(vscode.postTicketMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: { action: "list", input: { query: "Original", offset: 50, limit: 50 } },
				}),
			),
		)
	})
})
