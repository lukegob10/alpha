import { isDeepStrictEqual } from "node:util"
import * as vscode from "vscode"

import {
	globalSettingsSchema,
	RETIRED_SUBAGENT_SETTING_KEYS,
	settingsSaveRequestSchema,
	type AlphaCodeSettings,
	type GlobalSettings,
	type SettingsSaveRequest,
	type SettingsSaveResult,
	type WebviewMessage,
} from "@alpha-code/types"

import type { AlphaProvider } from "./AlphaProvider"
import { Terminal } from "../../integrations/terminal/Terminal"
import { changeLanguage } from "../../i18n"
import { Package } from "../../shared/package"
import { experimentDefault } from "../../shared/experiments"

type SettingKey = keyof GlobalSettings

class SettingsConflictError extends Error {
	constructor(readonly keys: string[]) {
		super("Settings changed in another view")
	}
}

function normalizeSetting(key: SettingKey, value: unknown): unknown {
	if (key === "allowedCommands" || key === "deniedCommands") {
		return Array.isArray(value)
			? [
					...new Set(
						value
							.filter((item): item is string => typeof item === "string" && item.trim() !== "")
							.map((item) => item.trim()),
					),
				]
			: []
	}
	if (key === "subagentDefaultModel") return typeof value === "string" ? value.trim() || undefined : value
	if (key === "subagentDefaultReasoningEffort" && (value === "" || value === null)) return undefined
	if ((key === "allowedMaxRequests" || key === "allowedMaxCost") && value === null) return undefined
	return value
}

function omitRetiredSettings<T extends object>(settings: T): T {
	const retained = { ...settings } as T & { telemetrySetting?: unknown; terminalOutputPreviewSize?: unknown }
	delete retained.telemetrySetting
	delete retained.terminalOutputPreviewSize
	return retained
}

function applyTerminalSetting(key: SettingKey, value: unknown) {
	if (key === "execaShellPath") Terminal.setExecaShellPath(value as string | undefined)
	if (value === undefined) return
	switch (key) {
		case "terminalShellIntegrationTimeout":
			Terminal.setShellIntegrationTimeout(value as number)
			break
		case "terminalShellIntegrationDisabled":
			Terminal.setShellIntegrationDisabled(value as boolean)
			break
		case "terminalCommandDelay":
			Terminal.setCommandDelay(value as number)
			break
		case "terminalPowershellCounter":
			Terminal.setPowershellCounter(value as boolean)
			break
		case "terminalZshClearEolMark":
			Terminal.setTerminalZshClearEolMark(value as boolean)
			break
		case "terminalZshOhMy":
			Terminal.setTerminalZshOhMy(value as boolean)
			break
		case "terminalZshP10k":
			Terminal.setTerminalZshP10k(value as boolean)
			break
		case "terminalZdotdir":
			Terminal.setTerminalZdotdir(value as boolean)
			break
	}
}

async function applySettings(
	provider: AlphaProvider,
	settings: AlphaCodeSettings,
	assertCurrent: (key: SettingKey, value: unknown) => void = () => {},
	rollbackOnFailure = false,
	onApplied: (key: SettingKey) => void = () => {},
) {
	const timeoutChanged =
		Object.hasOwn(settings, "followupAutoApproveTimeoutMs") &&
		settings.followupAutoApproveTimeoutMs !== provider.contextProxy.getValue("followupAutoApproveTimeoutMs")
	if (timeoutChanged) {
		assertCurrent("followupAutoApproveTimeoutMs", settings.followupAutoApproveTimeoutMs)
		// Publish revocation before unrelated persistence can stall this save.
		for (const taskId of provider.getLiveTaskIds()) provider.getLiveTask(taskId)?.cancelAutoApprovalTimeout(true)
		if (rollbackOnFailure)
			await provider.contextProxy.setValue(
				"followupAutoApproveTimeoutMs",
				settings.followupAutoApproveTimeoutMs,
				true,
			)
		else await provider.contextProxy.setValue("followupAutoApproveTimeoutMs", settings.followupAutoApproveTimeoutMs)
		onApplied("followupAutoApproveTimeoutMs")
	}
	for (const [key, original] of Object.entries(settings) as [SettingKey, GlobalSettings[SettingKey]][]) {
		if (RETIRED_SUBAGENT_SETTING_KEYS.includes(key) || (timeoutChanged && key === "followupAutoApproveTimeoutMs"))
			continue
		assertCurrent(key, original)
		let value = original
		if (
			key === "allowedCommands" ||
			key === "deniedCommands" ||
			key === "subagentDefaultModel" ||
			key === "subagentDefaultReasoningEffort"
		) {
			value = normalizeSetting(key, original) as GlobalSettings[SettingKey]
		} else if (key === "mcpEnabled") {
			value = original ?? true
		} else if (key === "maxConcurrentTasks") {
			value = original ?? 3
		} else if (key === "experiments") {
			if (!original) continue
			value = {
				...(provider.contextProxy.getValue("experiments") ?? experimentDefault),
				...(original as GlobalSettings["experiments"]),
			}
		} else if (key === "customSupportPrompts" && !original) {
			continue
		}
		if (key === "subagentAgentTypes" && original === null) value = undefined
		// Keep legacy validation for callers that have no correlated request.
		if (
			key === "memorySettings" ||
			key === "language" ||
			key === "subagentsEnabled" ||
			key === "subagentInterruptMessage" ||
			key === "maxConcurrentSubagents" ||
			key === "subagentDefaultReasoningEffort" ||
			key === "subagentDefaultModel" ||
			key === "subagentAgentTypes"
		) {
			value = globalSettingsSchema.shape[key].parse(value) as GlobalSettings[SettingKey]
		}
		if (rollbackOnFailure) await provider.contextProxy.setValue(key, value, true)
		else await provider.contextProxy.setValue(key, value)
		onApplied(key)
		applyTerminalSetting(key, value)
		if (key === "language") changeLanguage(value as "en")
		if (key === "mcpEnabled") await provider.getMcpHub()?.handleMcpEnabledChange(value as boolean)
		if (key === "maxConcurrentTasks") provider.setMaxConcurrentTasks(value as number)
	}
	if (Object.hasOwn(settings, "memorySettings")) await provider.refreshMemorySettings()
}

