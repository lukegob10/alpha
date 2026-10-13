import { GLOBAL_STATE_KEYS, alphaCodeSettingsSchema, globalSettingsSchema } from "../global-settings.js"

describe("automatic steering settings", () => {
	it("registers the opt-in as persisted global state and preserves explicit choices", () => {
		expect(GLOBAL_STATE_KEYS).toContain("autoSteer")
		expect(globalSettingsSchema.parse({}).autoSteer).toBeUndefined()
		for (const autoSteer of [false, true]) {
			expect(globalSettingsSchema.parse({ autoSteer })).toEqual({ autoSteer })
			expect(alphaCodeSettingsSchema.parse({ autoSteer })).toEqual({ autoSteer })
		}
	})

	it.each(["true", "false", 1, null])("rejects a non-Boolean choice %s", (autoSteer) => {
		expect(globalSettingsSchema.safeParse({ autoSteer }).success).toBe(false)
	})
})
