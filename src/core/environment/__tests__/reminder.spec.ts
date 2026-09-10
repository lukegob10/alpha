import { formatReminderSection } from "../reminder"

describe("task reminders", () => {
	it.each([undefined, []])("does not turn an absent plan into work", (todos) => {
		expect(formatReminderSection(todos)).toBe("")
	})

	it("preserves the full checklist and batches tracking at meaningful boundaries", () => {
		const reminder = formatReminderSection([
			{ id: "1", content: "Read a|b\\c", status: "completed" },
			{ id: "2", content: "Implement", status: "in_progress" },
			{ id: "3", content: "Required checks", status: "pending" },
		])
		expect(reminder).toContain("Read a\\|b\\\\c | Completed")
		expect(reminder).toContain("Implement | In Progress")
		expect(reminder).toContain("Required checks | Pending")
		expect(reminder).toContain("meaningful stage transitions")
		expect(reminder).not.toContain("IMPORTANT")
	})
})
