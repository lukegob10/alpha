import { describe, expect, it } from "vitest"

import {
	providerProfileSaveIdSchema,
	providerProfileSaveRequestSchema,
	providerProfileSaveResultSchema,
} from "../provider-profile-save.js"
import type { ExtensionMessage, WebviewMessage } from "../vscode-extension-host.js"

describe("existing provider profile save identity", () => {
	it("preserves the exact persisted ID independently of profile names", () => {
		expect(providerProfileSaveIdSchema.parse("profile-id")).toBe("profile-id")
		expect(providerProfileSaveIdSchema.parse(" legacy-id ")).toBe(" legacy-id ")
	})

	it.each([undefined, null, "", 0, {}, { id: "profile-id" }])("rejects an invalid explicit ID: %j", (value) => {
		expect(providerProfileSaveIdSchema.safeParse(value).success).toBe(false)
	})

	it("allows modern existing-profile saves without a display-name lookup", () => {
		const message: WebviewMessage = {
			type: "upsertApiConfiguration",
			requestId: "save-request",
			apiConfigurationId: "profile-id",
			apiConfiguration: { apiProvider: "openai", openAiModelId: "draft-model" },
		}
		expect(message.apiConfigurationId).toBe("profile-id")
	})

	it("keeps a stale display name optional metadata for an ID-addressed save", () => {
		const message: WebviewMessage = {
			type: "upsertApiConfiguration",
			requestId: "save-request",
			apiConfigurationId: "profile-id",
			text: "old-name",
			apiConfiguration: { apiProvider: "openai", openAiModelId: "draft-model" },
		}
		expect(message.apiConfigurationId).toBe("profile-id")
		expect(message.text).toBe("old-name")
	})

	it("preserves name-based creation and legacy messages", () => {
		const message: WebviewMessage = {
			type: "upsertApiConfiguration",
			text: "new-profile",
			apiConfiguration: { apiProvider: "vscode-lm" },
		}
		expect("apiConfigurationId" in message).toBe(false)
	})

	it("validates the exact correlated request without accepting provider fields or name authority", () => {
		const request = { requestId: "save-request", id: "profile-id" }
		expect(providerProfileSaveRequestSchema.parse(request)).toEqual(request)
		expect(providerProfileSaveRequestSchema.safeParse({ ...request, name: "old-name" }).success).toBe(false)
		expect(providerProfileSaveRequestSchema.safeParse({ ...request, apiConfiguration: {} }).success).toBe(false)
	})

	it.each([undefined, "", "x".repeat(129), 0])("rejects invalid Save correlation %j", (requestId) => {
		expect(providerProfileSaveRequestSchema.safeParse({ requestId, id: "profile-id" }).success).toBe(false)
	})

	it("returns only the committed identity on success", () => {
		const result = { requestId: "save-request", status: "success", id: "profile-id", name: "renamed" } as const
		expect(providerProfileSaveResultSchema.parse(result)).toEqual(result)
		const message: ExtensionMessage = { type: "apiConfigurationSaved", apiConfigurationSaveResult: result }
		expect(message.apiConfigurationSaveResult).toEqual(result)
		expect(providerProfileSaveResultSchema.safeParse({ ...result, apiConfiguration: {} }).success).toBe(false)
	})

	it.each(["invalid", "notFound", "saveFailed"] as const)(
		"returns a bounded %s failure without provider data",
		(error) => {
			const result = { requestId: "save-request", status: "error", error } as const
			expect(providerProfileSaveResultSchema.parse(result)).toEqual(result)
			expect(providerProfileSaveResultSchema.safeParse({ ...result, apiKey: "secret" }).success).toBe(false)
		},
	)

	it("rejects malformed and unknown Save results", () => {
		expect(
			providerProfileSaveResultSchema.safeParse({ requestId: "save-request", status: "success" }).success,
		).toBe(false)
		expect(
			providerProfileSaveResultSchema.safeParse({ requestId: "save-request", status: "error", error: "unknown" })
				.success,
		).toBe(false)
		expect(
			providerProfileSaveResultSchema.safeParse({ requestId: "", status: "error", error: "saveFailed" }).success,
		).toBe(false)
	})
})
