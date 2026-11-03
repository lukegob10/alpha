import { strict as assert } from "node:assert"
import { test } from "node:test"
import { isSecretStateKey, type AlphaCodeSettings, type TaskReasoningProjection } from "@alpha-code/types"

import { assertLiveTaskEffort, captureLiveFixtureSettings } from "../suite/live-provider-settings"
import { withFixtureCleanup } from "../suite/proportional-context-support"
import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"

for (const outcome of ["completed", "failed", "cancelled"] as const) {
	test(`saved-provider credentials survive fixture ${outcome} without a profile rewrite`, async () => {
		const savedProfile = {
			apiProvider: "anthropic" as const,
			apiModelId: "fixture-model",
			apiKey: "dummy-profile-key",
			reasoningEffort: "high" as const,
		}
		const savedBefore = structuredClone(savedProfile)
		const state: AlphaCodeSettings = {
			...savedProfile,
			currentApiConfigName: "saved-profile",
			mode: "architect",
			approvalMode: "ask",
			alwaysAllowExecute: false,
			allowedCommands: ["git status"],
		}
		// The public API uses this secret-key filter; its view is intentionally insufficient for dispatch.
		const publicView = Object.fromEntries(Object.entries(state).filter(([key]) => !isSecretStateKey(key)))
		assert.equal(publicView.apiKey, undefined)
		const writes: AlphaCodeSettings[] = []
		const host = {
			getValues: () => ({ ...state }),
			async setValues(values: AlphaCodeSettings) {
				writes.push(values)
				Object.assign(state, values)
			},
		}
		const fixture = captureLiveFixtureSettings(host, {
			mode: "code",
			approvalMode: "auto",
			alwaysAllowExecute: true,
			allowedCommands: ["rg"],
			allowedMaxRequests: 8,
		})
		assert.equal(fixture.configuration.apiKey, "dummy-profile-key")
		assert.equal(
			fixture.configuration.currentApiConfigName,
			undefined,
			"Task overrides cannot activate or save a profile",
		)
		const operation = withFixtureCleanup(async () => {
			await host.setValues(fixture.configuration)
			assert.equal(
				state.apiKey,
				"dummy-profile-key",
				"The real adapter receives the full cached provider snapshot",
			)
			state.lastShownAnnouncementId = "unrelated-task-update"
			if (outcome !== "completed") throw new Error(outcome)
		}, [fixture.restore])
		if (outcome === "completed") await operation
		else await assert.rejects(operation, new RegExp(outcome))
		assert.deepEqual(savedProfile, savedBefore)
		assert.equal(state.apiKey, "dummy-profile-key")
		assert.equal(state.mode, "architect")
		assert.equal(state.approvalMode, "ask")
		assert.equal(state.alwaysAllowExecute, false)
		assert.deepEqual(state.allowedCommands, ["git status"])
		assert.equal(state.allowedMaxRequests, undefined)
		assert.equal(
			state.lastShownAnnouncementId,
			"unrelated-task-update",
			"Restore only the fixture's changed settings",
		)
		assert.deepEqual(Object.keys(writes.at(-1)!).sort(), [
			"allowedCommands",
			"allowedMaxRequests",
			"alwaysAllowExecute",
			"approvalMode",
			"mode",
		])
	})
}

const reasoning = (effort: "high" | "low"): TaskReasoningProjection => ({
	requested: { kind: "effort", effort },
	effective: { kind: "effort", effort },
	capabilities: { kind: "effort", efforts: ["low", "high"], canDisable: true },
})

test("generic dispatch rejects an effective task effort that differs from the saved profile before sending", async () => {
	let sends = 0
	let state = reasoning("low")
	const task = {
		getReasoningState: () => state,
		api: {
			getModel: () => ({ id: "fixture-model" }),
			async *createMessage() {
				sends++
				yield "answer"
			},
		},
	}
	const budget = new WorkflowRequestBudget(3, "fixture-model")
	budget.onTaskRequest = () => {
		budget.model.reasoningEffort = assertLiveTaskEffort(task.getReasoningState(), "high")
	}
	const restore = guardTaskApi(task, budget, "generic")
	try {
		await assert.rejects(task.api.createMessage().next(), /Canonical task reasoning effort/)
		assert.equal(sends, 0)
		assert.equal(budget.used, 0)
		state = { ...reasoning("high"), current: reasoning("low") }
		await assert.rejects(task.api.createMessage().next(), /Canonical task reasoning effort/)
		assert.equal(sends, 0, "The active step's effective state takes precedence over a pending task preference")
		state = reasoning("high")
		assert.deepEqual(await task.api.createMessage().next(), { value: "answer", done: false })
		assert.equal(budget.model.reasoningEffort, "high")
		assert.equal(sends, 1)
		assert.equal(budget.used, 1)
	} finally {
		restore()
	}
})

test("canonical effort evidence distinguishes disabled, custom and unsupported reasoning", () => {
	assert.equal(assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "off" } }, "disable"), "disable")
	assert.equal(assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "off" } }, "off"), "off")
	assert.equal(assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "on" } }, "on"), "on")
	assert.equal(assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "default" } }, "default"), "default")
	assert.equal(
		assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "effort", effort: "none" } }, "none"),
		"none",
	)
	assert.equal(
		assertLiveTaskEffort(
			{ ...reasoning("high"), effective: { kind: "custom", value: "provider-effort" } },
			"provider-effort",
		),
		"provider-effort",
	)
	assert.throws(() => assertLiveTaskEffort({ ...reasoning("high"), effective: { kind: "default" } }, "high"))
	assert.throws(() => assertLiveTaskEffort(reasoning("high"), undefined))
})
