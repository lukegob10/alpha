import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ClineMessage } from "@alpha-code/types"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "../../../utils/vscode"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

function renderTicketRow(payload: Record<string, unknown>, type: "say" | "ask" = "say") {
	const message: ClineMessage = {
		type,
		ts: 1,
		text: JSON.stringify({ tool: "ticket", ...payload }),
		...(type === "ask" ? { ask: "tool" as const } : { say: "tool" as const }),
	}
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={new QueryClient()}>
				<ChatRowContent
					message={message}
					isExpanded={false}
					isLast={false}
					isStreaming={false}
					onToggleExpand={() => {}}
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ticket chat messages", () => {
	it("collapses loaded tickets to a status line and reveals the reference on demand", () => {
		const { container } = renderTicketRow({
			ticketActivity: { operation: "read", state: "success", reference: "PM-01", name: "Backend cleanup" },
		})
		expect(screen.getByRole("group", { name: "activityTitle" })).toBeInTheDocument()
		expect(screen.getByText("activityLoaded")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "PM-01 · Backend cleanup" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "activityLoaded" }))
		expect(screen.getByRole("button", { name: "PM-01 · Backend cleanup" })).toBeInTheDocument()
		expect(container.querySelector("pre")).toBeNull()
	})
	it("shows search matches without claiming their contents were loaded", () => {
		renderTicketRow({
			ticketActivity: {
				operation: "list",
				state: "success",
				query: "backend",
				total: 1,
				matches: [{ reference: "PM-01", name: "Backend cleanup" }],
			},
		})
		expect(screen.getByText("activityFound")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "activityFound" }))
		expect(screen.getByRole("button", { name: "PM-01 · Backend cleanup" })).toBeInTheDocument()
		expect(screen.queryByText("activityLoaded")).not.toBeInTheDocument()
	})
	it("opens the exact ticket from a successful banner", () => {
		const post = vi.spyOn(vscode, "postMessage")
		const target = { project: "project-hash", id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f" }
		renderTicketRow({
			ticketActivity: {
				operation: "create",
				state: "success",
				name: "Backend cleanup",
				reference: "PM-01",
				target,
			},
		})
		fireEvent.click(screen.getByRole("button", { name: "activityCreated" }))
		fireEvent.click(screen.getByRole("button", { name: "PM-01 · Backend cleanup" }))
		expect(post).toHaveBeenCalledWith({ type: "openTicket", ticketTarget: target })
		post.mockRestore()
	})
	it.each([
		[{ operation: "list", state: "success", total: 0, matches: [] }, "empty"],
		[{ operation: "read", state: "error" }, "activityLookupFailed"],
		[{ operation: "read", state: "cancelled" }, "activityCancelled"],
	])("keeps unsuccessful lookups distinct from loaded tickets", (ticketActivity, label) => {
		renderTicketRow({ ticketActivity })
		expect(screen.getByText(label as string)).toBeInTheDocument()
		expect(screen.queryByText("activityLoaded")).not.toBeInTheDocument()
	})
	it.each(["create", "update"])("renders a simple %s confirmation without JSON", (operation) => {
		const { container } = renderTicketRow({
			ticketActivity: { operation, state: "success", name: "Readable ticket" },
		})
		expect(screen.getByText(operation === "create" ? "activityCreated" : "activityUpdated")).toBeInTheDocument()
		expect(screen.getByText("· Readable ticket")).toBeInTheDocument()
		expect(container.querySelector("pre")).toBeNull()
		expect(container).not.toHaveTextContent("ticketActivity")
	})
	it("shows the approval request without claiming it has succeeded", () => {
		renderTicketRow({ ticketActivity: { operation: "create", state: "pending", name: "Pending ticket" } }, "ask")
		expect(screen.getByText("activityCreate")).toBeInTheDocument()
		expect(screen.queryByText("activityCreated")).not.toBeInTheDocument()
	})
	it("shows deletion awaiting approval and a non-clickable confirmation after deletion", () => {
		const activity = {
			operation: "delete",
			name: "Deleted ticket",
			reference: "PM-01",
			target: { project: "project-hash", id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f" },
		}
		const pending = renderTicketRow({ ticketActivity: { ...activity, state: "pending" } }, "ask")
		expect(screen.getByText("activityDelete")).toBeInTheDocument()
		expect(screen.queryByText("activityDeleted")).not.toBeInTheDocument()
		pending.unmount()
		const { container } = renderTicketRow({ ticketActivity: { ...activity, state: "success" } })
		expect(screen.getByText("activityDeleted")).toBeInTheDocument()
		expect(screen.getByText("PM-01")).toBeInTheDocument()
		expect(screen.getByText("· Deleted ticket")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /PM-01/ })).not.toBeInTheDocument()
		expect(container.querySelector("pre")).toBeNull()
	})
	it("keeps legacy saved requests readable without showing their payload", () => {
		const { container } = renderTicketRow(
			{
				content: JSON.stringify({
					operation: "create_ticket",
					name: "Old ticket",
					context: "Long private context",
					expectedRevision: "raw-revision",
				}),
			},
			"ask",
		)
		expect(screen.getByText("· Old ticket")).toBeInTheDocument()
		expect(container).not.toHaveTextContent("Long private context")
		expect(container).not.toHaveTextContent("raw-revision")
		expect(container.querySelector("pre")).toBeNull()
	})
	it("uses a generic label for malformed saved payloads", () => {
		renderTicketRow({ content: "{malformed-json" }, "ask")
		expect(screen.getByText("title")).toBeInTheDocument()
		expect(screen.queryByText("{malformed-json")).not.toBeInTheDocument()
	})
})
