import { describe, expect, it } from "vitest"

import {
	DEFAULT_APPROVAL_MODE,
	deriveAutoApprovalFlags,
	inferApprovalModeFromPolicy,
	isBypassSubagentAutoApprovalPolicy,
	isSubagentApprovalNarrowerThanParent,
	migrateApprovalMode,
	effectiveCommandAllowlistForMode,
	resolveApprovalFlags,
	settingsForApprovalMode,
	shouldDeriveApprovalFlags,
	type ApprovalPolicySnapshot,
} from "../approval-mode.js"
import { disabledSubagentAutoApprovalPolicy } from "../subagent-context.js"
import { GLOBAL_STATE_KEYS, globalSettingsSchema } from "../global-settings.js"

describe("approvalMode", () => {
	it("registers the session dial as durable global state", () => {
		expect(GLOBAL_STATE_KEYS).toEqual(expect.arrayContaining(["approvalMode", "approvalModeBypassAcknowledged"]))
		expect(globalSettingsSchema.parse({ approvalMode: "auto" }).approvalMode).toBe("auto")
		expect(globalSettingsSchema.safeParse({ approvalMode: "yolo" }).success).toBe(false)
	})

	it("defaults a new install to Auto", () => {
		expect(migrateApprovalMode({})).toBe(DEFAULT_APPROVAL_MODE)
		expect(migrateApprovalMode({ approvalMode: undefined })).toBe("auto")
	})

	it("migrates missing approvalMode from saved chips without widening", () => {
		expect(migrateApprovalMode({ autoApprovalEnabled: false })).toBe("ask")
		expect(migrateApprovalMode({ autoApprovalEnabled: true, alwaysAllowReadOnly: true })).toBe("ask")
		expect(migrateApprovalMode({ autoApprovalEnabled: true, alwaysAllowWrite: true })).toBe("ask")
		expect(
			migrateApprovalMode({
				autoApprovalEnabled: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				allowedCommands: ["*"],
			}),
		).toBe("auto")
		expect(
			migrateApprovalMode({
				autoApprovalEnabled: true,
				alwaysAllowWriteOutsideWorkspace: true,
				allowedCommands: ["*"],
			}),
		).toBe("ask")
		expect(
			migrateApprovalMode({
				autoApprovalEnabled: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				alwaysAllowWriteProtected: true,
				allowedCommands: ["git", "*"],
			}),
		).toBe("auto")
		expect(
			migrateApprovalMode({
				autoApprovalEnabled: true,
				alwaysAllowWriteOutsideWorkspace: true,
				allowedCommands: ["git"],
			}),
		).toBe("ask")
	})

	it("prefers an explicit saved mode over leftover chips", () => {
		expect(
			migrateApprovalMode({
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowWriteOutsideWorkspace: true,
				allowedCommands: ["*"],
			}),
		).toBe("auto")
	})

	it("derives chip flags from the dial without advertising a write-outside checkbox in Auto", () => {
		expect(deriveAutoApprovalFlags("ask")).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowExecute: false,
			alwaysAllowSubagents: false,
			alwaysAllowTickets: false,
		})
		expect(deriveAutoApprovalFlags("auto")).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			alwaysAllowTickets: true,
			alwaysAllowMcp: false,
		})
		expect(deriveAutoApprovalFlags("auto", { alwaysAllowWriteProtected: true }).alwaysAllowWriteProtected).toBe(
			true,
		)
		expect(deriveAutoApprovalFlags("auto", { alwaysAllowMcp: true }).alwaysAllowMcp).toBe(true)
		expect(deriveAutoApprovalFlags("bypass")).toMatchObject({
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowMcp: true,
			alwaysAllowFollowupQuestions: true,
		})
	})

	it("infers Ask when a captured grant has reads but not writes or commands", () => {
		const readOnlyGrant: ApprovalPolicySnapshot = {
			autoApprovalEnabled: true,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: false,
			commandApproval: { allowAll: false },
		}
		expect(inferApprovalModeFromPolicy(readOnlyGrant)).toBe("ask")
	})

	it("keeps leftover chips until the user explicitly chooses a mode", () => {
		expect(shouldDeriveApprovalFlags({})).toBe(true)
		expect(shouldDeriveApprovalFlags({ approvalMode: "ask" })).toBe(true)
		expect(shouldDeriveApprovalFlags({ autoApprovalEnabled: false })).toBe(false)
		expect(shouldDeriveApprovalFlags({ approvalMode: "auto", autoApprovalEnabled: false })).toBe(true)

		expect(resolveApprovalFlags({})).toMatchObject(deriveAutoApprovalFlags(DEFAULT_APPROVAL_MODE))
		expect(resolveApprovalFlags({ autoApprovalEnabled: false })).toMatchObject({
			autoApprovalEnabled: false,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
		})
		expect(
			resolveApprovalFlags({
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowExecute: false,
				allowedCommands: ["git"],
			}),
		).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
		})
		expect(
			resolveApprovalFlags({
				autoApprovalEnabled: true,
				alwaysAllowWrite: true,
				alwaysAllowReadOnly: false,
			}),
		).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: true,
			alwaysAllowExecute: false,
		})
	})

	it("does not treat an Auto child grant as Bypass or as narrower than an Auto parent", () => {
		const autoChild = {
			...disabledSubagentAutoApprovalPolicy,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			alwaysAllowTickets: true,
		}
		expect(inferApprovalModeFromPolicy(autoChild)).toBe("auto")
		expect(isBypassSubagentAutoApprovalPolicy(autoChild)).toBe(false)
		expect(isSubagentApprovalNarrowerThanParent(autoChild, "auto")).toBe(false)
		expect(isSubagentApprovalNarrowerThanParent(autoChild, "bypass")).toBe(true)
		expect(isSubagentApprovalNarrowerThanParent(disabledSubagentAutoApprovalPolicy, "auto")).toBe(true)
	})

	it("writes mode and derived chips together", () => {
		expect(settingsForApprovalMode("auto")).toMatchObject({
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowWriteOutsideWorkspace: false,
		})
	})

	it("strips the command wildcard from Ask allowlists", () => {
		expect(effectiveCommandAllowlistForMode("ask", ["*", "git status"])).toEqual(["git status"])
		expect(effectiveCommandAllowlistForMode("ask", ["*"])).toEqual([])
	})
})
