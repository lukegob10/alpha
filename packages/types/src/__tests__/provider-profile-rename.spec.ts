import { describe, expect, it } from "vitest"

import { providerProfileRenameRequestSchema, providerProfileRenameResultSchema } from "../provider-profile-rename.js"
import type { WebviewMessage } from "../vscode-extension-host.js"

describe("provider profile rename contract", () => {
	it("identifies the persisted profile by stable ID and normalizes the display name", () => {
		expect(
			providerProfileRenameRequestSchema.parse({ requestId: "rename-1", id: "profile-1", newName: " Work " }),
		).toEqual({ requestId: "rename-1", id: "profile-1", newName: "Work" })
	})

	it.each([
		{ requestId: "", id: "profile-1", newName: "Work" },
		{ requestId: "rename-1", id: "", newName: "Work" },
		{ requestId: "rename-1", newName: "Work" },
		{ requestId: "rename-1", id: "profile-1", newName: "  " },
		{ requestId: "rename-1", id: "profile-1", newName: "Work", apiConfiguration: { apiKey: "draft" } },
	])("rejects malformed identity or provider edits in a rename payload", (payload) => {
		expect(providerProfileRenameRequestSchema.safeParse(payload).success).toBe(false)
	})

	it("preserves the legacy wire shape for older webviews", () => {
		const message: WebviewMessage = {
			type: "renameApiConfiguration",
			values: { oldName: "default", newName: "Work" },
			apiConfiguration: { apiProvider: "openai", openAiApiKey: "unsaved" },
		}
		expect(message.values).toEqual({ oldName: "default", newName: "Work" })
	})

	it("returns correlated success metadata without provider configuration", () => {
		expect(
			providerProfileRenameResultSchema.parse({
				requestId: "rename-1",
				status: "success",
				id: "profile-1",
				oldName: "default",
				newName: "Work",
			}),
		).toEqual({ requestId: "rename-1", status: "success", id: "profile-1", oldName: "default", newName: "Work" })
	})

	it.each(["invalid", "notFound", "nameInUse", "saveFailed"] as const)(
		"returns a bounded failure code: %s",
		(error) => {
			expect(
				providerProfileRenameResultSchema.safeParse({ requestId: "rename-1", status: "error", error }).success,
			).toBe(true)
		},
	)

	it("rejects ambiguous, uncorrelated, or secret-bearing results", () => {
		for (const result of [
			{ status: "error", error: "saveFailed" },
			{ requestId: "rename-1", status: "error", error: "unknown" },
			{ requestId: "rename-1", status: "success", id: "profile-1", newName: "Work" },
			{ requestId: "rename-1", status: "error", error: "saveFailed", apiKey: "secret" },
			{
				requestId: "rename-1",
				status: "error",
				error: "saveFailed",
				profile: { id: "profile-1", name: "default", apiKey: "secret" },
			},
		]) {
			expect(providerProfileRenameResultSchema.safeParse(result).success).toBe(false)
		}
	})

	it("allows a compensated failure to identify the persisted name without provider settings", () => {
		expect(
			providerProfileRenameResultSchema.parse({
				requestId: "rename-1",
				status: "error",
				error: "saveFailed",
				profile: { id: "profile-1", name: "default" },
			}),
		).toEqual({
			requestId: "rename-1",
			status: "error",
			error: "saveFailed",
			profile: { id: "profile-1", name: "default" },
		})
	})
})
