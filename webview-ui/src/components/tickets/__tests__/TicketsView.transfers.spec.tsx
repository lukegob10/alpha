import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TicketRequest, TicketSummary } from "@alpha-code/types"
import TicketsView from "../TicketsView"
import { vscode } from "../../../utils/vscode"

vi.mock("../../../utils/vscode", () => ({
	vscode: { getState: vi.fn(), setState: vi.fn(), postTicketMessage: vi.fn() },
}))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../../../i18n/setup", () => ({ default: { changeLanguage: vi.fn(), t: (key: string) => key } }))
vi.mock("../TicketOverview", () => ({
	TicketOverview: ({ overview }: { overview?: { total: number } }) => (
		<div data-testid="overview">{overview?.total ?? "loading"}</div>
	),
}))

const ticket: TicketSummary = {
	id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
	name: "Portable work",
	reference: "PRO-01",
	status: "backlog",
	updatedAt: "2026-10-31T00:00:00.000Z",
	revision: "v1",
	childCount: 0,
	completedChildCount: 0,
}
const token = "e79288ad-9c54-4c46-9073-a5fb6098142b"
const preview = {
	kind: "importPreview",
	token,
	tickets: [{ id: ticket.id, name: ticket.name, status: ticket.status, disposition: "new" }],
	warnings: [],
}
const reply = (requestId: string, result: unknown) =>
	act(() =>
		window.dispatchEvent(new MessageEvent("message", { data: { type: "ticketResponse", requestId, result } })),
	)
const requests = (action: TicketRequest["operation"]["action"]) =>
	vi
		.mocked(vscode.postTicketMessage)
		.mock.calls.map(([message]) => message)
		.filter(
			(message): message is TicketRequest =>
				message.type === "ticketRequest" && message.operation.action === action,
		)

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(vscode.getState).mockReturnValue({ project: "project" })
	vi.mocked(vscode.postTicketMessage).mockImplementation((message) => {
		if (message.type === "ticketsReady")
			queueMicrotask(() =>
				window.dispatchEvent(
					new MessageEvent("message", {
						data: {
							type: "ticketProjects",
							projects: [{ id: "project", name: "Project" }],
							language: "en",
						},
					}),
				),
			)
		if (message.type === "ticketRequest" && message.operation.action === "list")
			queueMicrotask(() => reply(message.requestId, { tickets: [ticket], total: 1, invalidFiles: [] }))
	})
})

