import { describe, expect, it } from "vitest"

import { historyItemSchema } from "../history.js"

const history = {
	id: "thread-1",
	number: 1,
	ts: 1,
	task: "Review the parser",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}

describe("saved thread model routes", () => {
	it("keeps legacy histories readable without a route capture", () => {
		expect(historyItemSchema.parse(history)).not.toHaveProperty("threadModelRoute")
	})

	it("round-trips explicit provider/profile/model identity without credentials", () => {
		const route = {
			source: "spawn",
			resolution: "selected",
			profileId: "profile-2",
			profileName: "OpenAI work",
			provider: "openai-native",
			modelId: "gpt-5.6-sol",
			requestedReasoningEffort: "high",
		} as const
		const parsed = historyItemSchema.parse({
			...history,
			apiConfigName: route.profileName,
			threadModelOverride: route.modelId,
			threadModelRoute: { ...route, apiKey: "excluded-test-secret" },
		})
		expect(parsed.threadModelRoute).toEqual(route)
		expect(JSON.stringify(parsed)).not.toContain("excluded-test-secret")
	})

	it("rejects malformed persisted inference metadata", () => {
		expect(
			historyItemSchema.safeParse({
				...history,
				threadModelRoute: {
					source: "spawn",
					resolution: "selected",
					profileName: "Work",
					requestedReasoningEffort: "invented",
				},
			}).success,
		).toBe(false)
	})
})