async function validateExpectedSettings(provider: AlphaProvider, patch: GlobalSettings, request: SettingsSaveRequest) {
	const before = provider.contextProxy.getValues()
	const projected = await provider.getState({ includeTaskHistory: false, includeScheduledTasks: false })
	const snapshot = provider.contextProxy.getValues()
	const conflicts: string[] = []
	for (const key of Object.keys(patch) as SettingKey[]) {
		const raw = snapshot[key]
		const current =
			key === "allowedCommands" || key === "deniedCommands"
				? (raw ?? [])
				: key in projected
					? projected[key as keyof typeof projected]
					: raw
		const desired = normalizeSetting(key, patch[key])
		const unchangedDuringProjection = isDeepStrictEqual(before[key], raw)
		if (
			(!unchangedDuringProjection ||
				!isDeepStrictEqual(
					normalizeSetting(key, current),
					normalizeSetting(key, request.expectedSettings[key]),
				)) &&
			!isDeepStrictEqual(normalizeSetting(key, current), desired)
		)
			conflicts.push(key)
	}
	for (const [name, change, current] of [
		["debug", request.debug, vscode.workspace.getConfiguration(Package.name).get<boolean>("debug", false)],
		[
			"terminalInheritEnv",
			request.terminalInheritEnv,
			vscode.workspace.getConfiguration().get<boolean>("terminal.integrated.inheritEnv", true),
		],
	] as const) {
		if (change && current !== change.expected && current !== change.value) conflicts.push(name)
	}
	if (conflicts.length) throw new SettingsConflictError(conflicts)
	return (key: SettingKey, value: unknown) => {
		const current = provider.contextProxy.getValue(key)
		// A task or another panel may commit while an earlier preference is awaiting storage.
		if (
			!isDeepStrictEqual(current, snapshot[key]) &&
			!isDeepStrictEqual(normalizeSetting(key, current), normalizeSetting(key, value))
		) {
			throw new SettingsConflictError([key])
		}
	}
}

export async function handleSettingsUpdate(provider: AlphaProvider, message: WebviewMessage) {
	if (message.settingsSave === undefined) {
		if (message.updatedSettings) {
			await applySettings(provider, omitRetiredSettings(message.updatedSettings))
			await provider.postStateToWebview()
		}
		return
	}
	const rawRequestId: unknown = message.settingsSave?.requestId
	if (typeof rawRequestId !== "string" || rawRequestId.length === 0 || rawRequestId.length > 128) return
	let result: SettingsSaveResult
	const request = settingsSaveRequestSchema.safeParse(message.settingsSave)
	const patch = globalSettingsSchema
		.strict()
		.safeParse(message.updatedSettings && omitRetiredSettings(message.updatedSettings))
	if (!request.success || !patch.success) {
		result = { requestId: rawRequestId, status: "error", error: "invalid" }
	} else {
		const appliedKeys: SettingKey[] = []
		let debugApplied = false
		let terminalInheritEnvApplied = false
		try {
			const assertCurrent = await validateExpectedSettings(provider, patch.data, request.data)
			await applySettings(provider, patch.data, assertCurrent, true, (key) => appliedKeys.push(key))
			if (request.data.debug) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("debug", request.data.debug.value, vscode.ConfigurationTarget.Global)
				debugApplied = true
			}
			if (request.data.terminalInheritEnv) {
				await vscode.workspace
					.getConfiguration()
					.update(
						"terminal.integrated.inheritEnv",
						request.data.terminalInheritEnv.value,
						vscode.ConfigurationTarget.Global,
					)
				terminalInheritEnvApplied = true
			}
			await provider.postStateToWebview()
			result = { requestId: rawRequestId, status: "success" }
		} catch (error) {
			result =
				error instanceof SettingsConflictError
					? { requestId: rawRequestId, status: "error", error: "conflict", conflictingKeys: error.keys }
					: { requestId: rawRequestId, status: "error", error: "saveFailed" }
			if (appliedKeys.length) result.appliedKeys = appliedKeys
			if (debugApplied) result.debugApplied = true
			if (terminalInheritEnvApplied) result.terminalInheritEnvApplied = true
		}
	}
	if (result.status === "error") {
		try {
			await provider.postStateToWebview()
		} catch {
			// State publication cannot suppress the correlated failure or its committed portions.
		}
	}
	try {
		await provider.postMessageToWebview({ type: "settingsSaved", settingsSaveResult: result })
	} catch {
		provider.log("[SettingsSave] acknowledgement_failed")
	}
}
