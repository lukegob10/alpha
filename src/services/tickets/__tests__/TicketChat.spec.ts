import { afterEach, describe, expect, it, vi } from "vitest"
import { TicketStore } from "../TicketStore"
import { searchTicketMentions, readTicketMention } from "../TicketChat"
import { parseMentions, openMention } from "../../../core/mentions"
import { processUserContentMentions } from "../../../core/mentions/processUserContentMentions"
import * as vscode from "vscode"
import type { FileContextTracker } from "../../../core/context-tracking/FileContextTracker"

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn() } }))
const ticket = {
	id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
	reference: "PM-01",
	name: "Backend cleanup",
	revision: "current",
	context: "Latest ticket context",
}
function mockStore() {
	const store = {
		projectId: "project-hash",
		read: vi.fn().mockResolvedValue(ticket),
		list: vi.fn().mockResolvedValue({ tickets: [ticket], total: 1 }),
	}
	vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store as unknown as TicketStore)
	return store
}
afterEach(() => vi.restoreAllMocks())
describe("ticket chat context", () => {
	it("searches only the host's current project and correlates its response", async () => {
		const store = mockStore()
		const result = await searchTicketMentions("/project", {
			type: "searchTickets",
			requestId: "a",
			query: "PM1",
			cwd: "/untrusted",
		})
		expect(TicketStore.forWorkspace).toHaveBeenCalledExactlyOnceWith("/project")
		expect(store.list).toHaveBeenCalledExactlyOnceWith({ query: "PM1", offset: 0, limit: 50 })
		expect(result).toEqual({ type: "ticketSearchResults", requestId: "a", tickets: [ticket] })
	})
	it("rejects oversized searches and distinguishes unavailable storage from no matches", async () => {
		const store = mockStore()
		expect(
			await searchTicketMentions("/project", { type: "searchTickets", requestId: "a", query: "x".repeat(201) }),
		).toBeUndefined()
		expect(store.list).not.toHaveBeenCalled()
		store.list.mockRejectedValue(new Error("private path"))
		expect(await searchTicketMentions("/project", { type: "searchTickets", requestId: "b", query: "" })).toEqual({
			type: "ticketSearchResults",
			requestId: "b",
			tickets: [],
			error: true,
		})
	})
	it("loads an explicit ticket once and emits clickable evidence without JSON in the banner", async () => {
		const store = mockStore()
		const activity = vi.fn()
		const result = await parseMentions(
			"Plan @ticket:PM-01, @tickets:pm-1 and @PM-01.",
			"/project",
			undefined,
			undefined,
			false,
			true,
			50,
			undefined,
			"architect",
			activity,
		)
		expect(store.read).toHaveBeenCalledExactlyOnceWith("PM-01")
		expect(result.contentBlocks).toHaveLength(1)
		expect(result.contentBlocks[0]?.content).toContain("Latest ticket context")
		expect(result.contentBlocks[0]?.content).toContain('"revision":"current"')
		expect(activity).toHaveBeenCalledExactlyOnceWith({
			operation: "read",
			state: "success",
			name: ticket.name,
			reference: ticket.reference,
			target: { project: "project-hash", id: ticket.id },
		})
	})
	it("forwards selected ticket content and activity through initial and feedback messages", async () => {
		mockStore()
		const activity = vi.fn()
		const result = await processUserContentMentions({
			cwd: "/project",
			fileContextTracker: {} as FileContextTracker,
			onTicketActivity: activity,
			userContent: [
				{ type: "text", text: "<user_message>\nWork on @ticket:PM-01\n</user_message>" },
				{
					type: "tool_result",
					tool_use_id: "feedback",
					content: [{ type: "text", text: "<user_message>\nRead @ticket:PM-01\n</user_message>" }],
				},
			],
		})
		expect(JSON.stringify(result.content)).toContain("Latest ticket context")
		expect(activity).toHaveBeenCalledTimes(2)
	})
	it.each(["ticket:PM-01", "tickets:pm-1", "PM-01"])(
		"opens %s by stable identity and reports missing mentions truthfully",
		async (mention) => {
			const store = mockStore()
			await openMention("/project", mention)
			expect(store.read).toHaveBeenCalledExactlyOnceWith("PM-01")
			expect(vscode.commands.executeCommand).toHaveBeenCalledWith("alpha.openTickets", {
				project: "project-hash",
				id: ticket.id,
			})
			store.read.mockRejectedValue(new Error("missing"))
			const result = await readTicketMention("/project", "PM-99")
			expect(result.activity).toEqual({ operation: "read", state: "error" })
			expect(result.content).toContain("before working on it")
		},
	)
})
