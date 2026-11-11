import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "vscode"
import * as vscode from "vscode"
import type { GlobalSettings, WebviewMessage } from "@alpha-code/types"

import { ContextProxy } from "../../config/ContextProxy"
import type { AlphaProvider } from "../AlphaProvider"
import { handleSettingsUpdate } from "../settingsSaveHandler"

vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	ConfigurationTarget: { Global: 1 },
}))

function fixture(initial: GlobalSettings = {}) {
	const stored = new Map<string, unknown>(Object.entries(initial))
	const update = vi.fn(async (key: string, value: unknown) => {
		stored.set(key, value)
	})
	const proxy = new ContextProxy({
		globalState: { get: (key: string) => stored.get(key), update },
	} as unknown as ExtensionContext)
	const postMessageToWebview = vi.fn(async () => {})
	const provider = {
		contextProxy: proxy,
		getState: vi.fn(async () => ({
			soundEnabled: false,
			autoSteer: false,
			allowedCommands: ["git status", "inherited"],
			...initial,
			...Object.fromEntries(Object.entries(proxy.getValues()).filter(([, value]) => value !== undefined)),
		})),
		getLiveTaskIds: () => [],
		postStateToWebview: vi.fn(async () => {}),
		postMessageToWebview,
		log: vi.fn(),
	} as unknown as AlphaProvider
	return { provider, proxy, update, stored, postMessageToWebview }
}

function request(updatedSettings: GlobalSettings, expectedSettings: GlobalSettings = {}): WebviewMessage {
	return { type: "updateSettings", updatedSettings, settingsSave: { requestId: "save-1", expectedSettings } }
}

