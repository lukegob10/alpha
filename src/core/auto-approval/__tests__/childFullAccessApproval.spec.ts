import { createHash } from "crypto"
import { describe, expect, it } from "vitest"
import {
	deriveAutoApprovalFlags,
	disabledSubagentAutoApprovalPolicy,
	type ApprovalMode,
	type SubagentAutoApprovalPolicy,
} from "@alpha-code/types"

import {
	captureToolReviewPolicy,
	checkAutoApproval,
	checkAutoApprovalWithInheritedPolicy,
	type CheckAutoApprovalInput,
} from "../index"
import { createSubagentCommandApprovalPolicy } from "../commands"

const protectedWrite = JSON.stringify({ tool: "editedExistingFile", path: "AGENTS.md" })
const mcpUse = JSON.stringify({ type: "use_mcp_tool", serverName: "fixture", toolName: "lookup" })

function inheritedPolicy(
	mode: ApprovalMode = "bypass",
	overrides: Partial<SubagentAutoApprovalPolicy> = {},
): SubagentAutoApprovalPolicy {
	return {
		...disabledSubagentAutoApprovalPolicy,
		...deriveAutoApprovalFlags(mode),
		mcpApproval: { enabled: true, grants: [] },
		commandApproval: createSubagentCommandApprovalPolicy(["*"], [], "a".repeat(64)),
		...overrides,
	}
}

describe("managed-child Full Access approval policy", () => {
	const opaqueSalt = "b".repeat(64)
	const blockedPermissions: Array<{
		name: string
		input: Omit<CheckAutoApprovalInput, "state">
		inherited?: Partial<SubagentAutoApprovalPolicy>
	}> = [
		{ name: "missing command", input: { ask: "command" } },
		{
			name: "unresolved invoking command denial",
			input: {
				ask: "command",
				text: 'git "$ACTION"',
				commandPolicy: { allowedPrefixes: ["*"], deniedPrefixes: ["git push"] },
			},
		},
		{
			name: "unresolved captured command denial",
			input: { ask: "command", text: "git status" },
			inherited: {
				commandApprovalCeilings: [createSubagentCommandApprovalPolicy(["*"], ['git "$ACTION"'])],
			},
		},
		{
			name: "opaque legacy command denial",
			input: { ask: "command", text: "git status" },
			inherited: {
				commandApprovalCeilings: [
					{
						algorithm: "sha256-salted-prefix-v1",
						salt: opaqueSalt,
						allowAll: true,
						denyAll: false,
						allowed: [],
						denied: [
							{
								prefixLength: "git push".length,
								digest: createHash("sha256").update(opaqueSalt).update("\0git push").digest("hex"),
							},
						],
					},
				],
			},
		},
		{
			name: "protected command without inherited grant",
			input: { ask: "command", text: "Set-Content AGENTS.md synthetic-content", isProtected: true },
			inherited: { alwaysAllowWriteProtected: false },
		},
		{
			name: "protected command without invoking grant",
			input: {
				ask: "command",
				text: "Set-Content AGENTS.md synthetic-content",
				isProtected: true,
				reviewPolicy: captureToolReviewPolicy(),
			},
		},
		{
			name: "protected tool without inherited grant",
			input: { ask: "tool", text: protectedWrite, isProtected: true },
			inherited: { alwaysAllowWriteProtected: false },
		},
		{
			name: "protected tool without invoking grant",
			input: {
				ask: "tool",
				text: protectedWrite,
				isProtected: true,
				reviewPolicy: captureToolReviewPolicy(),
			},
		},
		{ name: "malformed tool metadata", input: { ask: "tool", text: "{" } },
		{ name: "unknown tool metadata", input: { ask: "tool", text: JSON.stringify({ tool: "unknown" }) } },
		{
			name: "explicit-only delegation",
			input: { ask: "tool", text: JSON.stringify({ tool: "spawnAgent" }), requiresExplicitApproval: true },
		},
		{
			name: "missing legacy ticket grant",
			input: {
				ask: "tool",
				text: JSON.stringify({ tool: "ticket", ticketActivity: { state: "pending", operation: "create" } }),
			},
			inherited: { alwaysAllowTickets: undefined },
		},
		{
			name: "missing legacy MCP grant",
			input: { ask: "use_mcp_server", text: mcpUse },
			inherited: { mcpApproval: undefined },
		},
		{
			name: "disabled inherited MCP grant",
			input: { ask: "use_mcp_server", text: mcpUse },
			inherited: { mcpApproval: { enabled: false, grants: [] } },
		},
		{
			name: "closed invoking MCP grant",
			input: { ask: "use_mcp_server", text: mcpUse, reviewPolicy: captureToolReviewPolicy() },
		},
		{ name: "malformed MCP metadata", input: { ask: "use_mcp_server", text: "{}" } },
	]

	it.each(blockedPermissions)("denies $name without waiting for a human", async ({ input, inherited }) => {
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				...input,
				state: { approvalMode: "bypass" },
				inheritedState: inheritedPolicy("bypass", inherited),
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it.each([
		["ask", "bypass"],
		["auto", "bypass"],
		["bypass", "ask"],
		["bypass", "auto"],
	] as const)("keeps permission review for live %s and captured %s", async (live, captured) => {
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: live },
				inheritedState: inheritedPolicy(captured),
				ask: "tool",
				text: protectedWrite,
				isProtected: true,
				reviewPolicy: captureToolReviewPolicy(),
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("preserves primary-task permission review", async () => {
		const input: CheckAutoApprovalInput = {
			state: { approvalMode: "bypass" },
			ask: "tool",
			text: protectedWrite,
			isProtected: true,
			reviewPolicy: captureToolReviewPolicy(),
		}
		await expect(checkAutoApproval(input)).resolves.toEqual({ decision: "ask" })
		await expect(checkAutoApprovalWithInheritedPolicy(input)).resolves.toEqual({ decision: "ask" })
	})

	it.each([
		"followup",
		"completion_result",
		"api_req_failed",
		"resume_task",
		"resume_completed_task",
		"mistake_limit_reached",
		"auto_approval_max_req_reached",
	] as const)("keeps %s user-owned in Full Access", async (ask) => {
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: "bypass", followupAutoApproveTimeoutMs: 0 },
				inheritedState: inheritedPolicy(),
				ask,
				text: JSON.stringify({ suggest: [{ answer: "Suggested answer" }] }),
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("approves authorized writes and nonblocking output", async () => {
		for (const input of [
			{ ask: "tool" as const, text: JSON.stringify({ tool: "editedExistingFile", path: "src/file.ts" }) },
			{ ask: "command_output" as const },
		]) {
			await expect(
				checkAutoApprovalWithInheritedPolicy({
					...input,
					state: { approvalMode: "bypass" },
					inheritedState: inheritedPolicy(),
				}),
			).resolves.toEqual({ decision: "approve" })
		}
	})
})