describe("ticket overview and sharing", () => {
	it("opens the overview for a new view and restores an explicit navigation choice", async () => {
		vi.mocked(vscode.getState).mockReturnValue(undefined)
		render(<TicketsView />)
		await waitFor(() => expect(requests("overview")).toHaveLength(1))
		reply(requests("overview")[0].requestId, {
			total: 8,
			complete: 3,
			backlog: 4,
			inProgress: 1,
			canceled: 0,
			points: [],
			invalidFiles: [],
		})
		expect(await screen.findByTestId("overview")).toHaveTextContent("8")
		fireEvent.click(screen.getByRole("button", { name: "title" }))
		expect(await screen.findByRole("button", { name: /Portable work/ })).toBeVisible()
		expect(vscode.setState).toHaveBeenLastCalledWith(expect.objectContaining({ view: "tickets" }))
	})

	it("exports selected identities, rather than only a displayed count", async () => {
		render(<TicketsView />)
		await screen.findByRole("button", { name: /Portable work/ })
		fireEvent.click(screen.getByRole("checkbox", { name: "transfer.selectTicket" }))
		fireEvent.click(screen.getByRole("button", { name: "transfer.export" }))
		fireEvent.click(screen.getByRole("button", { name: "transfer.saveExport" }))
		expect(requests("export")[0].operation).toEqual({
			action: "export",
			input: { ids: [ticket.id], includeDescendants: true },
		})
		reply(requests("export")[0].requestId, { kind: "exported", count: 1, fileName: "tickets.zip" })
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(screen.getByRole("status")).toHaveTextContent("transfer.exported")
	})

	it("cancels an import preview without committing and releases the host token", async () => {
		render(<TicketsView />)
		fireEvent.click(await screen.findByRole("button", { name: "transfer.import" }))
		reply(requests("previewImport")[0].requestId, preview)
		fireEvent.click(await screen.findByRole("button", { name: "cancel" }))
		expect(requests("import")).toHaveLength(0)
		expect(requests("discardImport")[0].operation).toEqual({ action: "discardImport", token })
	})

	it("commits the reviewed preview in copy mode and refreshes the list", async () => {
		render(<TicketsView />)
		fireEvent.click(await screen.findByRole("button", { name: "transfer.import" }))
		reply(requests("previewImport")[0].requestId, preview)
		fireEvent.click(await screen.findByRole("button", { name: "transfer.confirmImport" }))
		expect(requests("import")[0].operation).toEqual({ action: "import", token, mode: "copy", resetStatus: true })
		reply(requests("import")[0].requestId, { kind: "imported", imported: 1, skipped: 0 })
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(screen.getByText("transfer.imported")).toHaveAttribute("role", "status")
	})

	it("discards a consumed preview after failure and reloads before selecting another import", async () => {
		render(<TicketsView />)
		fireEvent.click(await screen.findByRole("button", { name: "transfer.import" }))
		reply(requests("previewImport")[0].requestId, preview)
		fireEvent.click(await screen.findByRole("button", { name: "transfer.confirmImport" }))
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "ticketResponse",
						requestId: requests("import")[0].requestId,
						error: "Import interrupted",
					},
				}),
			),
		)
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
		expect(screen.getByRole("alert")).toHaveTextContent("Import interrupted")
		expect(screen.getByRole("alert")).toHaveTextContent("transfer.importRecovery")
		expect(screen.queryByRole("button", { name: "transfer.confirmImport" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "transfer.import" })).toBeDisabled()
		expect(requests("discardImport")[0].operation).toEqual({ action: "discardImport", token })
		const readinessBefore = vi
			.mocked(vscode.postTicketMessage)
			.mock.calls.filter(([message]) => message.type === "ticketsReady").length
		fireEvent.click(screen.getByRole("button", { name: "reload" }))
		expect(
			vi.mocked(vscode.postTicketMessage).mock.calls.filter(([message]) => message.type === "ticketsReady"),
		).toHaveLength(readinessBefore + 1)
		await waitFor(() => expect(screen.getByRole("button", { name: "transfer.import" })).toBeEnabled())
		fireEvent.click(screen.getByRole("button", { name: "transfer.import" }))
		expect(requests("previewImport")).toHaveLength(2)
		expect(requests("import")).toHaveLength(1)
	})
})

describe("ticket transfer success notice timing", () => {
	afterEach(() => vi.useRealTimers())

	const openView = async () => {
		const view = render(<TicketsView />)
		await screen.findByRole("button", { name: /Portable work/ })
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		return view
	}
	const completeTransfer = async (kind: "export" | "import") => {
		fireEvent.click(screen.getByRole("button", { name: `transfer.${kind}` }))
		if (kind === "import") {
			await act(async () => reply(requests("previewImport").at(-1)!.requestId, preview))
			fireEvent.click(screen.getByRole("button", { name: "transfer.confirmImport" }))
			await act(async () =>
				reply(requests("import").at(-1)!.requestId, { kind: "imported", imported: 1, skipped: 0 }),
			)
		} else {
			fireEvent.click(screen.getByRole("button", { name: "transfer.saveExport" }))
			await act(async () =>
				reply(requests("export").at(-1)!.requestId, { kind: "exported", count: 1, fileName: "tickets.zip" }),
			)
		}
	}
	const advance = (milliseconds: number) => act(() => vi.advanceTimersByTimeAsync(milliseconds))

	it.each(["export", "import"] as const)("dismisses the %s notice after five seconds", async (kind) => {
		await openView()
		await completeTransfer(kind)
		expect(screen.getByRole("status")).toHaveTextContent(`transfer.${kind}ed`)
		await advance(4_999)
		expect(screen.getByRole("status")).toBeVisible()
		await advance(1)
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it("gives an identical subsequent export notice a fresh five seconds", async () => {
		await openView()
		await completeTransfer("export")
		await advance(4_000)
		await completeTransfer("export")
		await advance(1_000)
		expect(screen.getByRole("status")).toHaveTextContent("transfer.exported")
		await advance(3_999)
		expect(screen.getByRole("status")).toBeVisible()
		await advance(1)
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it("cleans up the dismissal timer when the view closes", async () => {
		const view = await openView()
		await completeTransfer("export")
		await advance(0)
		expect(vi.getTimerCount()).toBeGreaterThan(0)
		view.unmount()
		expect(vi.getTimerCount()).toBe(0)
	})
})
