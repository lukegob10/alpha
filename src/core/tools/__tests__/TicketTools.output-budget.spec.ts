import { afterEach, describe, expect, it, vi } from "vitest"
import { ticketSchema, type Ticket, type TicketList } from "@alpha-code/types"

import { TicketStore } from "../../../services/tickets/TicketStore"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"
import { makeExecutionHost, toolResults } from "./nor30-tool-fixtures"

const mutationNames = ["create_ticket", "update_ticket", "delete_ticket"] as const
type MutationName = (typeof mutationNames)[number]

function ticketWithContent(content: string): Ticket {
	// Use the persisted reader's field order: large sections precede identity and revision metadata.
	return ticketSchema.parse({
		name: "Ticket with retained context",
		description: content,
		context: content,
		successCriteria: content,
		implementationSummary: content,
		schemaVersion: 1,
		id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
		reference: "AAAA-9999999999",
		status: "in-progress",
		createdAt: "2026-10-25T00:00:00.000Z",
		updatedAt: "2026-10-25T00:00:00.000Z",
		linkedTaskIds: [],
		revision: "f".repeat(64),
	})
}

function fixture(ticket = ticketWithContent("x".repeat(16_000)), cap = 32_000, feedback?: string) {
	const store = {
		projectId: "ticket-project",
		create: vi.fn(async () => ticket),
		update: vi.fn(async () => ticket),
		delete: vi.fn(async () => ticket),
		read: vi.fn(async () => ticket),
		list: vi.fn(async (): Promise<TicketList> => ({ tickets: [], total: 0, invalidFiles: [] })),
	}
	vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store as unknown as TicketStore)
	const harness = makeExecutionHost({ approval: { response: "yesButtonClicked", text: feedback } })
	Object.assign(harness.task, { taskKind: "primary", canMutateWorkspace: () => true })
	const surface = createTaskToolSurface({
		registry: new ToolRegistry(),
		mode: "code",
		cwd: harness.host.cwd,
		approvalMode: "ask",
		outputLimits: Object.fromEntries([...mutationNames, "read_ticket", "list_tickets"].map((name) => [name, cap])),
	})
	const effectStart = vi.fn(async () => undefined)
	const run = (name: MutationName | "read_ticket" | "list_tickets", args: unknown) =>
		new ToolScheduler({
			executionHost: harness.host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
			onEffectStart: effectStart,
		}).run([{ type: "tool_call", id: "ticket-call", name, arguments: args }])
	const mutate = (name: MutationName) =>
		run(
			name,
			name === "create_ticket" ? { name: ticket.name } : { id: ticket.id, expectedRevision: ticket.revision },
		)
	return { store, harness, ticket, run, mutate, effectStart }
}

afterEach(() => vi.restoreAllMocks())

