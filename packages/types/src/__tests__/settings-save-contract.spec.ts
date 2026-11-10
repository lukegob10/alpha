import { describe, expect, it } from "vitest"

import { settingsSaveRequestSchema, settingsSaveResultSchema } from "../settings-save.js"
import type { ExtensionMessage, WebviewMessage } from "../vscode-extension-host.js"

describe("settings Save wire compatibility", () => {
	it("retains legacy preference updates without requiring Save correlation", () => {
		const message = {
			type: "updateSettings",
			updatedSettings: { soundEnabled: false, soundVolume: 0 },
		} satisfies WebviewMessage

		expect(JSON.parse(JSON.stringify(message))).toEqual(message)
		expect(message).not.toHaveProperty("settingsSave")
	})

	it("round trips a correlated patch while retaining false, zero, and cleared limits", () => {
		const message = {
			type: "updateSettings",
			updatedSettings: {
				soundEnabled: false,
				soundVolume: 0,
				allowedMaxCost: null,
			},
			settingsSave: {
				requestId: "settings-save-1",
				expectedSettings: { soundEnabled: true, soundVolume: 0.5, allowedMaxCost: 2 },
			},
		} satisfies WebviewMessage
		const transported = JSON.parse(JSON.stringify(message))

		expect(settingsSaveRequestSchema.parse(transported.settingsSave)).toEqual(message.settingsSave)
		expect(transported.updatedSettings).toEqual(message.updatedSettings)
	})

	it("allows a newly configured preference to expect an absent prior value", () => {
		const request = { requestId: "new-preference", expectedSettings: { autoSteer: undefined } }

		expect(settingsSaveRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual({
			requestId: "new-preference",
			expectedSettings: {},
		})
	})

	it("keeps explicit host-setting changes separate from extension preference expectations", () => {
		const request = {
			requestId: "host-preference",
			expectedSettings: { soundEnabled: false },
			debug: { expected: false, value: true },
		}

		expect(settingsSaveRequestSchema.parse(request)).toEqual(request)
		expect(
			settingsSaveRequestSchema.safeParse({
				...request,
				debug: { expected: false, value: true, setting: "arbitrary.host.setting" },
			}).success,
		).toBe(false)
	})

	it("discards only the retired reporting expectation when an older settings editor saves", () => {
		const request = {
			requestId: "retired-reporting",
			expectedSettings: { telemetrySetting: "enabled", soundEnabled: false, soundVolume: 0 },
		}

		expect(settingsSaveRequestSchema.parse(request)).toEqual({
			requestId: request.requestId,
			expectedSettings: { soundEnabled: false, soundVolume: 0 },
		})
		expect(
			settingsSaveRequestSchema.safeParse({
				...request,
				expectedSettings: { ...request.expectedSettings, unknownPreference: true },
			}).success,
		).toBe(false)
	})

	it.each(["small", "large", null, { obsolete: true }])(
		"ignores retired preview expectations %j without accepting unrelated unknown keys",
		(terminalOutputPreviewSize) => {
			const request = {
				requestId: "retired-terminal-preview",
				expectedSettings: { terminalOutputPreviewSize, soundEnabled: false, soundVolume: 0 },
			}
			expect(settingsSaveRequestSchema.parse(request)).toEqual({
				requestId: request.requestId,
				expectedSettings: { soundEnabled: false, soundVolume: 0 },
			})
			expect(
				settingsSaveRequestSchema.safeParse({
					...request,
					expectedSettings: { ...request.expectedSettings, unknownPreference: true },
				}).success,
			).toBe(false)
		},
	)

	it.each([undefined, null, "", "x".repeat(129), 0])("rejects invalid Save correlation %j", (requestId) => {
		expect(settingsSaveRequestSchema.safeParse({ requestId, expectedSettings: {} }).success).toBe(false)
	})

	it.each([
		{ apiProvider: "openai" },
		{ openAiApiKey: "provider-secret" },
		{ unknownPreference: true },
		{ soundEnabled: "false" },
	])("rejects provider fields and invalid preference expectations %j", (expectedSettings) => {
		expect(settingsSaveRequestSchema.safeParse({ requestId: "settings-save", expectedSettings }).success).toBe(
			false,
		)
	})

	it("requires a success acknowledgement to contain only correlation and success", () => {
		const result = { requestId: "settings-save", status: "success" } as const
		const message = { type: "settingsSaved", settingsSaveResult: result } satisfies ExtensionMessage

		expect(settingsSaveResultSchema.parse(JSON.parse(JSON.stringify(message)).settingsSaveResult)).toEqual(result)
		expect(settingsSaveResultSchema.safeParse({ ...result, error: "saveFailed" }).success).toBe(false)
		expect(settingsSaveResultSchema.safeParse({ ...result, conflictingKeys: ["approvalMode"] }).success).toBe(false)
	})

	it("retains valid partial-save acknowledgements from older hosts while ignoring retired applied keys", () => {
		const result = Object.freeze({
			requestId: "old-partial-save",
			status: "error",
			error: "saveFailed",
			appliedKeys: Object.freeze(["terminalOutputPreviewSize", "soundEnabled", "telemetrySetting"]),
		})
		expect(settingsSaveResultSchema.parse(result)).toEqual({ ...result, appliedKeys: ["soundEnabled"] })
		expect(result.appliedKeys).toEqual(["terminalOutputPreviewSize", "soundEnabled", "telemetrySetting"])
		expect(
			settingsSaveResultSchema.safeParse({
				...result,
				appliedKeys: [...result.appliedKeys, "unknownPreference"],
			}).success,
		).toBe(false)
		expect(settingsSaveResultSchema.safeParse({ ...result, appliedKeys: [123] }).success).toBe(false)
	})

	it.each(["invalid", "conflict", "saveFailed"] as const)("preserves the correlated %s failure", (error) => {
		const result = {
			requestId: "settings-save",
			status: "error",
			error,
			...(error === "conflict" ? { conflictingKeys: ["approvalMode", "allowedCommands"] } : {}),
		} as const

		expect(settingsSaveResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
		expect(settingsSaveResultSchema.safeParse({ ...result, updatedSettings: { soundEnabled: true } }).success).toBe(
			false,
		)
	})

	it.each([
		{ requestId: "settings-save", status: "pending" },
		{ requestId: "settings-save", status: "error" },
		{ requestId: "settings-save", status: "error", error: "unknown" },
		{ requestId: "settings-save", status: "error", error: "conflict", conflictingKeys: [123] },
	])("rejects malformed or nonterminal acknowledgements %j", (result) => {
		expect(settingsSaveResultSchema.safeParse(result).success).toBe(false)
	})
})
