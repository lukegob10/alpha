import { historyItemSchema, orchestrationCompletionNotificationSchema } from "../history.js"

const legacy = {
	id: "child",
	orchestrationParentTaskId: "parent",
	number: 1,
	ts: 1,
	task: "Inspect parser",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}
const receipt = { id: "completion:turn-1", turnId: "turn-1", completionMessageTs: 100, createdAt: 101 }

it("keeps legacy history readable and preserves completion delivery identities across reload", () => {
	expect(historyItemSchema.parse(legacy).orchestrationCompletionNotifications).toBeUndefined()
	const saved = {
		...legacy,
		orchestrationCompletionNotifications: [
			receipt,
			{
				...receipt,
				id: "completion:turn-2",
				turnId: "turn-2",
				completionMessageTs: 200,
				deliveredAt: 201,
				deliveredVia: "wait",
			},
		],
	}
	expect(historyItemSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
})

it("bounds completion receipts and their identities", () => {
	expect(
		historyItemSchema.safeParse({ ...legacy, orchestrationCompletionNotifications: Array(100).fill(receipt) })
			.success,
	).toBe(true)
	expect(
		historyItemSchema.safeParse({ ...legacy, orchestrationCompletionNotifications: Array(101).fill(receipt) })
			.success,
	).toBe(false)
	expect(orchestrationCompletionNotificationSchema.safeParse({ ...receipt, id: "x".repeat(257) }).success).toBe(false)
	expect(
		orchestrationCompletionNotificationSchema.safeParse({ ...receipt, completionMessageTs: Number.NaN }).success,
	).toBe(false)
})
