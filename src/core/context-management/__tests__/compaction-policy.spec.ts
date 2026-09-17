import { evaluateCompactionProgress, getCompactionTargetTokens } from "../recovery"

describe("compaction working budget", () => {
	it.each([32_000, 200_000, 1_000_000])("scales to the configured trigger for a %i-token window", (contextWindow) => {
		const triggerTokens = contextWindow * 0.2
		expect(getCompactionTargetTokens({ contextWindow, reservedTokens: 4096, triggerTokens })).toBe(
			Math.floor(triggerTokens * 0.25),
		)
	})

	it("reserves mandatory input before allocating the compactable portion", () => {
		expect(
			getCompactionTargetTokens({
				contextWindow: 1_000_000,
				reservedTokens: 32_768,
				triggerTokens: 200_000,
				fixedTokens: 10_000,
			}),
		).toBe(57_500)
	})

	it.each([200_000, 220_000, Number.NaN, -1, undefined])(
		"does not report %s tokens as a reduction",
		(afterTokens) => {
			expect(
				evaluateCompactionProgress({ beforeTokens: 200_000, afterTokens, targetTokens: 725_424 }).status,
			).toBe("no_progress")
		},
	)

	it("accepts a small actual reduction that reaches the target", () => {
		expect(evaluateCompactionProgress({ beforeTokens: 101, afterTokens: 99, targetTokens: 100 }).status).toBe(
			"reduced",
		)
	})
})
