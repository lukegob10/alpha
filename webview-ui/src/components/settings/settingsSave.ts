import deepEqual from "fast-deep-equal"

import {
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_MAX_CONCURRENT_TASKS,
	DEFAULT_MEMORY_SETTINGS,
	DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_WRITE_DELAY_MS,
	MAX_MAX_CONCURRENT_TASKS,
	MIN_MAX_CONCURRENT_TASKS,
	type GlobalSettings,
	type ProviderProfileSaveResult,
	type SettingsSaveResult,
} from "@alpha-code/types"

import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

import {
	toManagedAgentSettingsSavePayload,
	withManagedAgentSettingsDefaults,
	type SettingsCachedState,
} from "./managed-agent-settings"

/** Editable command rules belong to extension storage; the ordinary lists also contain inherited rules. */
export function getEditableSettingsState(
	state: ExtensionStateContextType,
): SettingsCachedState & { allowedCommands: string[]; deniedCommands: string[] } {
	return {
		...withManagedAgentSettingsDefaults(state),
		allowedCommands: [...(state.commandRuleSettings?.allowedCommands ?? state.allowedCommands ?? [])],
		deniedCommands: [...(state.commandRuleSettings?.deniedCommands ?? state.deniedCommands ?? [])],
	}
}

/** Normalize both the edit baseline and draft identically, without writing default values merely on Save. */
export function getSettingsSavePayload(state: SettingsCachedState): GlobalSettings {
	return {
		language: state.language,
		alwaysAllowReadOnly: state.alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace: state.alwaysAllowReadOnlyOutsideWorkspace,
		alwaysAllowWrite: state.alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace: state.alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected: state.alwaysAllowWriteProtected,
		alwaysAllowExecute: state.alwaysAllowExecute,
		approvalMode: state.approvalMode,
		approvalModeBypassAcknowledged: state.approvalModeBypassAcknowledged === true,
		autoApprovalEnabled: state.autoApprovalEnabled ?? false,
		disabledBuiltinSkills: state.disabledBuiltinSkills ?? [],
		alwaysAllowMcp: state.alwaysAllowMcp,
		allowedCommands: state.allowedCommands ?? [],
		deniedCommands: state.deniedCommands ?? [],
		// Explicit null survives the webview wire format and clears nullable overrides.
		allowedMaxRequests: state.allowedMaxRequests ?? null,
		allowedMaxCost: state.allowedMaxCost ?? null,
		autoCondenseContext: state.autoCondenseContext ?? true,
		autoCondenseContextPercent: state.autoCondenseContextPercent ?? 100,
		autoCondenseContextScope: state.autoCondenseContextScope ?? "full-context",
		postTurnCondenseContextPercent:
			state.postTurnCondenseContextPercent ?? DEFAULT_POST_TURN_CONDENSE_CONTEXT_PERCENT,
		memorySettings: state.memorySettings ?? DEFAULT_MEMORY_SETTINGS,
		maxConcurrentTasks: Math.min(
			Math.max(MIN_MAX_CONCURRENT_TASKS, state.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS),
			MAX_MAX_CONCURRENT_TASKS,
		),
		...(state.subagentAgentTypes !== undefined ? { subagentAgentTypes: state.subagentAgentTypes } : {}),
		...toManagedAgentSettingsSavePayload(state),
		soundEnabled: state.soundEnabled ?? false,
		soundVolume: state.soundVolume ?? 0.5,
		enableCheckpoints: state.enableCheckpoints ?? true,
		checkpointTimeout: state.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		writeDelayMs: state.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
		mcpEnabled: state.mcpEnabled ?? true,
		maxOpenTabsContext: Math.min(Math.max(0, state.maxOpenTabsContext ?? 20), 200),
		maxWorkspaceFiles: Math.min(Math.max(0, state.maxWorkspaceFiles ?? 200), 200),
		showAlphaIgnoredFiles: state.showAlphaIgnoredFiles ?? false,
		enableSubfolderRules: state.enableSubfolderRules ?? false,
		maxImageFileSize: state.maxImageFileSize ?? 5,
		maxTotalImageSize: state.maxTotalImageSize ?? 20,
		includeDiagnosticMessages: state.includeDiagnosticMessages ?? true,
		maxDiagnosticMessages: state.maxDiagnosticMessages ?? 50,
		alwaysAllowSubtasks: state.alwaysAllowSubtasks,
		alwaysAllowSubagents: state.alwaysAllowSubagents,
		alwaysAllowTickets: state.alwaysAllowTickets ?? false,
		alwaysAllowFollowupQuestions: state.alwaysAllowFollowupQuestions ?? false,
		followupAutoApproveTimeoutMs: state.followupAutoApproveTimeoutMs ?? 0,
		reasoningBlockCollapsed: state.reasoningBlockCollapsed ?? true,
		enterBehavior: state.enterBehavior ?? "send",
		autoSteer: state.autoSteer === true,
		includeCurrentTime: state.includeCurrentTime ?? true,
		includeCurrentCost: state.includeCurrentCost ?? true,
		maxGitStatusFiles: state.maxGitStatusFiles ?? 0,
		showWorktreesInHomeScreen: state.showWorktreesInHomeScreen,
		experiments: state.experiments,
		customSupportPrompts: state.customSupportPrompts,
	}
}

