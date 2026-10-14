import { describe, expect, it } from "vitest"
import { acceptanceReceiptSchema, taskWorkContextSchema } from "../task-work-context.js"

describe("acceptance receipt diagnostics", () => {
	const receipt = {
		checkId: "catalog-validation",
		definitionDigest: "definition",
		executionId: "execution",
		status: "unavailable",
		observedAt: 1,
	}

	it("reads legacy receipts without diagnostics", () => {
		expect(acceptanceReceiptSchema.parse(receipt)).toEqual(receipt)
	})

	it("preserves diagnostics through saved task parsing", () => {
		const saved = {
			receipts: [{ ...receipt, diagnostic: "Check input is ignored" }],
			skills: [],
		}
		expect(taskWorkContextSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
	})

	it("bounds persisted diagnostics", () => {
		expect(acceptanceReceiptSchema.safeParse({ ...receipt, diagnostic: "x".repeat(501) }).success).toBe(false)
	})
})
