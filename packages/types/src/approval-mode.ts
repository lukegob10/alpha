import { z } from "zod"

export const APPROVAL_MODES = ["ask", "auto", "bypass"] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]
export const approvalModeSchema = z.enum(APPROVAL_MODES)
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto"

export const approvalModeRank: Record<ApprovalMode, number> = {
	ask: 0,
	auto: 1,
	bypass: 2,
}

export interface ApprovalChipFlags {
	autoApprovalEnabled: boolean
	alwaysAllowReadOnly: boolean
	alwaysAllowReadOnlyOutsideWorkspace: boolean
	alwaysAllowWrite: boolean
	alwaysAllowWriteOutsideWorkspace: boolean
	alwaysAllowWriteProtected: boolean
	alwaysAllowTickets: boolean
	alwaysAllowMcp: boolean
	alwaysAllowSubtasks: boolean
	alwaysAllowSubagents: boolean
	alwaysAllowExecute: boolean
	alwaysAllowFollowupQuestions: boolean
}

export interface ApprovalModeSettings {
	approvalMode?: unknown
	autoApprovalEnabled?: unknown
	alwaysAllowReadOnly?: unknown
	alwaysAllowReadOnlyOutsideWorkspace?: unknown
	alwaysAllowWrite?: unknown
	alwaysAllowWriteOutsideWorkspace?: unknown
	alwaysAllowWriteProtected?: unknown
	alwaysAllowExecute?: unknown
	alwaysAllowTickets?: unknown
	alwaysAllowMcp?: unknown
	alwaysAllowSubtasks?: unknown
	alwaysAllowSubagents?: unknown
	alwaysAllowFollowupQuestions?: unknown
	allowedCommands?: unknown
}

export const hasStoredApprovalSurface = (settings: ApprovalModeSettings): boolean =>
	settings.autoApprovalEnabled !== undefined ||
	settings.alwaysAllowReadOnly !== undefined ||
	settings.alwaysAllowWrite !== undefined ||
	settings.alwaysAllowExecute !== undefined ||
	settings.alwaysAllowTickets !== undefined ||
	settings.alwaysAllowMcp !== undefined ||
	settings.alwaysAllowSubagents !== undefined ||
	settings.alwaysAllowWriteOutsideWorkspace !== undefined ||
	settings.alwaysAllowWriteProtected !== undefined ||
	settings.allowedCommands !== undefined

export function shouldDeriveApprovalFlags(settings: ApprovalModeSettings = {}): boolean {
	return isApprovalMode(settings.approvalMode) || !hasStoredApprovalSurface(settings)
}

export function resolveApprovalFlags(
	settings: ApprovalModeSettings = {},
	options: { alwaysAllowWriteProtected?: boolean; alwaysAllowMcp?: boolean } = {},
): ApprovalChipFlags {
	if (shouldDeriveApprovalFlags(settings)) {
		return deriveAutoApprovalFlags(migrateApprovalMode(settings), {
			alwaysAllowWriteProtected: options.alwaysAllowWriteProtected ?? settings.alwaysAllowWriteProtected === true,
			alwaysAllowMcp: options.alwaysAllowMcp ?? settings.alwaysAllowMcp === true,
		})
	}

	return {
		autoApprovalEnabled: settings.autoApprovalEnabled === true,
		alwaysAllowReadOnly: settings.alwaysAllowReadOnly === true,
		alwaysAllowReadOnlyOutsideWorkspace: settings.alwaysAllowReadOnlyOutsideWorkspace === true,
		alwaysAllowWrite: settings.alwaysAllowWrite === true,
		alwaysAllowWriteOutsideWorkspace: settings.alwaysAllowWriteOutsideWorkspace === true,
		alwaysAllowWriteProtected: settings.alwaysAllowWriteProtected === true,
		alwaysAllowTickets: settings.alwaysAllowTickets === true,
		alwaysAllowMcp: settings.alwaysAllowMcp === true,
		alwaysAllowSubtasks: settings.alwaysAllowSubtasks === true,
		alwaysAllowSubagents: settings.alwaysAllowSubagents === true,
		alwaysAllowExecute: settings.alwaysAllowExecute === true,
		alwaysAllowFollowupQuestions: settings.alwaysAllowFollowupQuestions === true,
	}
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return value === "ask" || value === "auto" || value === "bypass"
}

