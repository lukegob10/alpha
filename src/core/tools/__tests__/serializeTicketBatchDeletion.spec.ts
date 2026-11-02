import { describe, expect, it } from "vitest"
import { reserveTicketBatchMutationReceipt, serializeTicketBatchDeletionResult } from "../serializeTicketResult"

describe("batch ticket deletion receipts", () => {
	it("reports only the confirmed count without repeating full ticket contents", () => {
		expect(serializeTicketBatchDeletionResult(17)).toEqual({
			content: JSON.stringify({ status: "success", result: { deleted: 17 } }),
			truncated: false,
		})
	})

	it("reserves enough space for the largest accepted batch before committing", () => {
		const maximum = serializeTicketBatchDeletionResult(1000).content.length
		expect(() => reserveTicketBatchMutationReceipt(maximum - 1)).toThrow("output budget")
		expect(() => reserveTicketBatchMutationReceipt(maximum)).not.toThrow()
		for (const count of [0, 1, 17, 99, 1000]) {
			const receipt = serializeTicketBatchDeletionResult(count, maximum)
			expect(receipt.content.length).toBeLessThanOrEqual(maximum)
			expect(JSON.parse(receipt.content)).toEqual({ status: "success", result: { deleted: count } })
		}
	})

	it.each([-1, 1.5, 1001, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid counts: %s", (count) => {
		expect(() => serializeTicketBatchDeletionResult(count)).toThrow("Invalid ticket deletion count")
	})
})
