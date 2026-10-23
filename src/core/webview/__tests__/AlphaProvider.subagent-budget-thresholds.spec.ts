import { createManagedPublicLifecycleHarness } from "./managedPublicLifecycleHarness"

import { afterEach, describe, expect, it, vi } from "vitest"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>

const fixtures: Harness[] = []
const budgets = [
	{ name: "input tokens", setting: "subagentMaxInputTokens", limit: 2, belowLimit: 3, reason: "input_token_limit" },
	{
		name: "output tokens",
		setting: "subagentMaxOutputTokens",
		limit: 3,
		belowLimit: 4,
		reason: "output_token_limit",
	},
	{ name: "root tokens", setting: "subagentRootTokenBudget", limit: 5, belowLimit: 6, reason: "root_token_budget" },
	{
		name: "root cost",
		setting: "subagentRootCostBudget",
		limit: 0.001,
		belowLimit: 0.002,
		reason: "root_cost_budget",
	},
] as const

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function createFixture() {
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3 })
	fixtures.push(fixture)
	return fixture
}

describe("AlphaProvider managed-agent budget thresholds", () => {
	it.each(budgets)("ignores a retired $name limit across provider requests", async (budget) => {
		const fixture = await createFixture()
		Object.assign(fixture.settings, { [budget.setting]: budget.limit })
		const child = await fixture.spawnChild("legacy_budget")
		child.turn.chunks = [{ type: "tool_call", id: "inspect_agents", name: "list_agents", arguments: "{}" }]
		const next = fixture.queueTurn(child.taskId, "The objective is complete.")
		const completed = fixture.runs.waitForResult(child.taskId)
		if (!completed) throw new Error("The child has no owned run completion")
		child.turn.release()
		try {
			const outcome = await Promise.race([
				next.entered.then(() => ({ nextRequest: true as const })),
				completed.then((result) => ({ nextRequest: false as const, result })),
			])
			expect(outcome.nextRequest).toBe(true)
		} finally {
			next.release()
			await completed
			await child.finalization
			await child.task.waitForTermination()
		}
		expect(await completed).toMatchObject({ status: "completed", stopReason: "completed" })
		expect(fixture.store.getAgent(child.taskId)?.status).toBe("completed")
	})

	it.each(budgets)("permits completion below the $name limit", async (budget) => {
		const fixture = await createFixture()
		Object.assign(fixture.settings, { [budget.setting]: budget.belowLimit })
		const child = await fixture.spawnCompletedChild("remaining_budget")

		expect(child.result).toMatchObject({ status: "completed", stopReason: "completed" })
		expect(fixture.store.getAgent(child.taskId)?.status).toBe("completed")
	})
})
