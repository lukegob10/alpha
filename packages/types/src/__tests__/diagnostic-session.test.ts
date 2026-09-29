import { diagnosticTaskIdentitySchema, historyItemSchema } from "../history.js"

describe("diagnostic task history metadata", () => {
	it("accepts bounded diagnostic identities and preserves them when parsing", () => {
		const item = historyItemSchema.parse({
			id: "diagnostic-task",
			diagnosticSession: true,
			diagnosticIncidentId: "incident-42",
			diagnosticSourceTaskId: "source-task-9",
			number: 1,
			ts: 1,
			task: "Inspect incident evidence",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})

		expect(item).toMatchObject({
			diagnosticSession: true,
			diagnosticIncidentId: "incident-42",
			diagnosticSourceTaskId: "source-task-9",
		})
	})

	it("keeps old history readable and rejects oversized diagnostic IDs", () => {
		const legacy = historyItemSchema.parse({
			id: "legacy-task",
			number: 1,
			ts: 1,
			task: "Legacy task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})

		expect(legacy.diagnosticSession).toBeUndefined()
		expect(diagnosticTaskIdentitySchema.safeParse("x".repeat(128)).success).toBe(true)
		expect(diagnosticTaskIdentitySchema.safeParse("x".repeat(129)).success).toBe(false)
	})
})
