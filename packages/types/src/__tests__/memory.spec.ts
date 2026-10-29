import { describe, expect, it } from "vitest"

import { globalSettingsSchema } from "../global-settings.js"
import {
	DEFAULT_MEMORY_SETTINGS,
	memoryCitationSchema,
	memorySettingsSchema,
	taskMemoryStateSchema,
} from "../memory.js"

describe("memory settings", () => {
	it("round-trips bounded citation provenance and rejects unsafe locations or ranges", () => {
		const citation = {
			entries: [{ path: "rollout_summaries/source-1.md", lineStart: 2, lineEnd: 8, note: "evidence" }],
			rolloutIds: ["source-1"],
		}
		expect(memoryCitationSchema.parse(JSON.parse(JSON.stringify(citation)))).toEqual(citation)
		for (const path of [
			"../outside.md",
			"/private.md",
			"file:///private",
			"command:run",
			"rollout_summaries/a/b.md",
		]) {
			expect(
				memoryCitationSchema.safeParse({ ...citation, entries: [{ ...citation.entries[0], path }] }).success,
			).toBe(false)
		}
		expect(
			memoryCitationSchema.safeParse({ ...citation, entries: [{ ...citation.entries[0], lineEnd: 1 }] }).success,
		).toBe(false)
		expect(
			memoryCitationSchema.safeParse({ ...citation, rolloutIds: Array.from({ length: 129 }, () => "source") })
				.success,
		).toBe(false)
	})

	it("keeps the feature opt-in and reading independent from generation", () => {
		expect(memorySettingsSchema.parse({})).toEqual(DEFAULT_MEMORY_SETTINGS)
		expect(DEFAULT_MEMORY_SETTINGS).toMatchObject({
			enabled: false,
			useMemories: true,
			generateMemories: true,
			maxRolloutsPerStartup: 2,
			maxRolloutAgeDays: 10,
		})
		expect(memorySettingsSchema.parse({ enabled: true, useMemories: false })).toMatchObject({
			enabled: true,
			useMemories: false,
			generateMemories: true,
		})
		expect(globalSettingsSchema.parse({})).not.toHaveProperty("memorySettings")
	})

	it.each([
		["maxRolloutsPerStartup", 0],
		["maxRolloutsPerStartup", 129],
		["maxRolloutAgeDays", -1],
		["maxRolloutAgeDays", 91],
		["minRolloutIdleHours", 0],
		["minRolloutIdleHours", 49],
		["minRateLimitRemainingPercent", -1],
		["minRateLimitRemainingPercent", 101],
		["maxMemoriesForConsolidation", 0],
		["maxMemoriesForConsolidation", 4097],
		["maxUnusedDays", -1],
		["maxUnusedDays", 366],
		["maxUnusedDays", 1.5],
	])("rejects an invalid %s limit (%s)", (key, value) => {
		expect(memorySettingsSchema.safeParse({ [key]: value }).success).toBe(false)
	})

	it("allows disabled retention windows and validates provider model IDs", () => {
		expect(
			memorySettingsSchema.parse({ maxUnusedDays: 0, maxRolloutAgeDays: 0, extractModel: " model-id " }),
		).toMatchObject({ maxUnusedDays: 0, maxRolloutAgeDays: 0, extractModel: "model-id" })
		expect(memorySettingsSchema.safeParse({ extractModel: " " }).success).toBe(false)
		expect(memorySettingsSchema.safeParse({ consolidationModel: "m".repeat(257) }).success).toBe(false)
	})

	it("persists the per-conversation read snapshot and independent generation choice", () => {
		expect(taskMemoryStateSchema.parse({ version: "v2", useMemories: true, generateMemories: false })).toEqual({
			version: "v2",
			useMemories: true,
			generateMemories: false,
		})
		expect(
			taskMemoryStateSchema.safeParse({ version: "v1", useMemories: true, generateMemories: true }).success,
		).toBe(false)
	})
})