export function migrateApprovalMode(settings: ApprovalModeSettings = {}): ApprovalMode {
	if (isApprovalMode(settings.approvalMode)) {
		return settings.approvalMode
	}

	// New installs have no stored approval surface. Product default is Auto.
	if (!hasStoredApprovalSurface(settings)) {
		return DEFAULT_APPROVAL_MODE
	}

	if (settings.autoApprovalEnabled !== true) {
		return "ask"
	}

	const allowedCommands = Array.isArray(settings.allowedCommands)
		? settings.allowedCommands.filter((command): command is string => typeof command === "string")
		: []
	const hasWildcard = allowedCommands.some((command) => command.trim() === "*")
	const hadWrite = settings.alwaysAllowWrite === true
	const hadExecute = settings.alwaysAllowExecute === true
	// Never infer Full Access from leftover chips: the previous kernel still
	// asked for outside writes, and Full Access requires a one-time warning.
	// Only users who already had writes, execute, and `*` stay on Auto.
	if (hadWrite && hadExecute && hasWildcard) {
		return "auto"
	}

	return "ask"
}

export function deriveAutoApprovalFlags(
	mode: ApprovalMode,
	options: { alwaysAllowWriteProtected?: boolean; alwaysAllowMcp?: boolean } = {},
): ApprovalChipFlags {
	const base: ApprovalChipFlags = {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowTickets: false,
		alwaysAllowMcp: false,
		alwaysAllowSubtasks: false,
		alwaysAllowSubagents: false,
		alwaysAllowExecute: false,
		alwaysAllowFollowupQuestions: false,
	}

	if (mode === "ask") {
		return {
			...base,
			alwaysAllowMcp: options.alwaysAllowMcp === true,
		}
	}

	const autoFlags: ApprovalChipFlags = {
		...base,
		alwaysAllowWrite: true,
		alwaysAllowTickets: true,
		alwaysAllowSubtasks: true,
		alwaysAllowSubagents: true,
		alwaysAllowExecute: true,
		alwaysAllowWriteProtected: options.alwaysAllowWriteProtected === true,
		alwaysAllowMcp: options.alwaysAllowMcp === true,
	}

	if (mode === "auto") {
		return autoFlags
	}

	return {
		...autoFlags,
		alwaysAllowReadOnlyOutsideWorkspace: true,
		alwaysAllowWriteOutsideWorkspace: true,
		alwaysAllowWriteProtected: true,
		alwaysAllowMcp: true,
		alwaysAllowFollowupQuestions: true,
	}
}

export function settingsForApprovalMode(
	mode: ApprovalMode,
	options: {
		alwaysAllowWriteProtected?: boolean
		alwaysAllowMcp?: boolean
		approvalModeBypassAcknowledged?: boolean
	} = {},
): ApprovalChipFlags & {
	approvalMode: ApprovalMode
	approvalModeBypassAcknowledged?: boolean
} {
	return {
		approvalMode: mode,
		...deriveAutoApprovalFlags(mode, options),
		...(mode === "bypass" || options.approvalModeBypassAcknowledged
			? { approvalModeBypassAcknowledged: options.approvalModeBypassAcknowledged !== false }
			: {}),
	}
}

export interface ApprovalPolicySnapshot {
	autoApprovalEnabled: boolean
	alwaysAllowWrite: boolean
	alwaysAllowWriteOutsideWorkspace: boolean
	alwaysAllowWriteProtected: boolean
	alwaysAllowExecute: boolean
	commandApproval: { allowAll: boolean }
}

export function inferApprovalModeFromPolicy(policy: ApprovalPolicySnapshot): ApprovalMode {
	if (!policy.autoApprovalEnabled) {
		return "ask"
	}
	if (policy.alwaysAllowWriteOutsideWorkspace && policy.commandApproval.allowAll) {
		return "bypass"
	}
	if (!policy.alwaysAllowWrite || !policy.alwaysAllowExecute) {
		return "ask"
	}
	return "auto"
}

export function effectiveCommandAllowlistForMode(mode: ApprovalMode, allowedCommands: string[]): string[] {
	if (mode === "ask") {
		return allowedCommands.filter((command) => command.trim() !== "*")
	}
	if (mode === "bypass") {
		return allowedCommands.some((command) => command.trim() === "*") ? allowedCommands : ["*", ...allowedCommands]
	}
	if (mode === "auto" && allowedCommands.length === 0) {
		return ["*"]
	}
	return allowedCommands
}

/** True when the captured grant is Bypass-equivalent. Auto children are not Bypass. */
export function isBypassSubagentAutoApprovalPolicy(policy: ApprovalPolicySnapshot): boolean {
	return inferApprovalModeFromPolicy(policy) === "bypass"
}

/** True when the child dial is narrower than the parent dial. */
export function isSubagentApprovalNarrowerThanParent(
	childPolicy: ApprovalPolicySnapshot,
	parentMode: ApprovalMode,
): boolean {
	return approvalModeRank[inferApprovalModeFromPolicy(childPolicy)] < approvalModeRank[parentMode]
}
