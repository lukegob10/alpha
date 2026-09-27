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
	it("changes status only in the reader and preserves its value after a conflict", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		render(<TicketsView />)
		const row = await screen.findByRole("button", { name: /Original/ })
		expect(within(row.closest("tr")!).queryByRole("combobox")).not.toBeInTheDocument()
		fireEvent.click(row)
		await screen.findByRole("article", { name: "Original" })
		const select = screen.getByRole("combobox", { name: "statusOf" })
		fireEvent.change(select, { target: { value: "canceled" } })
		expect(requests("update")[0].operation).toMatchObject({
			input: { id: ticket.id, expectedRevision: "v1", status: "canceled" },
		})
		expect(select).toBeDisabled()
		reply({ type: "ticketResponse", requestId: requests("update")[0].requestId, error: "Ticket changed" })
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ticket changed"))
		expect(select).toHaveValue("backlog")
	})
	it("persists a priority change and expanded type through reader reload", async () => {
		render(<TicketsView />)
		fireEvent.change(screen.getByRole("combobox", { name: "priority" }), { target: { value: "high" } })
		const priorityRequest = requests("update")[0]
		expect(priorityRequest.operation).toMatchObject({
			input: { id: ticket.id, expectedRevision: "v1", priority: "high" },
		})
		reply({
			type: "ticketResponse",
			requestId: priorityRequest.requestId,
			result: { ...ticket, priority: "high", revision: "v2" },
		})
		await waitFor(() => expect(screen.getByRole("combobox", { name: "priority" })).toHaveValue("high"))
		fireEvent.change(screen.getByRole("combobox", { name: "type" }), { target: { value: "performance" } })
		const typeRequest = requests("update")[1]
		expect(typeRequest.operation).toMatchObject({ input: { expectedRevision: "v2", type: "performance" } })
		const saved = { ...ticket, priority: "high", type: "performance", revision: "v3" }
		reply({ type: "ticketResponse", requestId: typeRequest.requestId, result: saved })
		await waitFor(() => expect(screen.getByRole("combobox", { name: "type" })).toHaveValue("performance"))
		const previousPost = vi.mocked(vscode.postTicketMessage).getMockImplementation()
		let readReconciled = false
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			if (message.type === "ticketRequest" && message.operation.action === "read") {
				queueMicrotask(() => {
					reply({ type: "ticketResponse", requestId: message.requestId, result: saved })
					readReconciled = true
				})
			} else previousPost?.(message)
		})
		reply({ type: "ticketChanged", project: "project" })
		await waitFor(() => expect(readReconciled).toBe(true))
		expect(screen.queryByText("changed")).not.toBeInTheDocument()
		expect(screen.getByRole("combobox", { name: "priority" })).toHaveValue("high")
		expect(screen.getByRole("combobox", { name: "type" })).toHaveValue("performance")
	})
	it("ignores stale disk reads when an inline update succeeds after a notification", async () => {
		render(<TicketsView />)
		fireEvent.change(screen.getByRole("combobox", { name: "priority" }), { target: { value: "high" } })
		const update = requests("update")[0]
		const saved = { ...ticket, priority: "high" as const, revision: "v2" }
		const previousPost = vi.mocked(vscode.postTicketMessage).getMockImplementation()
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			if (!(message.type === "ticketRequest" && message.operation.action === "read")) previousPost?.(message)
		})
		reply({ type: "ticketChanged", project: "project" })
		await waitFor(() => expect(requests("read")).toHaveLength(1))
		reply({ type: "ticketResponse", requestId: update.requestId, result: saved })
		await waitFor(() => expect(requests("read")).toHaveLength(2))
		reply({ type: "ticketResponse", requestId: requests("read")[0].requestId, result: ticket })
		await act(async () => {})
		expect(screen.queryByText("changed")).not.toBeInTheDocument()
		reply({ type: "ticketResponse", requestId: requests("read")[1].requestId, result: saved })
		await waitFor(() => expect(screen.queryByText("changed")).not.toBeInTheDocument())
		expect(screen.getByRole("combobox", { name: "priority" })).toHaveValue("high")
	})
	it("uses unfiltered relations and sends the selected linked conversation", async () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			ticket: { ...ticket, linkedTaskIds: ["run-1", "run-2"] },
			editing: false,
			query: "unrelated",
			typeFilter: "bug",
		})
		render(<TicketsView />)
		await waitFor(() => expect(requests("relations")).toHaveLength(1))
		expect(requests("relations")[0].operation).toEqual({ action: "relations", id: ticket.id })
		reply({
			type: "ticketResponse",
			requestId: requests("relations")[0].requestId,
			result: {
				children: [
					{
						...ticket,
						id: "2cf4023f-a15b-47d8-971b-7da490ff043f",
						name: "Child outside filter",
						parentId: ticket.id,
						childCount: 0,
						completedChildCount: 0,
					},
				],
			},
		})
		expect(await screen.findByRole("button", { name: /Child outside filter/ })).toBeVisible()
		fireEvent.click(screen.getAllByRole("button", { name: "openLinkedConversation" })[1])
		expect(requests("openLinkedTask")[0].operation).toEqual({
			action: "openLinkedTask",
			id: ticket.id,
			taskId: "run-2",
		})
	})
	it("refreshes parent progress after a child status change in the reader", async () => {
		vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
		const parent = {
			...ticket,
			id: "2cf4023f-a15b-47d8-971b-7da490ff043f",
			name: "Parent",
			childCount: 1,
			completedChildCount: 0,
		}
		let child: Ticket & { childCount: number; completedChildCount: number } = {
			...ticket,
			id: "3df51340-b26c-48e9-a82c-8eb5a1001540",
			name: "Child",
			parentId: parent.id,
			status: "in-progress",
			childCount: 0,
			completedChildCount: 0,
		}
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type === "ticketRequest" && message.operation.action === "list")
				queueMicrotask(() =>
					reply({
						type: "ticketResponse",
						requestId: message.requestId,
						result: {
							tickets: [{ ...parent, completedChildCount: child.status === "complete" ? 1 : 0 }, child],
							total: 2,
							invalidFiles: [],
						},
					}),
				)
			if (message.type === "ticketRequest" && message.operation.action === "read")
				queueMicrotask(() => reply({ type: "ticketResponse", requestId: message.requestId, result: child }))
		})
		render(<TicketsView />)
		const childRow = await screen.findByRole("button", { name: /^Child/ })
		expect(within(screen.getByRole("button", { name: /^Parent/ })).getByText("0/1")).toBeVisible()
		fireEvent.click(childRow)
		await screen.findByRole("article", { name: "Child" })
		fireEvent.change(screen.getByRole("combobox", { name: "statusOf" }), { target: { value: "complete" } })
		child = { ...child, status: "complete", revision: "v2" }
		reply({ type: "ticketResponse", requestId: requests("update")[0].requestId, result: child })
		fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "title" }))
		await waitFor(() =>
			expect(within(screen.getByRole("button", { name: /^Parent/ })).getByText("1/1")).toBeVisible(),
		)
	})
	it("updates status from the reader without entering edit mode", async () => {
		render(<TicketsView />)
		const select = screen.getByRole("combobox", { name: "statusOf" })
		fireEvent.change(select, { target: { value: "canceled" } })
		expect(requests("update")[0].operation).toMatchObject({
			input: { id: ticket.id, expectedRevision: "v1", status: "canceled" },
		})
		expect(select).toBeDisabled()
		reply({
			type: "ticketResponse",
			requestId: requests("update")[0].requestId,
			result: { ...ticket, status: "canceled", revision: "v2" },
		})
		await waitFor(() => expect(screen.getByRole("combobox", { name: "statusOf" })).toHaveValue("canceled"))
		expect(screen.queryByRole("button", { name: "work" })).not.toBeInTheDocument()
	})
	it("allows Complete in the editor with an empty Implementation summary field", () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		fireEvent.change(screen.getByLabelText("status"), { target: { value: "complete" } })
		expect(screen.getByRole("textbox", { name: "Implementation summary" })).not.toBeRequired()
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		expect(requests("update")[0].operation).toMatchObject({
			input: { status: "complete", implementationSummary: "" },
		})
	})
	it("opens a new child draft from a ticket and creates it under that ticket", () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "addChild" }))
		expect(screen.getByRole("combobox", { name: "parentTicket" })).toHaveValue(ticket.id)
		fireEvent.change(screen.getByRole("textbox", { name: "name" }), { target: { value: "Child task" } })
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		expect(requests("create")[0].operation).toMatchObject({ input: { name: "Child task", parentId: ticket.id } })
	})
	it("lets an editor choose a parent ticket and saves its relationship", async () => {
		const parent = { ...ticket, id: "2cf4023f-a15b-47d8-971b-7da490ff043f", name: "Parent", reference: "PM-02" }
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type === "ticketRequest" && message.operation.action === "list")
				queueMicrotask(() =>
					reply({
						type: "ticketResponse",
						requestId: message.requestId,
						result: { tickets: [ticket, parent], total: 2, invalidFiles: [] },
					}),
				)
		})
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		const parentSelect = await screen.findByRole("combobox", { name: "parentTicket" })
		await waitFor(() => expect(within(parentSelect).getByRole("option", { name: /PM-02/ })).toBeInTheDocument())
		fireEvent.change(parentSelect, { target: { value: parent.id } })
		expect(parentSelect).toHaveValue(parent.id)
		expect(screen.getByRole("button", { name: "save" })).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		await waitFor(() => expect(requests("update")).toHaveLength(1))
		expect(requests("update")[0].operation).toMatchObject({
			input: { parentId: parent.id, expectedRevision: "v1" },
		})
	})
	it("reports parent search failures while preserving the current editor", async () => {
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type === "ticketRequest" && message.operation.action === "list")
				queueMicrotask(() =>
					reply({ type: "ticketResponse", requestId: message.requestId, error: "Search unavailable" }),
				)
		})
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		await waitFor(() =>
			expect(
				screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Search unavailable")),
			).toBe(true),
		)
		expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Original")
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
		expect(
			screen
				.getAllByRole("button", { name: /^(in-progress|backlog|complete) \d+$/ })
				.map((group) => group.textContent),
		).toEqual(["in-progress1", "backlog1", "complete1"])
	})
	it("starts expanded on reload while preserving manual collapses through ticket navigation", async () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			collapsedStatuses: ["in-progress", "backlog"],
		})
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			announceProjects(message)
			if (message.type === "ticketRequest" && message.operation.action === "list")
				queueMicrotask(() =>
					reply({
						type: "ticketResponse",
						requestId: message.requestId,
						result: {
							tickets: [ticket, { ...ticket, id: "b", name: "Active", status: "in-progress" }],
							total: 2,
							invalidFiles: [],
						},
					}),
				)
			if (message.type === "ticketRequest" && message.operation.action === "read")
				queueMicrotask(() => reply({ type: "ticketResponse", requestId: message.requestId, result: ticket }))
		})
		const view = render(<TicketsView />)
		const row = await screen.findByRole("button", { name: /Original/ })
		for (const status of ["in-progress", "backlog"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${status}`) })).toHaveAttribute(
				"aria-expanded",
				"true",
			)
		}
		fireEvent.click(screen.getByRole("button", { name: /^in-progress/ }))
		fireEvent.click(row)
		await screen.findByRole("article", { name: "Original" })
		fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "title" }))
		expect(screen.getByRole("button", { name: /^in-progress/ })).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByRole("button", { name: /^backlog/ })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getByRole("button", { name: /^backlog/ }))
		const saved = vi.mocked(vscode.setState).mock.calls.at(-1)![0]
		expect(saved).not.toHaveProperty("collapsedStatuses")
		view.unmount()
		vi.mocked(vscode.getState).mockReturnValue(saved)
		render(<TicketsView />)
		await screen.findByRole("button", { name: /Original/ })
		for (const status of ["in-progress", "backlog"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${status}`) })).toHaveAttribute(
				"aria-expanded",
				"true",
			)
		}
		expect(screen.getAllByRole("button", { name: /^(in-progress|backlog) \d+$/ })).toHaveLength(2)
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
		expect(screen.getByRole("navigation")).toHaveTextContent("PM-01")
		expect(screen.getByRole("article")).toHaveTextContent("PM-01")
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(
			within(screen.getByRole("textbox", { name: "name" }).closest("form")!).getByText("PM-01"),
		).toBeInTheDocument()
		expect(screen.queryByText(ticket.id)).not.toBeInTheDocument()
	})

	it("preserves dirty fields across disk notifications and conflict responses", async () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		reply({ type: "ticketProjects", projects: [{ id: "project", name: "Project" }], language: "en" })
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "My draft" } })
		fireEvent.change(screen.getByLabelText("type"), { target: { value: "improvement" } })
		const previousPost = vi.mocked(vscode.postTicketMessage).getMockImplementation()
		const external = { ...ticket, name: "External edit", revision: "v2" }
		vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
			if (message.type === "ticketRequest" && message.operation.action === "read")
				queueMicrotask(() => reply({ type: "ticketResponse", requestId: message.requestId, result: external }))
			else previousPost?.(message)
		})
		reply({ type: "ticketChanged", project: "project" })
		await screen.findByText("changed")
		expect(screen.getByLabelText("name")).toHaveValue("My draft")
		expect(screen.getByLabelText("type")).toHaveValue("improvement")
		fireEvent.click(screen.getByText("save"))
		const request = vi
			.mocked(vscode.postTicketMessage)
			.mock.calls.map(([value]) => value)
			.find((value) => value.type === "ticketRequest" && value.operation.action === "update") as TicketRequest
		expect(request.operation).toMatchObject({
			input: { name: "My draft", type: "improvement", expectedRevision: "v1" },
		})
		reply({ type: "ticketResponse", requestId: request.requestId, error: "Ticket changed" })
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Ticket changed"))
		expect(screen.getByLabelText("name")).toHaveValue("My draft")
		expect(screen.getByLabelText("type")).toHaveValue("improvement")
	})

	it("saves and removes a classification and displays the saved type in properties", async () => {
		render(<TicketsView />)
		expect(
			within(screen.getByRole("region", { name: "properties" })).getByRole("combobox", { name: "type" }),
		).toHaveValue("")
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
		fireEvent.change(screen.getByLabelText("type"), { target: { value: "bug" } })
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		expect(requests("update")[0].operation).toMatchObject({ input: { type: "bug", expectedRevision: "v1" } })
		reply({
			type: "ticketResponse",
			requestId: requests("update")[0].requestId,
			result: { ...ticket, type: "bug", revision: "v2" },
		})
		await screen.findByRole("article")
		expect(within(screen.getByRole("complementary")).getByRole("combobox", { name: "type" })).toHaveValue("bug")
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByLabelText("type")).toHaveValue("bug")
		fireEvent.change(screen.getByLabelText("type"), { target: { value: "" } })
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		expect(requests("update")[1].operation).toMatchObject({ input: { type: null, expectedRevision: "v2" } })
		reply({
			type: "ticketResponse",
			requestId: requests("update")[1].requestId,
			result: { ...ticket, type: null, revision: "v3" },
		})
		await screen.findByRole("article")
		expect(within(screen.getByRole("complementary")).getByRole("combobox", { name: "type" })).toHaveValue("")
	})

	it("includes the type when creating a ticket", () => {
		render(<TicketsView />)
		fireEvent.click(screen.getByRole("button", { name: "new" }))
		fireEvent.change(screen.getByLabelText("name"), { target: { value: "New feature" } })
		fireEvent.change(screen.getByLabelText("type"), { target: { value: "feature" } })
		fireEvent.click(screen.getByRole("button", { name: "save" }))
		expect(requests("create")[0].operation).toMatchObject({ input: { name: "New feature", type: "feature" } })
	})

	it("restores type filters, resets pagination on changes, and preserves filters through navigation", async () => {
		vi.useFakeTimers()
		vi.mocked(vscode.getState).mockReturnValue({ project: "project", typeFilter: "bug", offset: 50 })
		vi.mocked(vscode.postTicketMessage).mockImplementation(announceProjects)
		render(<TicketsView />)
		expect(screen.getByLabelText("filterType")).toHaveValue("bug")
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { type: "bug", offset: 50 } })
		fireEvent.change(screen.getByLabelText("filterType"), { target: { value: "feature" } })
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { type: "feature", offset: 0 } })
		reply({
			type: "ticketResponse",
			requestId: requests("list").at(-1)!.requestId,
			result: { tickets: [{ ...ticket, type: "feature" }], total: 1, invalidFiles: [] },
		})
		await act(async () => {})
		fireEvent.click(screen.getByRole("button", { name: /Original/ }))
		reply({
			type: "ticketResponse",
			requestId: requests("read").at(-1)!.requestId,
			result: { ...ticket, type: "feature" },
		})
		await act(async () => {})
		fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "title" }))
		expect(screen.getByLabelText("filterType")).toHaveValue("feature")
		fireEvent.change(screen.getByLabelText("filterType"), { target: { value: "untagged" } })
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { type: null, offset: 0 } })
		fireEvent.change(screen.getByLabelText("filterType"), { target: { value: "" } })
		await act(() => vi.advanceTimersByTimeAsync(150))
		expect(requests("list").at(-1)?.operation).toMatchObject({ input: { type: undefined, offset: 0 } })
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
		expect(screen.getByRole("heading", { name: "Implementation summary" })).toBeVisible()
	})

	it.each(["backlog", "in-progress", "complete"] as const)(
		"shows a blank Implementation summary section before editing a %s ticket",
		(status) => {
			vi.mocked(vscode.getState).mockReturnValue({ project: "project", ticket: { ...ticket, status } })
			render(<TicketsView />)
			expect(screen.getByRole("region", { name: "Implementation summary" })).toHaveTextContent(
				/^Implementation summary$/,
			)
			expect(screen.queryByRole("textbox", { name: "Implementation summary" })).not.toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { name: "edit" }))
			expect(screen.getByRole("textbox", { name: "Implementation summary" })).toHaveValue("")
		},
	)

	it("renders existing implementation notes as Implementation summary and preserves them in the editor", () => {
		vi.mocked(vscode.getState).mockReturnValue({
			project: "project",
			ticket: { ...ticket, implementationSummary: "Existing **implementation notes**" },
		})
		render(<TicketsView />)
		expect(screen.getByRole("region", { name: "Implementation summary" })).toHaveTextContent(
			"Existing implementation notes",
		)
		fireEvent.click(screen.getByRole("button", { name: "edit" }))
		expect(screen.getByRole("textbox", { name: "Implementation summary" })).toHaveValue(
			"Existing **implementation notes**",
		)
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
		expect(screen.getByRole("region", { name: "allTickets" })).toBeInTheDocument()
		expect(screen.queryByRole("article")).not.toBeInTheDocument()
		fireEvent.change(screen.getByRole("textbox", { name: "search" }), { target: { value: "Original" } })
		const page = container.querySelector<HTMLDivElement>(".tickets-page")!
		page.scrollTop = 180
		fireEvent.click(row)
		await screen.findByRole("heading", { name: "Original" })
		expect(screen.queryByRole("region", { name: "allTickets" })).not.toBeInTheDocument()
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
		expect(screen.queryByRole("region", { name: "allTickets" })).not.toBeInTheDocument()
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
