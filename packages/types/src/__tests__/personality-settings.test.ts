import {
	GLOBAL_STATE_KEYS,
	alphaCodeSettingsSchema,
	globalSettingsSchema,
	personalitySchema,
} from "../global-settings.js"

describe("built-in personality settings", () => {
	it("registers the preference as global state without changing older saved settings", () => {
		expect(GLOBAL_STATE_KEYS).toContain("personality")
		expect(globalSettingsSchema.parse({}).personality).toBeUndefined()
		expect(alphaCodeSettingsSchema.parse({}).personality).toBeUndefined()
	})

	it.each(["default", "none"] as const)("preserves the explicit %s choice", (personality) => {
		expect(personalitySchema.parse(personality)).toBe(personality)
		expect(globalSettingsSchema.parse({ personality })).toEqual({ personality })
		expect(alphaCodeSettingsSchema.parse({ personality })).toEqual({ personality })
	})

	it.each(["pragmatic", "friendly", "", true, 1, null, {}])("rejects an unsupported choice %j", (personality) => {
		expect(globalSettingsSchema.safeParse({ personality }).success).toBe(false)
		expect(alphaCodeSettingsSchema.safeParse({ personality }).success).toBe(false)
	})
})
