import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { ProviderProfileUnavailableError } from "../../config/ProviderSettingsManager"
import i18next from "../../../i18n"
import common from "../../../i18n/locales/en/common.json"

const barrier = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("saved provider selection availability", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
		i18next.addResourceBundle("en", "common", common, true, true)
		vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
	})

	it.each(["loadApiConfiguration", "loadApiConfigurationById"] as const)(
		"%s reports invalid field names and returns the accepted profile without leaking error details",
		async (type) => {
			const error = new ProviderProfileUnavailableError("invalid", { id: "bad", name: "Saved" }, [
				"modelTemperature",
			])
			Object.assign(error, { privateConfiguration: "private endpoint and key" })
			const activate = vi.fn().mockRejectedValue(error)
			const refresh = vi.fn(async () => undefined)
			const log = vi.fn()
			const provider = {
				activateProviderProfile: activate,
				postStateToWebview: refresh,
				log,
			} as unknown as AlphaProvider

			await webviewMessageHandler(provider, { type, text: "Saved" })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
				expect.stringMatching(/invalid settings: modelTemperature/),
			)
			expect(refresh).toHaveBeenCalledOnce()
			expect(activate).toHaveBeenCalledOnce()
			expect(JSON.stringify(log.mock.calls)).not.toContain("private endpoint and key")
			expect(JSON.stringify(vi.mocked(vscode.window.showErrorMessage).mock.calls)).not.toContain(
				"private endpoint and key",
			)
		},
	)

	it.each(["loadApiConfiguration", "loadApiConfigurationById"] as const)(
		"%s gives an explicit unsupported-profile error without selecting a fallback",
		async (type) => {
			const activate = vi
				.fn()
				.mockRejectedValue(new ProviderProfileUnavailableError("unsupported", { id: "legacy", name: "Legacy" }))
			const refresh = vi.fn(async () => undefined)
			const provider = {
				activateProviderProfile: activate,
				postStateToWebview: refresh,
				log: vi.fn(),
			} as unknown as AlphaProvider

			await webviewMessageHandler(provider, { type, text: "Legacy" })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining("provider that this version does not support"),
			)
			expect(activate).toHaveBeenCalledExactlyOnceWith(
				type === "loadApiConfiguration" ? { name: "Legacy" } : { id: "Legacy" },
			)
			expect(refresh).toHaveBeenCalledOnce()
		},
	)

	it("does not log arbitrary error payloads on an unexpected selection failure", async () => {
		const log = vi.fn()
		const refresh = vi.fn(async () => undefined)
		const provider = {
			activateProviderProfile: vi.fn().mockRejectedValue(new Error("private endpoint and key")),
			postStateToWebview: refresh,
			log,
		} as unknown as AlphaProvider

		await webviewMessageHandler(provider, { type: "loadApiConfiguration", text: "Saved" })

		expect(refresh).toHaveBeenCalledOnce()
		expect(JSON.stringify(log.mock.calls)).not.toContain("private endpoint and key")
	})

	it("releases the accepted selection while its native error notification remains open", async () => {
		const notificationOpened = barrier()
		const notificationClosed = barrier()
		vi.mocked(vscode.window.showErrorMessage).mockImplementationOnce(() => {
			notificationOpened.resolve()
			return notificationClosed.promise.then(() => undefined)
		})
		const refresh = vi.fn(async () => undefined)
		const provider = {
			activateProviderProfile: vi
				.fn()
				.mockRejectedValue(new ProviderProfileUnavailableError("invalid", { id: "bad", name: "Saved" })),
			postStateToWebview: refresh,
			log: vi.fn(),
		} as unknown as AlphaProvider
		const pending = webviewMessageHandler(provider, { type: "loadApiConfigurationById", text: "Saved" })
		await notificationOpened.promise
		try {
			expect(refresh).toHaveBeenCalledOnce()
		} finally {
			notificationClosed.resolve()
			await pending
		}
	})

	it("does not expose unrecognized diagnostic field strings from a malformed availability error", async () => {
		const provider = {
			activateProviderProfile: vi
				.fn()
				.mockRejectedValue(
					new ProviderProfileUnavailableError("invalid", { id: "bad", name: "Saved" }, [
						"modelTemperature",
						"private endpoint and key",
					]),
				),
			postStateToWebview: vi.fn(async () => undefined),
			log: vi.fn(),
		} as unknown as AlphaProvider
		await webviewMessageHandler(provider, { type: "loadApiConfiguration", text: "Saved" })
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("modelTemperature, configuration"),
		)
		expect(JSON.stringify(vi.mocked(vscode.window.showErrorMessage).mock.calls)).not.toContain(
			"private endpoint and key",
		)
	})

	it("uses the pre-confirmation profile identity for shared durable deletion", async () => {
		const entered = barrier()
		let confirm!: (answer: string) => void
		const showConfirmation = <T extends string | vscode.MessageItem>(
			_message: string,
			_options: vscode.MessageOptions,
			...items: T[]
		): Promise<T | undefined> => {
			entered.resolve()
			return new Promise<T | undefined>((resolve) => {
				confirm = (answer) =>
					resolve(items.find((item) => (typeof item === "string" ? item : item.title) === answer))
			})
		}
		vi.spyOn(vscode.window, "showInformationMessage").mockImplementationOnce(showConfirmation)
		const original = { id: "old", name: "Saved", availability: "invalid" as const }
		const listConfig = vi.fn(async () => [original])
		const remove = vi.fn(async () => undefined)
		const provider = {
			providerSettingsManager: { listConfig },
			deleteProviderProfile: remove,
			log: vi.fn(),
		} as unknown as AlphaProvider
		const pending = webviewMessageHandler(provider, { type: "deleteApiConfiguration", text: "Saved" })
		await entered.promise
		listConfig.mockResolvedValue([{ ...original, id: "successor" }])
		confirm(common.answers.yes)
		await pending

		expect(remove).toHaveBeenCalledExactlyOnceWith(original)
	})
})
