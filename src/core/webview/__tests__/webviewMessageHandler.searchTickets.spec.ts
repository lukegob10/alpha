import { beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("../../../services/tickets/TicketChat", () => ({ searchTicketMentions: vi.fn() }))
import { searchTicketMentions } from "../../../services/tickets/TicketChat"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"

describe("project ticket search routing", () => {
	const response = { type: "ticketSearchResults" as const, requestId: "lookup", tickets: [] }
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(searchTicketMentions).mockResolvedValue(response)
	})
	function provider() {
		return {
			cwd: "/workspace",
			getCurrentTask: vi.fn(() => ({ cwd: "/foreground-project" })),
			getLiveTask: vi.fn((id: string) => (id === "editor" ? { cwd: "/editor-project" } : undefined)),
			postMessageToWebview: vi.fn(),
		}
	}
	it("uses the editor task's project even when a different project is foreground", async () => {
		const host = provider()
		const message = { type: "searchTickets" as const, taskId: "editor", requestId: "lookup", query: "" }
		await webviewMessageHandler(host as unknown as AlphaProvider, message)
		expect(searchTicketMentions).toHaveBeenCalledExactlyOnceWith("/editor-project", message)
	})
	it("fails closed for an unknown task instead of searching the foreground project", async () => {
		const host = provider()
		await webviewMessageHandler(host as unknown as AlphaProvider, {
			type: "searchTickets",
			taskId: "unknown",
			requestId: "lookup",
			query: "",
		})
		expect(searchTicketMentions).not.toHaveBeenCalled()
		expect(host.postMessageToWebview).toHaveBeenCalledWith({
			type: "ticketSearchResults",
			ticketSearch: { ...response, error: true },
		})
	})
})
