import { describe, expect, expectTypeOf, test } from "vitest"

import {
	AlphaCodeEventName,
	alphaAsks,
	alphaAskSchema,
	alphaCodeEventsSchema,
	alphaCodeSettingsSchema,
	alphaMessageSchema,
	alphaSaySchema,
	alphaSays,
} from "../index.js"
import type {
	AlphaCodeAPI,
	AlphaCodeEvents,
	AlphaCodeSettings,
	AlphaMessage,
	ExtensionMessage,
	ExtensionState,
} from "../index.js"

describe("public Alpha naming", () => {
	test("exports matching Alpha message discriminators and schemas", () => {
		expect(alphaAskSchema.options).toEqual(alphaAsks)
		expect(alphaSaySchema.options).toEqual(alphaSays)
		expect(alphaAskSchema.parse("completion_result")).toBe("completion_result")
		expect(alphaSaySchema.parse("alphaignore_error")).toBe("alphaignore_error")
		expect(alphaSaySchema.safeParse("unknown-say").success).toBe(false)
	})

	test("preserves event values and validates their payloads", () => {
		expect(AlphaCodeEventName.TaskCreated).toBe("taskCreated")
		expect(AlphaCodeEventName.TaskDelegated).toBe("taskDelegated")
		expect(AlphaCodeEventName.EvalPass).toBe("evalPass")
		expect(alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskCreated].parse(["task-1"])).toEqual(["task-1"])
		expect(
			alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskDelegated].parse(["parent-task", "child-task"]),
		).toEqual(["parent-task", "child-task"])
		expect(alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskCreated].safeParse([]).success).toBe(false)
	})

	test("serializes Alpha messages, message sequence fields, and settings", () => {
		const message: AlphaMessage = {
			ts: 1,
			type: "say",
			say: "alphaignore_error",
			text: "ignore error",
		}
		type AlphaExtensionMessageFields = Pick<ExtensionMessage, "alphaMessage" | "alphaMessagesSeq">
		type AlphaExtensionStateFields = Pick<
			ExtensionState,
			"alphaMessages" | "alphaMessagesSeq" | "showAlphaIgnoredFiles"
		>

		expectTypeOf<AlphaExtensionMessageFields>().toEqualTypeOf<{
			alphaMessage?: AlphaMessage
			alphaMessagesSeq?: number
		}>()
		expectTypeOf<AlphaExtensionStateFields>().toEqualTypeOf<{
			alphaMessages: AlphaMessage[]
			alphaMessagesSeq?: number
			showAlphaIgnoredFiles: boolean
		}>()

		const update: AlphaExtensionMessageFields = { alphaMessage: message, alphaMessagesSeq: 2 }
		expect(alphaMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
		expect(alphaMessageSchema.array().parse([message])).toEqual([message])
		expect(JSON.parse(JSON.stringify(update))).toEqual({ alphaMessage: message, alphaMessagesSeq: 2 })
		expect(alphaCodeSettingsSchema.parse({ showAlphaIgnoredFiles: true })).toEqual({ showAlphaIgnoredFiles: true })
		expect(alphaCodeSettingsSchema.safeParse({ showAlphaIgnoredFiles: "true" }).success).toBe(false)
	})

	test("exposes Alpha API configuration and event types", () => {
		expectTypeOf<ReturnType<AlphaCodeAPI["getConfiguration"]>>().toEqualTypeOf<AlphaCodeSettings>()
		expectTypeOf<Parameters<AlphaCodeAPI["setConfiguration"]>[0]>().toEqualTypeOf<AlphaCodeSettings>()
		expectTypeOf<AlphaCodeEvents[AlphaCodeEventName.TaskCreated]>().toEqualTypeOf<[string]>()
	})
})