export interface SettingsPatch {
	updatedSettings: GlobalSettings
	expectedSettings: GlobalSettings
}

/** Only edited preferences are writable; a stale form must not replay its entire captured state. */
export function createSettingsPatch(
	baseline: GlobalSettings,
	draft: GlobalSettings,
	expectedBaseline: GlobalSettings = baseline,
): SettingsPatch {
	const updatedSettings: GlobalSettings = {}
	const expectedSettings: GlobalSettings = {}
	for (const key of Object.keys(draft) as Array<keyof GlobalSettings>) {
		const value = draft[key]
		// Undefined cannot be written through JSON. Clearable fields use explicit null in the payload adapter.
		if (value === undefined || deepEqual(value, baseline[key])) continue
		Object.assign(updatedSettings, { [key]: value })
		if (expectedBaseline[key] !== undefined) Object.assign(expectedSettings, { [key]: expectedBaseline[key] })
	}
	return { updatedSettings, expectedSettings }
}

/** A failed multi-field save can still persist a prefix; retain that evidence without rebasing untouched values. */
export function applyAcknowledgedSettings<T extends GlobalSettings>(
	baseline: T,
	submitted: GlobalSettings,
	appliedKeys: ReadonlyArray<keyof GlobalSettings>,
): T {
	const acknowledgedSettings: GlobalSettings = {}
	for (const key of appliedKeys) {
		if (Object.hasOwn(submitted, key)) Object.assign(acknowledgedSettings, { [key]: submitted[key] })
	}
	return { ...baseline, ...acknowledgedSettings }
}

export type SettingsSaveAcknowledgement =
	| { part: "settings"; result: SettingsSaveResult }
	| { part: "profile"; result: ProviderProfileSaveResult }

export type SettingsSaveFailure =
	| { part: "settings"; result: Extract<SettingsSaveResult, { status: "error" }> }
	| { part: "profile"; result: Extract<ProviderProfileSaveResult, { status: "error" }> }

export interface SettingsSaveProgress {
	requestId: string
	settingsPending: boolean
	profilePending: boolean
	profileId?: string
	failure?: SettingsSaveFailure
}

export function createSettingsSaveProgress(
	requestId: string,
	{ settings = false, profileId, profile = false }: { settings?: boolean; profileId?: string; profile?: boolean },
): SettingsSaveProgress {
	return {
		requestId,
		settingsPending: settings,
		profilePending: profile || profileId !== undefined,
		...(profileId !== undefined ? { profileId } : {}),
	}
}

/** A profile acknowledgement alone cannot mark a multi-part Settings Save successful. */
export function acknowledgeSettingsSave(
	progress: SettingsSaveProgress,
	acknowledgement: SettingsSaveAcknowledgement,
): SettingsSaveProgress {
	const { part, result } = acknowledgement
	if (result.requestId !== progress.requestId) return progress
	if (part === "settings") {
		if (!progress.settingsPending) return progress
		return {
			...progress,
			settingsPending: false,
			...(result.status === "error" && !progress.failure ? { failure: { part, result } } : {}),
		}
	}
	if (
		!progress.profilePending ||
		(result.status === "success" && progress.profileId !== undefined && result.id !== progress.profileId)
	) {
		return progress
	}
	return {
		...progress,
		profilePending: false,
		...(result.status === "error" && !progress.failure ? { failure: { part, result } } : {}),
	}
}

export function getSettingsSaveStatus(progress: SettingsSaveProgress): "pending" | "success" | "error" {
	if (progress.failure) return "error"
	return progress.settingsPending || progress.profilePending ? "pending" : "success"
}
