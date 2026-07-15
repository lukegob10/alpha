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