describe("ticket receipts through the scheduler output budget", () => {
	it.each(mutationNames)("retains a usable %s receipt under the scheduler policy cap", async (name) => {
		const test = fixture()
		const outcome = await test.mutate(name)
		const result = outcome.results[0]!
		const text = String(result.content)
		const response = JSON.parse(text)

		expect(text.length).toBeLessThanOrEqual(32_000)
		expect(text).not.toContain("[Tool output truncated by harness]")
		expect(response).toMatchObject({
			status: "success",
			truncated: true,
			result: {
				id: test.ticket.id,
				reference: test.ticket.reference,
				status: test.ticket.status,
				revision: test.ticket.revision,
			},
		})
		expect(result).toMatchObject({ status: "success", truncated: true })
		expect(result.trustedProgress).toBeUndefined()
		const mutation =
			test.store[name === "create_ticket" ? "create" : name === "update_ticket" ? "update" : "delete"]
		expect(mutation).toHaveBeenCalledOnce()
		expect(toolResults(test.harness)).toHaveLength(1)
	})

	it.each([400, 32_000])("keeps escaped Unicode JSON complete within a %s-character policy", async (cap) => {
		const ticket = ticketWithContent('\u0000"\\😀\n'.repeat(2_000))
		const test = fixture(ticket, cap)
		const outcome = await test.mutate("create_ticket")
		const text = String(outcome.results[0]!.content)
		const response = JSON.parse(text)

		expect(text.length).toBeLessThanOrEqual(cap)
		expect(response.result).toMatchObject({ id: ticket.id, reference: ticket.reference, revision: ticket.revision })
		expect(response.truncated).toBe(true)
		for (const key of ["description", "context", "successCriteria", "implementationSummary"] as const) {
			expect(ticket[key].startsWith(response.result[key])).toBe(true)
			expect(response.result[key]).not.toMatch(/[\uD800-\uDBFF]$/)
		}
		expect(test.store.create).toHaveBeenCalledOnce()
		expect(toolResults(test.harness)).toHaveLength(1)
	})

	it("reserves room after approval feedback and preserves both JSON packets", async () => {
		const feedback = "Retain the requested context. ".repeat(8)
		const test = fixture(undefined, 800, feedback)
		const outcome = await test.mutate("create_ticket")
		const text = String(outcome.results[0]!.content)
		const packets = text.split("\n\n").map((packet) => JSON.parse(packet))

		expect(text.length).toBeLessThanOrEqual(800)
		expect(packets).toHaveLength(2)
		expect(packets[0]).toEqual({ status: "approved", feedback })
		expect(packets[1]).toMatchObject({
			status: "success",
			result: { id: test.ticket.id, reference: test.ticket.reference, revision: test.ticket.revision },
		})
		expect(test.store.create).toHaveBeenCalledOnce()
		expect(toolResults(test.harness)).toHaveLength(1)
	})

	it.each(mutationNames)("rejects %s before the store mutation when its identity cannot fit", async (name) => {
		const test = fixture(undefined, 160)
		const outcome = await test.mutate(name)

		expect(outcome.results[0]!.status).toBe("error")
		expect(JSON.parse(String(outcome.results[0]!.content))).toMatchObject({ status: "error" })
		expect(test.store.create).not.toHaveBeenCalled()
		expect(test.store.update).not.toHaveBeenCalled()
		expect(test.store.delete).not.toHaveBeenCalled()
		expect(test.harness.host.ask).not.toHaveBeenCalled()
		expect(test.effectStart).not.toHaveBeenCalled()
		expect(toolResults(test.harness)).toHaveLength(1)
	})

	it("does not commit when approval feedback consumes the reserved receipt capacity", async () => {
		const feedback = "f".repeat(650)
		const test = fixture(undefined, 800, feedback)
		const outcome = await test.mutate("create_ticket")
		const text = String(outcome.results[0]!.content)
		const packets = text.split("\n\n").map((packet) => JSON.parse(packet))

		expect(text.length).toBeLessThanOrEqual(800)
		expect(outcome.results[0]!.status).toBe("error")
		expect(packets).toEqual([
			{ status: "approved", feedback },
			{ status: "error", message: "Ticket response metadata exceeds the output budget" },
		])
		expect(test.store.create).not.toHaveBeenCalled()
		expect(toolResults(test.harness)).toHaveLength(1)
	})

	it("preserves complete small results without changing their shape", async () => {
		const test = fixture(ticketWithContent("Retained context"))
		const outcome = await test.mutate("create_ticket")

		expect(outcome.results[0]).toMatchObject({ status: "success", truncated: false })
		expect(outcome.results[0]!.content).toBe(JSON.stringify({ status: "success", result: test.ticket }))
	})

	it("keeps read receipts valid under the same reduced policy cap", async () => {
		const test = fixture(undefined, 400)
		const outcome = await test.run("read_ticket", { id: test.ticket.id })

		expect(JSON.parse(String(outcome.results[0]!.content))).toMatchObject({
			status: "success",
			truncated: true,
			result: { id: test.ticket.id, revision: test.ticket.revision },
		})
		expect(test.harness.host.ask).not.toHaveBeenCalled()
	})

	it("retains every identity and revision from a compacted list page", async () => {
		const test = fixture()
		const tickets = Array.from({ length: 50 }, (_, index) => ({
			id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
			reference: `AAAA-${index + 10}`,
			name: "Long ticket name ".repeat(10),
			status: "backlog" as const,
			updatedAt: test.ticket.updatedAt,
			revision: test.ticket.revision,
			childCount: 0,
			completedChildCount: 0,
		}))
		test.store.list.mockResolvedValueOnce({ tickets, total: 100, invalidFiles: ["private-path/".repeat(4_000)] })
		const outcome = await test.run("list_tickets", { offset: 50, limit: 50 })
		const text = String(outcome.results[0]!.content)
		const response = JSON.parse(text)

		expect(text.length).toBeLessThanOrEqual(32_000)
		expect(response.truncated).toBe(true)
		expect(response.result.total).toBe(100)
		expect(
			response.result.tickets.map(({ id, revision }: { id: string; revision: string }) => ({ id, revision })),
		).toEqual(tickets.map(({ id, revision }) => ({ id, revision })))
		expect(toolResults(test.harness)).toHaveLength(1)
	})
})
