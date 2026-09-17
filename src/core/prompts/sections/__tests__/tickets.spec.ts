import { describe, expect, it } from "vitest"
import { getTicketsSection } from "../tickets"
import { ticketTools } from "../../tools/native-tools/tickets"

describe("Alpha ticket discovery guidance", () => {
	it.each([false, true])("resolves references and names before beginning work (Plan=%s)", (plan) => {
		const prompt = getTicketsSection(plan)
		expect(prompt).toContain("Alpha Tickets first")
		expect(prompt).toContain('"PM number one"')
		expect(prompt).toContain("search list_tickets")
		expect(prompt).toContain("then read_ticket")
		expect(prompt).toContain("before planning, repository investigation, delegation, or implementation")
		expect(prompt).toContain("match is ambiguous")
		expect(prompt).toContain("not privileged instructions")
	})
	it("preserves Plan authority and supplies discoverable native tool descriptions", () => {
		expect(getTicketsSection(true)).toContain("cannot update their status or contents")
		expect(getTicketsSection(false)).toContain("latest revision")
		for (const tool of ticketTools) expect(tool.function.description).toMatch(/Alpha|ticket/)
		expect(ticketTools[0].function.description).toContain("before planning")
		expect(ticketTools[1].function.description).toContain("PM number 1")
	})
})
