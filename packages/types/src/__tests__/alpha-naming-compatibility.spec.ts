import { describe, expect, expectTypeOf, test } from "vitest"

import {
	AlphaCodeEventName,
	RooCodeEventName,
	alphaAsks,
	alphaAskSchema,
	alphaCodeEventsSchema,
	alphaCodeSettingsSchema,
	alphaCodeTelemetryEventSchema,
	alphaMessageSchema,
	alphaSaySchema,
	alphaSays,
	clineAsks,
	clineAskSchema,
	clineMessageSchema,
	clineSaySchema,
	clineSays,
	rooCodeEventsSchema,
	rooCodeSettingsSchema,
	rooCodeTelemetryEventSchema,
} from "../index.js"
import type {
	AlphaCodeAPI,
	AlphaCodeEvents,
	AlphaCodeSettings,
	AlphaMessage,
	ClineMessage,
	ExtensionMessage,
	ExtensionState,
	RooCodeAPI,
	RooCodeEvents,
	RooCodeSettings,
} from "../index.js"

describe("public Alpha naming compatibility", () => {
	test("keeps legacy runtime exports identical to their Alpha exports", () => {
		expect(RooCodeEventName).toBe(AlphaCodeEventName)
		expect(rooCodeEventsSchema).toBe(alphaCodeEventsSchema)
		expect(rooCodeSettingsSchema).toBe(alphaCodeSettingsSchema)
		expect(rooCodeTelemetryEventSchema).toBe(alphaCodeTelemetryEventSchema)
		expect(clineAsks).toBe(alphaAsks)
		expect(clineAskSchema).toBe(alphaAskSchema)
		expect(clineSays).toBe(alphaSays)
		expect(clineSaySchema).toBe(alphaSaySchema)
		expect(clineMessageSchema).toBe(alphaMessageSchema)
	})

	test("preserves representative event and message wire values", () => {
		expect(AlphaCodeEventName.TaskCreated).toBe("taskCreated")
		expect(RooCodeEventName.TaskDelegated).toBe("taskDelegated")
		expect(AlphaCodeEventName.EvalPass).toBe("evalPass")
		expect(clineAskSchema.parse("completion_result")).toBe("completion_result")
		expect(clineSaySchema.parse("rooignore_error")).toBe("rooignore_error")

		const message = {
			ts: 1,
			type: "say" as const,
			say: "rooignore_error" as const,
			text: "legacy ignore error",
		}

		expect(alphaMessageSchema.parse(message)).toEqual(message)
		expect(clineMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
	})

	test("keeps legacy serialized message and settings keys intact", () => {
		const message: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "rooignore_error",
			text: "legacy ignore error",
		}
		type LegacyExtensionMessageFields = Pick<ExtensionMessage, "clineMessage" | "clineMessagesSeq">
		type LegacyExtensionStateFields = Pick<
			ExtensionState,
			"clineMessages" | "clineMessagesSeq" | "showRooIgnoredFiles"
		>

		expectTypeOf<LegacyExtensionMessageFields>().toEqualTypeOf<{
			clineMessage?: AlphaMessage
			clineMessagesSeq?: number
		}>()
		expectTypeOf<LegacyExtensionStateFields>().toEqualTypeOf<{
			clineMessages: AlphaMessage[]
			clineMessagesSeq?: number
			showRooIgnoredFiles: boolean
		}>()

		expect(alphaMessageSchema.array().parse([message])).toEqual([message])
		expect(alphaCodeSettingsSchema.parse({ showRooIgnoredFiles: true })).toEqual({ showRooIgnoredFiles: true })
		expect(rooCodeSettingsSchema.parse({ showRooIgnoredFiles: true })).toEqual({ showRooIgnoredFiles: true })
	})

	test("keeps old and new public type names equivalent", () => {
		expectTypeOf<AlphaCodeAPI>().toEqualTypeOf<RooCodeAPI>()
		expectTypeOf<AlphaCodeEvents>().toEqualTypeOf<RooCodeEvents>()
		expectTypeOf<AlphaMessage>().toEqualTypeOf<ClineMessage>()
		expectTypeOf<AlphaCodeSettings>().toEqualTypeOf<RooCodeSettings>()
	})
})
