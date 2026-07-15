import { RooCodeEventName } from "@alpha-code/types"
import { describe, expect, it } from "vitest"

import { shouldExhaustTaskBudget } from "../runTaskInCli"

describe("CLI task budget decisions", () => {
	it("cancels an in-progress task when its cost reaches the cap", () => {
		expect(
			shouldExhaustTaskBudget({
				eventName: RooCodeEventName.TaskTokenUsageUpdated,
				alreadyExhausted: false,
				cost: 0.06,
				cap: 0.06,
			}),
		).toBe(true)
	})

	it("does not overwrite a completed task with budget exhaustion", () => {
		expect(
			shouldExhaustTaskBudget({
				eventName: RooCodeEventName.TaskCompleted,
				alreadyExhausted: false,
				cost: 0.061,
				cap: 0.06,
			}),
		).toBe(false)
	})
})
