import type { GlobalSettings } from "@alpha-code/types"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import {
	acknowledgeSettingsSave,
	applyAcknowledgedSettings,
	createSettingsPatch,
	createSettingsSaveProgress,
	getEditableSettingsState,
	getSettingsSavePayload,
	getSettingsSaveStatus,
} from "../settingsSave"

const emptyState = {} as ExtensionStateContextType

describe("settings edit baseline", () => {
	it("edits stored command rules without copying inherited workspace grants", () => {
		const state = {
			...emptyState,
			allowedCommands: ["git status", "workspace-only-script"],
			deniedCommands: ["workspace-denied-script"],
			commandRuleSettings: {
				allowedCommands: ["git status"],
				deniedCommands: [],
				inherited: [
					{
						source: "workspace" as const,
						allowedCommands: ["workspace-only-script"],
						deniedCommands: ["workspace-denied-script"],
					},
				],
			},
		}
		const editBuffer = getEditableSettingsState(state)
		expect(editBuffer.allowedCommands).toEqual(["git status"])
		expect(editBuffer.deniedCommands).toEqual([])
		editBuffer.allowedCommands.push("git diff")
		expect(state.commandRuleSettings.allowedCommands).toEqual(["git status"])
		expect(getSettingsSavePayload(editBuffer).allowedCommands).toEqual(["git status", "git diff"])
	})

	it("accepts older snapshots without command-rule source metadata", () => {
		const state = { ...emptyState, allowedCommands: ["git status"], deniedCommands: ["rm"] }
		expect(getEditableSettingsState(state)).toMatchObject({
			allowedCommands: ["git status"],
			deniedCommands: ["rm"],
		})
	})

	it("does not write defaulted or clamped fields after an unrelated preference edit", () => {
		const baseline = getEditableSettingsState({
			...emptyState,
			maxWorkspaceFiles: 450,
			subagentInterruptMessage: false,
			terminalShellIntegrationDisabled: false,
		})
		const original = getSettingsSavePayload(baseline)
		expect(original).toMatchObject({
			soundEnabled: false,
			enableCheckpoints: true,
			showAlphaIgnoredFiles: false,
			maxWorkspaceFiles: 200,
			subagentInterruptMessage: false,
			memorySettings: { enabled: false },
		})
		expect(createSettingsPatch(original, getSettingsSavePayload({ ...baseline, soundVolume: 0.25 }))).toEqual({
			updatedSettings: { soundVolume: 0.25 },
			expectedSettings: { soundVolume: 0.5 },
		})
	})

	it("keeps legacy terminal preferences out of the form payload without changing saved overrides", () => {
		const terminalPreferences = {
			terminalOutputPreviewSize: "large",
			terminalShellIntegrationDisabled: false,
			terminalShellIntegrationTimeout: 12_000,
			terminalCommandDelay: 120,
			terminalPowershellCounter: true,
			terminalZshClearEolMark: false,
			terminalZshOhMy: true,
			terminalZshP10k: true,
			terminalZdotdir: true,
		} as const
		const saved = { ...emptyState, ...terminalPreferences }
		const baseline = getEditableSettingsState(saved)
		const original = getSettingsSavePayload(baseline)
		const draft = {
			...baseline,
			terminalOutputPreviewSize: "small" as const,
			terminalCommandDelay: 0,
			soundVolume: 0.25,
		}
		const payload = getSettingsSavePayload(draft)
		for (const key of Object.keys(terminalPreferences)) {
			expect(original).not.toHaveProperty(key)
			expect(payload).not.toHaveProperty(key)
		}
		expect(createSettingsPatch(original, payload)).toEqual({
			updatedSettings: { soundVolume: 0.25 },
			expectedSettings: { soundVolume: 0.5 },
		})
		expect(saved).toMatchObject(terminalPreferences)
	})

	it("omits anonymous reporting from payloads even when an older snapshot retains its preference", () => {
		const legacySnapshot = { ...emptyState, telemetrySetting: "enabled" as const, soundEnabled: false }
		const baseline = getEditableSettingsState(legacySnapshot)
		const original = getSettingsSavePayload(baseline)
		const legacyDraft = { ...baseline, soundEnabled: true, telemetrySetting: "disabled" as const }
		const draft = getSettingsSavePayload(legacyDraft)
		expect(original).not.toHaveProperty("telemetrySetting")
		expect(draft).not.toHaveProperty("telemetrySetting")
		expect(createSettingsPatch(original, draft)).toEqual({
			updatedSettings: { soundEnabled: true },
			expectedSettings: { soundEnabled: false },
		})
	})
})