describe("correlated preference saves", () => {
	it("ignores a retired reporting key in an old uncorrelated settings payload", async () => {
		const test = fixture()
		await handleSettingsUpdate(test.provider, {
			type: "updateSettings",
			updatedSettings: { soundEnabled: true, telemetrySetting: "enabled" } as GlobalSettings,
		})
		expect(test.update).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
		expect(test.stored.has("telemetrySetting")).toBe(false)
	})

	it("saves current preferences from an old correlated payload without retaining reporting settings", async () => {
		const test = fixture()
		await handleSettingsUpdate(
			test.provider,
			request(
				{ soundEnabled: true, telemetrySetting: "enabled" } as GlobalSettings,
				{ soundEnabled: false, telemetrySetting: "unset" } as GlobalSettings,
			),
		)
		expect(test.update).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
		expect(test.stored.has("telemetrySetting")).toBe(false)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "success" },
		})
	})

	it.each(["small", "large", null])(
		"ignores an old uncorrelated preview value %j",
		async (terminalOutputPreviewSize) => {
			const test = fixture()
			test.stored.set("terminalOutputPreviewSize", "existing-value")
			await handleSettingsUpdate(test.provider, {
				type: "updateSettings",
				updatedSettings: { soundEnabled: true, terminalOutputPreviewSize } as GlobalSettings,
			})
			expect(test.update).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
			expect(test.stored.get("terminalOutputPreviewSize")).toBe("existing-value")
		},
	)

	it.each(["small", "large", null])(
		"ignores retired preview fields in correlated saves (%j)",
		async (terminalOutputPreviewSize) => {
			const test = fixture()
			test.stored.set("terminalOutputPreviewSize", "existing-value")
			await handleSettingsUpdate(
				test.provider,
				request(
					{ soundEnabled: true, terminalOutputPreviewSize } as GlobalSettings,
					{ soundEnabled: false, terminalOutputPreviewSize: "small" } as GlobalSettings,
				),
			)
			expect(test.update).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
			expect(test.stored.get("terminalOutputPreviewSize")).toBe("existing-value")
			expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "settingsSaved",
				settingsSaveResult: { requestId: "save-1", status: "success" },
			})
		},
	)

	it("still rejects an unrelated unknown key in a correlated settings payload", async () => {
		const test = fixture()
		await handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: true, unknownPreference: true } as GlobalSettings, { soundEnabled: false }),
		)
		expect(test.update).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "error", error: "invalid" },
		})
	})

	it("acknowledges completion only after preference persistence settles", async () => {
		const test = fixture()
		let release!: () => void
		let entered!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		test.update.mockImplementationOnce(async (key, value) => {
			entered()
			await blocked
			test.stored.set(key, value)
		})
		const pending = handleSettingsUpdate(test.provider, request({ soundEnabled: true }, { soundEnabled: false }))
		await started
		expect(test.postMessageToWebview).not.toHaveBeenCalled()
		release()
		await pending
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "success" },
		})
	})

	it("saves only the patch without overwriting an unrelated concurrent approval change", async () => {
		const test = fixture()
		await test.proxy.setValue("approvalMode", "ask")
		test.update.mockClear()
		await handleSettingsUpdate(test.provider, request({ soundEnabled: true }, { soundEnabled: false }))
		expect(test.proxy.getValue("approvalMode")).toBe("ask")
		expect(test.update).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "success" },
		})
	})

	it("rejects a stale edited preference before applying any part of its patch", async () => {
		const test = fixture()
		await test.proxy.setValue("soundVolume", 0.8)
		test.update.mockClear()
		await handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: true, soundVolume: 0.4 }, { soundEnabled: false, soundVolume: 0.5 }),
		)
		expect(test.update).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).toHaveBeenCalledWith({
			type: "settingsSaved",
			settingsSaveResult: {
				requestId: "save-1",
				status: "error",
				error: "conflict",
				conflictingKeys: ["soundVolume"],
			},
		})
	})

	it("checks command edits against the editable global list rather than inherited rules", async () => {
		const test = fixture()
		await handleSettingsUpdate(test.provider, request({ allowedCommands: ["git status"] }, { allowedCommands: [] }))
		expect(test.stored.get("allowedCommands")).toEqual(["git status"])
		expect(test.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ settingsSaveResult: { requestId: "save-1", status: "success" } }),
		)
	})

	it("reports persistence failure and restores the uncommitted cache value", async () => {
		const test = fixture()
		await test.proxy.setValue("soundEnabled", false)
		test.update.mockRejectedValueOnce(new Error("private storage error"))
		await handleSettingsUpdate(test.provider, request({ soundEnabled: true }, { soundEnabled: false }))
		expect(test.proxy.getValue("soundEnabled")).toBe(false)
		expect(test.stored.get("soundEnabled")).toBe(false)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "error", error: "saveFailed" },
		})
	})

	it("allows retry after a partial save when an earlier preference already has the desired value", async () => {
		const test = fixture()
		test.update.mockImplementation(async (key, value) => {
			if (key === "autoSteer") throw new Error("storage unavailable")
			test.stored.set(key, value)
		})
		const save = request({ soundEnabled: true, autoSteer: true }, { soundEnabled: false, autoSteer: false })
		await handleSettingsUpdate(test.provider, save)
		expect(test.stored.get("soundEnabled")).toBe(true)
		expect(test.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				settingsSaveResult: {
					requestId: "save-1",
					status: "error",
					error: "saveFailed",
					appliedKeys: ["soundEnabled"],
				},
			}),
		)
		test.update.mockImplementation(async (key, value) => {
			test.stored.set(key, value)
		})
		await handleSettingsUpdate(test.provider, save)
		expect(test.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({ settingsSaveResult: { requestId: "save-1", status: "success" } }),
		)
	})

	it("does not overwrite a concurrent edit made while another preference is persisting", async () => {
		const test = fixture()
		let release!: () => void
		let entered!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		test.update.mockImplementation(async (key, value) => {
			if (key === "soundEnabled") {
				entered()
				await blocked
			}
			test.stored.set(key, value)
		})
		const save = handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: true, soundVolume: 0.4 }, { soundEnabled: false }),
		)
		await started
		await test.proxy.setValue("soundVolume", 0.9)
		release()
		await save
		expect(test.stored.get("soundVolume")).toBe(0.9)
		expect(test.postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({
				settingsSaveResult: {
					requestId: "save-1",
					status: "error",
					error: "conflict",
					conflictingKeys: ["soundVolume"],
					appliedKeys: ["soundEnabled"],
				},
			}),
		)
	})

	it("can restore an original value after a partial save reports that preference as committed", async () => {
		const test = fixture()
		test.update.mockImplementation(async (key, value) => {
			if (key === "autoSteer") throw new Error("storage unavailable")
			test.stored.set(key, value)
		})
		await handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: true, autoSteer: true }, { soundEnabled: false, autoSteer: false }),
		)
		expect(test.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaved",
			settingsSaveResult: {
				requestId: "save-1",
				status: "error",
				error: "saveFailed",
				appliedKeys: ["soundEnabled"],
			},
		})
		test.update.mockImplementation(async (key, value) => {
			test.stored.set(key, value)
		})
		// The acknowledgement advances only sound's comparison baseline; reverting it must be an explicit patch.
		await handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: false, autoSteer: true }, { soundEnabled: true, autoSteer: false }),
		)
		expect(test.stored.get("soundEnabled")).toBe(false)
		expect(test.stored.get("autoSteer")).toBe(true)
		expect(test.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "success" },
		})
	})

	it("validates the complete modern patch before any write", async () => {
		const test = fixture()
		await handleSettingsUpdate(
			test.provider,
			request({ soundEnabled: true, memorySettings: { enabled: "invalid" } } as unknown as GlobalSettings),
		)
		expect(test.update).not.toHaveBeenCalled()
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: { requestId: "save-1", status: "error", error: "invalid" },
		})
	})

	it("includes host configuration failure in the correlated result and permits a safe retry", async () => {
		const test = fixture()
		const update = vi
			.fn()
			.mockRejectedValueOnce(new Error("host configuration unavailable"))
			.mockResolvedValue(undefined)
		const configuration = vi
			.spyOn(vscode.workspace, "getConfiguration")
			.mockReturnValue({ get: () => false, update } as unknown as vscode.WorkspaceConfiguration)
		const save = request({ soundEnabled: true }, { soundEnabled: false })
		save.settingsSave!.debug = { expected: false, value: true }
		try {
			await handleSettingsUpdate(test.provider, save)
			expect(test.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "settingsSaved",
				settingsSaveResult: {
					requestId: "save-1",
					status: "error",
					error: "saveFailed",
					appliedKeys: ["soundEnabled"],
				},
			})
			expect(test.stored.get("soundEnabled")).toBe(true)
			await handleSettingsUpdate(test.provider, save)
			expect(test.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "settingsSaved",
				settingsSaveResult: { requestId: "save-1", status: "success" },
			})
		} finally {
			configuration.mockRestore()
		}
	})

	it("reports a durable preference even when its runtime effect fails, and still acknowledges if refresh fails", async () => {
		const test = fixture({ mcpEnabled: false })
		Object.assign(test.provider, {
			getMcpHub: () => ({ handleMcpEnabledChange: vi.fn().mockRejectedValue(new Error("connection failure")) }),
		})
		vi.mocked(test.provider.postStateToWebview).mockRejectedValueOnce(new Error("transport failure"))
		await handleSettingsUpdate(test.provider, request({ mcpEnabled: true }, { mcpEnabled: false }))
		expect(test.stored.get("mcpEnabled")).toBe(true)
		expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "settingsSaved",
			settingsSaveResult: {
				requestId: "save-1",
				status: "error",
				error: "saveFailed",
				appliedKeys: ["mcpEnabled"],
			},
		})
	})

	it("reports committed debug configuration if a later state publication fails", async () => {
		const test = fixture()
		const update = vi.fn().mockResolvedValue(undefined)
		const configuration = vi
			.spyOn(vscode.workspace, "getConfiguration")
			.mockReturnValue({ get: () => false, update } as unknown as vscode.WorkspaceConfiguration)
		const save = request({})
		save.settingsSave!.debug = { expected: false, value: true }
		vi.mocked(test.provider.postStateToWebview).mockRejectedValueOnce(new Error("transport unavailable"))
		try {
			await handleSettingsUpdate(test.provider, save)
			expect(test.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
				type: "settingsSaved",
				settingsSaveResult: { requestId: "save-1", status: "error", error: "saveFailed", debugApplied: true },
			})
		} finally {
			configuration.mockRestore()
		}
	})
})
