import { describe, expect, it } from "vitest"

import {
	createToolPolicySnapshot,
	isCommandDeniedByPolicy,
	isPathAllowed,
	resolveCommandTimeoutMs,
} from "../ToolPolicy"

function policy() {
	return createToolPolicySnapshot({
		visibleTools: ["read_file", "execute_command"],
		allowedTools: ["read_file", "execute_command"],
		disabledTools: [],
		execution: {
			workspaceRoots: ["F:/workspace"],
			command: {
				allowedPrefixes: ["git"],
				deniedPrefixes: ["git push"],
				userTimeoutMs: 20_000,
				timeoutAllowlist: ["npm test"],
			},
		},
		digest: "policy",
	})
}

describe("ToolPolicy", () => {
	it("captures the approval mode and defaults missing legacy inputs to Ask", () => {
		const captured = createToolPolicySnapshot({ visibleTools: [], approvalMode: "bypass" })
		const legacy = createToolPolicySnapshot({ visibleTools: [] })

		expect(captured.approval.mode).toBe("bypass")
		expect(legacy.approval.mode).toBe("ask")
		expect(captured.digest).not.toBe(legacy.digest)
	})

	it("freezes execution policy and produces a sanitized model summary", () => {
		const snapshot = policy()

		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.execution)).toBe(true)
		expect(snapshot.summary).toContain("workspace-write")
		expect(snapshot.summary).not.toContain("secret")
	})

	it("allows workspace paths and rejects traversal outside the workspace", () => {
		const snapshot = policy()

		expect(isPathAllowed(snapshot, "src/index.ts", "F:/workspace")).toBe(true)
		expect(isPathAllowed(snapshot, "../outside.txt", "F:/workspace")).toBe(false)
	})

	it("fails closed for path and command checks in a read-only diagnostic policy", () => {
		const snapshot = createToolPolicySnapshot({
			visibleTools: ["read_diagnostic_evidence"],
			allowedTools: ["read_diagnostic_evidence"],
			execution: {
				sandboxMode: "read-only",
				workspaceRoots: [],
				command: { allowedPrefixes: ["git"], deniedPrefixes: [] },
			},
		})

		expect(isPathAllowed(snapshot, "src/index.ts", "F:/workspace")).toBe(false)
		expect(isCommandDeniedByPolicy(snapshot, "git status")).toBe(true)
		expect(snapshot.summary).toContain("diagnostic evidence reader only")
		expect(snapshot.summary).not.toContain("Command approval: follows global")
	})

	it("uses the smallest positive timeout and preserves allowlist exemptions", () => {
		const snapshot = policy()

		expect(resolveCommandTimeoutMs(snapshot, 5_000, "npm run build")).toBe(5_000)
		expect(resolveCommandTimeoutMs(snapshot, 0, "npm test")).toBe(0)
	})

	it("applies longest-prefix command denial", () => {
		const snapshot = policy()

		expect(isCommandDeniedByPolicy(snapshot, "git push origin main")).toBe(true)
		expect(isCommandDeniedByPolicy(snapshot, "git diff")).toBe(false)
	})
})