describe("settings save patch", () => {
	it("does not replay stale permission preferences when only sound changed", () => {
		const baseline: GlobalSettings = {
			approvalMode: "auto",
			allowedCommands: ["git status"],
			soundVolume: 0.5,
		}
		const patch = createSettingsPatch(baseline, { ...baseline, soundVolume: 0.75 })
		expect(patch).toEqual({ updatedSettings: { soundVolume: 0.75 }, expectedSettings: { soundVolume: 0.5 } })
		// A concurrent permission change survives applying this editor's unrelated patch.
		expect({ ...baseline, approvalMode: "ask", ...patch.updatedSettings }.approvalMode).toBe("ask")
	})

	it("includes exactly the edited nested preference and its baseline", () => {
		const baseline: GlobalSettings = {
			customSupportPrompts: { CONDENSE: "original", ENHANCE: "unchanged" },
			soundEnabled: false,
		}
		expect(
			createSettingsPatch(baseline, {
				...baseline,
				customSupportPrompts: { CONDENSE: "edited", ENHANCE: "unchanged" },
			}),
		).toEqual({
			updatedSettings: { customSupportPrompts: { CONDENSE: "edited", ENHANCE: "unchanged" } },
			expectedSettings: { customSupportPrompts: { CONDENSE: "original", ENHANCE: "unchanged" } },
		})
	})

	it("does not treat object-key ordering or equivalent copied arrays as edits", () => {
		expect(
			createSettingsPatch(
				{ customSupportPrompts: { CONDENSE: "a", ENHANCE: "b" }, allowedCommands: ["git status"] },
				{ customSupportPrompts: { ENHANCE: "b", CONDENSE: "a" }, allowedCommands: ["git status"] },
			),
		).toEqual({ updatedSettings: {}, expectedSettings: {} })
	})

	it("keeps nullable clears and absent baselines meaningful across JSON serialization", () => {
		const baseline: GlobalSettings = { allowedMaxRequests: 10 }
		expect(
			JSON.parse(JSON.stringify(createSettingsPatch(baseline, { allowedMaxRequests: null, autoSteer: true }))),
		).toEqual({
			updatedSettings: { allowedMaxRequests: null, autoSteer: true },
			expectedSettings: { allowedMaxRequests: 10 },
		})
	})

	it("compares effective values without losing an older host value needed for conflict detection", () => {
		expect(
			createSettingsPatch(
				{ maxWorkspaceFiles: 200, subagentDefaultModel: "" },
				{ maxWorkspaceFiles: 199, subagentDefaultModel: "model-1" },
				{ maxWorkspaceFiles: 450 },
			),
		).toEqual({
			updatedSettings: { maxWorkspaceFiles: 199, subagentDefaultModel: "model-1" },
			expectedSettings: { maxWorkspaceFiles: 450 },
		})
	})

	it("does not claim an undefined value can clear a field through the JSON wire format", () => {
		expect(createSettingsPatch({ soundEnabled: true }, { soundEnabled: undefined })).toEqual({
			updatedSettings: {},
			expectedSettings: {},
		})
	})

	it("can revert a preference that persisted before another preference failed to save", () => {
		const original: GlobalSettings = { soundEnabled: false, autoSteer: false, maxWorkspaceFiles: 450 }
		const submitted = createSettingsPatch(original, { ...original, soundEnabled: true, autoSteer: true })
		const acknowledged = applyAcknowledgedSettings(original, submitted.updatedSettings, ["soundEnabled"])
		expect(acknowledged).toEqual({ soundEnabled: true, autoSteer: false, maxWorkspaceFiles: 450 })
		// Reverting the local draft must undo the successful write, even though the overall save failed.
		expect(createSettingsPatch(acknowledged, original)).toEqual({
			updatedSettings: { soundEnabled: false },
			expectedSettings: { soundEnabled: true },
		})
		expect(original.soundEnabled).toBe(false)
	})

	it("never acknowledges fields outside the submitted patch", () => {
		const original: GlobalSettings = { soundEnabled: false, maxWorkspaceFiles: 450 }
		expect(
			applyAcknowledgedSettings(original, { soundEnabled: true }, ["soundEnabled", "maxWorkspaceFiles"]),
		).toEqual({ soundEnabled: true, maxWorkspaceFiles: 450 })
	})
})

