import { alphaMessageSchema, compactionUsageReceiptSchema, MAX_COMPACTION_USAGE_RECEIPTS } from "../message.js"

const receipt = {
	attemptId: "compaction-attempt",
	inputIncludesCache: true,
	inputTokens: 100,
	outputTokens: 20,
	cacheReadTokens: 40,
	cacheWriteTokens: 5,
	reasoningTokens: 10,
	usageSource: "provider",
	totalCost: 0.25,
	goalReceipt: { goalTaskId: "task", goalId: "goal", eventId: "compaction:attempt", tokens: 80, timeMs: 0 },
}

it("round trips optional usage on existing partial and terminal message anchors", () => {
	for (const partial of [true, false]) {
		const message = {
			ts: 1,
			type: "say",
			say: "text",
			partial,
			text: "Existing text",
			compactionUsageReceipts: [receipt],
		}
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	}
	expect(alphaMessageSchema.parse({ ts: 1, type: "say", say: "text" })).not.toHaveProperty("compactionUsageReceipts")
})

it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
	"rejects invalid finalized usage counter %s",
	(inputTokens) => {
		expect(compactionUsageReceiptSchema.safeParse({ ...receipt, inputTokens }).success).toBe(false)
	},
)

it("rejects unbounded receipt collections and arbitrary provider payloads", () => {
	const message = {
		ts: 1,
		type: "say",
		say: "text",
		compactionUsageReceipts: Array(MAX_COMPACTION_USAGE_RECEIPTS + 1).fill(receipt),
	}
	expect(alphaMessageSchema.safeParse(message).success).toBe(false)
	expect(compactionUsageReceiptSchema.safeParse({ ...receipt, attemptId: "x".repeat(257) }).success).toBe(false)
	expect(
		compactionUsageReceiptSchema.safeParse({ ...receipt, encrypted_content: "private-provider-state" }).success,
	).toBe(false)
	expect(compactionUsageReceiptSchema.safeParse({ ...receipt, totalCost: Infinity }).success).toBe(false)
})

it("requires a zero-token elapsed companion to keep its base goal and event identity", () => {
	const elapsed = { ...receipt.goalReceipt, eventId: `${receipt.goalReceipt.eventId}:elapsed`, tokens: 0, timeMs: 50 }
	expect(compactionUsageReceiptSchema.parse({ ...receipt, goalElapsedReceipt: elapsed }).goalElapsedReceipt).toEqual(
		elapsed,
	)
	for (const changed of [{ tokens: 1 }, { goalId: "replacement" }, { eventId: "other" }]) {
		expect(
			compactionUsageReceiptSchema.safeParse({ ...receipt, goalElapsedReceipt: { ...elapsed, ...changed } })
				.success,
		).toBe(false)
	}
	expect(
		compactionUsageReceiptSchema.safeParse({ ...receipt, goalReceipt: undefined, goalElapsedReceipt: elapsed })
			.success,
	).toBe(false)
})
