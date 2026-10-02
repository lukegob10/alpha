import { afterEach, describe, expect, it, vi } from "vitest"
import { TicketStore } from "../TicketStore"
import { searchTicketMentions, readTicketMention } from "../TicketChat"
import { parseMentions, openMention } from "../../../core/mentions"
import { processUserContentMentions } from "../../../core/mentions/processUserContentMentions"
import * as vscode from "vscode"
import type { FileContextTracker } from "../../../core/context-tracking/FileContextTracker"
import * as fs from "fs/promises"
import os from "os"
import path from "path"

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn() } }))
vi.mock("fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs/promises")>()
	return { ...original, readFile: vi.fn(original.readFile) }
})
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
	it("loads five large attachments with one project scan while preserving every selected record", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-attachments-"))
		try {
			const workspace = path.join(home, "project")
			await fs.mkdir(workspace)
			const store = await TicketStore.forWorkspace(workspace, home)
			const tickets = []
			for (let index = 0; index < 5; index++) {
				tickets.push(
					await store.create({
						name: `Large app ticket ${index + 1}`,
						description: "d".repeat(16000),
						context: "c".repeat(16000),
						successCriteria: "s".repeat(16000),
						implementationSummary: "i".repeat(16000),
					}),
				)
			}
			vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store)
			const reads = vi.mocked(fs.readFile)
			reads.mockClear()
			const started = performance.now()
			const result = await parseMentions(
				tickets.map((ticket) => `@ticket:${ticket.reference}`).join(" "),
				workspace,
			)
			const elapsed = performance.now() - started
			const markdownReads = reads.mock.calls.filter(([file]) => typeof file === "string" && file.endsWith(".md"))
			const bytes = (await Promise.all(reads.mock.results.map((read) => read.value))).reduce(
				(total, value) => total + Buffer.byteLength(value),
				0,
			)
			if (process.env.ALPHA_TICKET_ATTACHMENT_BENCHMARK === "1") {
				console.info(
					JSON.stringify({
						tickets: tickets.length,
						markdownReads: markdownReads.length,
						bytes,
						elapsedMs: elapsed,
					}),
				)
			}
			expect(markdownReads.length).toBeGreaterThan(0)
			expect(
				result.contentBlocks.map((block) => JSON.parse(block.content.slice(block.content.indexOf("\n") + 1))),
			).toEqual(tickets)
			expect(
				markdownReads.length,
				`Five large tickets: ${bytes} bytes read in ${elapsed.toFixed(1)} ms`,
			).toBeLessThanOrEqual(10)
		} finally {
			vi.restoreAllMocks()
			await fs.rm(home, { recursive: true, force: true })
		}
	})
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
		expect(store.read).toHaveBeenCalledExactlyOnceWith("PM-01", undefined)
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
	it.each(["initial", "feedback-string", "feedback-array"] as const)(
		"propagates %s attachment cancellation without publishing failure context",
		async (surface) => {
			const store = mockStore()
			const cancellation = new AbortController()
			const reason = new Error("attachment preparation cancelled")
			const activity = vi.fn()
			vi.mocked(TicketStore.forWorkspace).mockImplementation(async (_cwd, _home, signal) => {
				expect(signal).toBe(cancellation.signal)
				cancellation.abort(reason)
				throw reason
			})
			const text = "<user_message>\nRead @ticket:PM-01\n</user_message>"
			const userContent =
				surface === "initial"
					? [{ type: "text" as const, text }]
					: [
							{
								type: "tool_result" as const,
								tool_use_id: "feedback",
								content: surface === "feedback-string" ? text : [{ type: "text" as const, text }],
							},
						]
			await expect(
				processUserContentMentions({
					cwd: "/project",
					fileContextTracker: {} as FileContextTracker,
					userContent,
					onTicketActivity: activity,
					signal: cancellation.signal,
				}),
			).rejects.toBe(reason)
			expect(store.read).not.toHaveBeenCalled()
			expect(activity).not.toHaveBeenCalled()
		},
	)
	it("preserves attachment order and individual errors in a batch", async () => {
		const store = mockStore()
		const second = { ...ticket, id: "db99f570-ce68-4ad8-85cb-f5c10391343d", reference: "PM-02", name: "Second" }
		const readMany = vi.fn().mockResolvedValue([{ ticket: second }, { error: new Error("Missing") }, { ticket }])
		Object.assign(store, { readMany })
		const activity = vi.fn()
		const result = await parseMentions(
			"@PM-02 @PM-99 @PM-01",
			"/project",
			undefined,
			undefined,
			false,
			true,
			50,
			undefined,
			"code",
			activity,
		)
		expect(readMany).toHaveBeenCalledExactlyOnceWith(["PM-02", "PM-99", "PM-01"], undefined)
		expect(result.contentBlocks[0].content).toContain('"name":"Second"')
		expect(result.contentBlocks[1].content).toContain("Could not load this ticket")
		expect(result.contentBlocks[2].content).toContain('"name":"Backend cleanup"')
		expect(activity.mock.calls.map(([entry]) => entry.state)).toEqual(["success", "error", "success"])
	})
	it("fails closed when an attached reference changes after the batch index is read", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-attachment-race-"))
		const reads = vi.mocked(fs.readFile)
		const originalRead = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).readFile
		try {
			const workspace = path.join(home, "project")
			await fs.mkdir(workspace)
			const store = await TicketStore.forWorkspace(workspace, home)
			const first = await store.create({ name: "First" })
			const second = await store.create({ name: "Second" })
			const file = await store.markdownPath(second.id)
			vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store)
			let indexedSecond = false
			reads.mockImplementation(async (...args) => {
				const value = await originalRead(...args)
				if (args[0] === file && !indexedSecond) {
					indexedSecond = true
					await fs.writeFile(file, String(value).replace("PRO-02", "PRO-99"))
				}
				return value
			})
			const ticketReads = vi.spyOn(store, "readMany")
			const result = await parseMentions(`@${first.reference} @${second.reference}`, workspace)
			expect(await ticketReads.mock.results[0].value).toMatchObject([
				{ ticket: first },
				{ error: expect.any(Error) },
			])
			expect(result.contentBlocks[0].content).toContain('"name":"First"')
			expect(result.contentBlocks[1].content).toContain("Could not load this ticket")
			expect(await store.read(second.id)).toMatchObject({ reference: "PRO-99" })
		} finally {
			reads.mockImplementation(originalRead)
			vi.restoreAllMocks()
			await fs.rm(home, { recursive: true, force: true })
		}
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