describe("complete settings save acknowledgement", () => {
	const settingsSuccess = {
		part: "settings" as const,
		result: { requestId: "save-1", status: "success" as const },
	}
	const profileSuccess = {
		part: "profile" as const,
		result: { requestId: "save-1", status: "success" as const, id: "profile-1", name: "default" },
	}

	it.each(["settings", "profile"] as const)("waits for both parts when %s succeeds first", (firstPart) => {
		const progress = createSettingsSaveProgress("save-1", { settings: true, profileId: "profile-1" })
		const first = firstPart === "settings" ? settingsSuccess : profileSuccess
		const second = firstPart === "settings" ? profileSuccess : settingsSuccess
		const partial = acknowledgeSettingsSave(progress, first)
		expect(getSettingsSaveStatus(partial)).toBe("pending")
		expect(getSettingsSaveStatus(acknowledgeSettingsSave(partial, second))).toBe("success")
	})

	it("does not let profile success hide a failed global settings write", () => {
		const progress = createSettingsSaveProgress("save-1", { settings: true, profileId: "profile-1" })
		const failed = acknowledgeSettingsSave(progress, {
			part: "settings",
			result: {
				requestId: "save-1",
				status: "error",
				error: "saveFailed",
				appliedKeys: ["soundEnabled"],
				debugApplied: true,
			},
		})
		const completed = acknowledgeSettingsSave(failed, profileSuccess)
		expect(getSettingsSaveStatus(completed)).toBe("error")
		expect(completed.failure).toEqual({
			part: "settings",
			result: {
				requestId: "save-1",
				status: "error",
				error: "saveFailed",
				appliedKeys: ["soundEnabled"],
				debugApplied: true,
			},
		})
	})

	it("retains conflict details and ignores duplicate success after an error", () => {
		const progress = createSettingsSaveProgress("save-1", { settings: true })
		const failed = acknowledgeSettingsSave(progress, {
			part: "settings",
			result: {
				requestId: "save-1",
				status: "error",
				error: "conflict",
				conflictingKeys: ["approvalMode"],
			},
		})
		expect(acknowledgeSettingsSave(failed, settingsSuccess)).toBe(failed)
		expect(getSettingsSaveStatus(failed)).toBe("error")
		expect(failed.failure?.result).toMatchObject({ conflictingKeys: ["approvalMode"] })
	})

	it("ignores another request's acknowledgement and a different saved profile", () => {
		const progress = createSettingsSaveProgress("save-1", { settings: true, profileId: "profile-1" })
		expect(
			acknowledgeSettingsSave(progress, {
				part: "settings",
				result: { requestId: "old-save", status: "success" },
			}),
		).toBe(progress)
		expect(
			acknowledgeSettingsSave(progress, {
				part: "profile",
				result: { ...profileSuccess.result, id: "another-profile" },
			}),
		).toBe(progress)
	})

	it("supports profile-only saves without dispatching an unchanged preferences patch", () => {
		const progress = createSettingsSaveProgress("save-1", { profileId: "profile-1" })
		expect(progress.settingsPending).toBe(false)
		expect(getSettingsSaveStatus(acknowledgeSettingsSave(progress, profileSuccess))).toBe("success")
		expect(getSettingsSaveStatus(createSettingsSaveProgress("no-op", {}))).toBe("success")
	})

	it("waits for a correlated initial-profile creation whose persisted ID is not known yet", () => {
		const progress = createSettingsSaveProgress("save-1", { profile: true })
		expect(getSettingsSaveStatus(progress)).toBe("pending")
		expect(
			acknowledgeSettingsSave(progress, {
				part: "profile",
				result: { ...profileSuccess.result, requestId: "another-save", id: "new-profile" },
			}),
		).toBe(progress)
		const completed = acknowledgeSettingsSave(progress, {
			part: "profile",
			result: { ...profileSuccess.result, id: "new-profile" },
		})
		expect(getSettingsSaveStatus(completed)).toBe("success")
	})
})
