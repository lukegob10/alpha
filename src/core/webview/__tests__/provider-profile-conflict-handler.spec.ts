import type { WebviewMessage } from "@alpha-code/types"

import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { ProviderProfileSaveError } from "../../config/ProviderSettingsManager"

describe("provider profile content precondition messages", () => {
	const version = `sha256:${"a".repeat(64)}`
	const committedVersion = `sha256:${"b".repeat(64)}`
	const config = { apiProvider: "openai" as const, openAiModelId: "draft" }
	const fixture = () => {
		const upsertProviderProfile = vi
			.fn()
			.mockResolvedValue({ id: "profile-id", name: "renamed", version: committedVersion })
		const createProviderProfile = vi
			.fn()
			.mockResolvedValue({ id: "new-id", name: "new", version: committedVersion })
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const log = vi.fn()
		const provider = {
			upsertProviderProfile,
			createProviderProfile,
			postMessageToWebview,
			postStateToWebview,
			log,
		} as unknown as AlphaProvider
		return { provider, upsertProviderProfile, createProviderProfile, postMessageToWebview, postStateToWebview, log }
	}

	it("refreshes full state on the read-only Settings request without creating or saving a profile", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, { type: "requestState" })
		expect(test.postStateToWebview).toHaveBeenCalledOnce()
		expect(test.upsertProviderProfile).not.toHaveBeenCalled()
		expect(test.createProviderProfile).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("passes the expected version with the saved identity and acknowledges the committed content version", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "save",
			apiConfigurationId: "profile-id",
			apiConfigurationExpectedVersion: version,
			text: "stale-name",
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).toHaveBeenCalledExactlyOnceWith(
			{ id: "profile-id", expectedVersion: version },
			config,
		)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: {
				requestId: "save",
				status: "success",
				id: "profile-id",
				name: "renamed",
				version: committedVersion,
			},
		})
	})

	it("returns one correlated conflict without provider data or another write", async () => {
		const test = fixture()
		test.upsertProviderProfile.mockRejectedValueOnce(new ProviderProfileSaveError("conflict"))
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "save",
			apiConfigurationId: "profile-id",
			apiConfigurationExpectedVersion: version,
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).toHaveBeenCalledOnce()
		expect(test.postStateToWebview).toHaveBeenCalledOnce()
		expect(test.postStateToWebview.mock.invocationCallOrder[0]).toBeLessThan(
			test.postMessageToWebview.mock.invocationCallOrder[0],
		)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "save", status: "error", error: "conflict" },
		})
		expect(JSON.stringify(test.log.mock.calls)).not.toContain("draft")
	})

	it("retains the chosen conflict outcome when its fresh projection cannot be delivered", async () => {
		const test = fixture()
		test.upsertProviderProfile.mockRejectedValueOnce(new ProviderProfileSaveError("conflict"))
		test.postStateToWebview.mockRejectedValueOnce(new Error("detached view"))
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "save",
			apiConfigurationId: "profile-id",
			apiConfigurationExpectedVersion: version,
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).toHaveBeenCalledOnce()
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "save", status: "error", error: "conflict" },
		})
	})

	it.each(["create", "update"] as const)(
		"forwards a committed %s receipt when application fails",
		async (operation) => {
			const test = fixture()
			const saved = { id: "profile-id", name: "saved", version: committedVersion }
			const method = operation === "create" ? test.createProviderProfile : test.upsertProviderProfile
			method.mockRejectedValueOnce(new ProviderProfileSaveError("applyFailed", saved))
			await webviewMessageHandler(test.provider, {
				type: "upsertApiConfiguration",
				requestId: "save",
				text: "saved",
				apiConfiguration: config,
				...(operation === "update"
					? { apiConfigurationId: saved.id, apiConfigurationExpectedVersion: version }
					: { apiConfigurationReturnVersion: true as const }),
			})
			expect(method).toHaveBeenCalledOnce()
			expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "save", status: "error", error: "applyFailed", saved },
			})
		},
	)

	it.each(["", "malformed", null, 12])(
		"rejects malformed explicit precondition %j before writing",
		async (expectedVersion) => {
			const test = fixture()
			await webviewMessageHandler(test.provider, {
				type: "upsertApiConfiguration",
				requestId: "save",
				apiConfigurationId: "profile-id",
				apiConfigurationExpectedVersion: expectedVersion,
				apiConfiguration: config,
			} as unknown as WebviewMessage)
			expect(test.upsertProviderProfile).not.toHaveBeenCalled()
			expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "save", status: "error", error: "invalid" },
			})
		},
	)

	it("includes the atomic content version on modern creation receipts", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "create",
			apiConfigurationReturnVersion: true,
			text: "new",
			apiConfiguration: config,
		})
		expect(test.createProviderProfile).toHaveBeenCalledExactlyOnceWith("new", config)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: {
				requestId: "create",
				status: "success",
				id: "new-id",
				name: "new",
				version: committedVersion,
			},
		})
	})

	it("keeps historical saved-profile requests without a precondition compatible", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "legacy",
			apiConfigurationId: "profile-id",
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).toHaveBeenCalledExactlyOnceWith({ id: "profile-id" }, config)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "legacy", status: "success", id: "profile-id", name: "renamed" },
		})
	})

	it("keeps historical creation success receipts strict and version-free", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "create",
			text: "new",
			apiConfiguration: config,
		})
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "create", status: "success", id: "new-id", name: "new" },
		})
	})

	it.each(["create", "update"] as const)(
		"returns legacy saveFailed without a new receipt for unaware %s callers",
		async (operation) => {
			const test = fixture()
			const method = operation === "create" ? test.createProviderProfile : test.upsertProviderProfile
			method.mockRejectedValueOnce(
				new ProviderProfileSaveError("applyFailed", {
					id: "profile-id",
					name: "saved",
					version: committedVersion,
				}),
			)
			await webviewMessageHandler(test.provider, {
				type: "upsertApiConfiguration",
				requestId: "legacy",
				text: "saved",
				apiConfiguration: config,
				...(operation === "update" ? { apiConfigurationId: "profile-id" } : {}),
			})
			expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "apiConfigurationSaved",
				apiConfigurationSaveResult: { requestId: "legacy", status: "error", error: "saveFailed" },
			})
		},
	)

	it("never routes a capability-only malformed request through legacy name-based upsert", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			text: "saved",
			apiConfigurationReturnVersion: true,
			apiConfiguration: config,
		} as unknown as WebviewMessage)
		expect(test.upsertProviderProfile).not.toHaveBeenCalled()
		expect(test.createProviderProfile).not.toHaveBeenCalled()
	})

	it("maps a concurrent legacy creation conflict to an error understood by old strict consumers", async () => {
		const test = fixture()
		test.createProviderProfile.mockRejectedValueOnce(new ProviderProfileSaveError("conflict"))
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "create",
			text: "new",
			apiConfiguration: config,
		})
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "create", status: "error", error: "saveFailed" },
		})
	})

	it("never routes a precondition-only malformed request through legacy name-based upsert", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			text: "existing-name",
			apiConfigurationExpectedVersion: version,
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).not.toHaveBeenCalled()
		expect(test.createProviderProfile).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("rejects a create request carrying an existing-profile precondition", async () => {
		const test = fixture()
		await webviewMessageHandler(test.provider, {
			type: "upsertApiConfiguration",
			requestId: "create",
			text: "new",
			apiConfigurationExpectedVersion: version,
			apiConfiguration: config,
		})
		expect(test.upsertProviderProfile).not.toHaveBeenCalled()
		expect(test.createProviderProfile).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "apiConfigurationSaved",
			apiConfigurationSaveResult: { requestId: "create", status: "error", error: "invalid" },
		})
	})
})
