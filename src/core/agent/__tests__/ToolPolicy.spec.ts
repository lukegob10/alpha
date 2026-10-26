import { describe, expect, it } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

import {
	createToolPolicySnapshot,
	isCommandDeniedByPolicy,
	isPathAllowed,
	resolveCommandTimeoutMs,
} from "../ToolPolicy"

const defaultWorkspaceRoot = path.join(path.parse(process.cwd()).root, "workspace")

function policy(workspaceRoot = defaultWorkspaceRoot) {
	return createToolPolicySnapshot({
		visibleTools: ["read_file", "execute_command"],
		allowedTools: ["read_file", "execute_command"],
		disabledTools: [],
		execution: {
			workspaceRoots: [workspaceRoot],
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
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-tool-policy-"))
		try {
			const workspace = path.join(temporaryDirectory, "workspace")
			fs.mkdirSync(workspace)
			const snapshot = policy(workspace)

			expect(isPathAllowed(snapshot, "src/index.ts", workspace)).toBe(true)
			expect(isPathAllowed(snapshot, "../outside.txt", workspace)).toBe(false)
			expect(
				isPathAllowed(snapshot, path.join(temporaryDirectory, "workspace-sibling", "index.ts"), workspace),
			).toBe(false)
		} finally {
			fs.rmSync(temporaryDirectory, { recursive: true, force: true })
		}
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

		expect(isPathAllowed(snapshot, "src/index.ts", defaultWorkspaceRoot)).toBe(false)
		expect(isCommandDeniedByPolicy(snapshot, "git status")).toBe(true)
		expect(snapshot.summary).toContain("diagnostic evidence reader only")
		expect(snapshot.summary).not.toContain("Command approval: follows global")
	})

	it("uses the smallest positive timeout and preserves allowlist exemptions", () => {
		const snapshot = policy()

		expect(resolveCommandTimeoutMs(snapshot, 5_000, "npm run build")).toBe(5_000)
		expect(resolveCommandTimeoutMs(snapshot, 0, "npm test")).toBe(0)
	})

	it("applies token-prefix command denial", () => {
		const snapshot = policy()

		expect(isCommandDeniedByPolicy(snapshot, "git push origin main")).toBe(true)
		expect(isCommandDeniedByPolicy(snapshot, "git diff")).toBe(false)
	})

	it.each([
		["git-impostor push", false],
		["git push-extra origin main", false],
		['"git" "push" origin main', true],
		["git status && git push origin main", true],
		["git status | git push origin main", true],
		["git status\n git push origin main", true],
	])("uses the shared decision for captured denial of %s", (command, denied) => {
		expect(isCommandDeniedByPolicy(policy(), command)).toBe(denied)
	})

	it("keeps a captured denial authoritative over a more specific allow", () => {
		const snapshot = createToolPolicySnapshot({
			visibleTools: ["execute_command"],
			execution: {
				command: { allowedPrefixes: ["git push --dry-run"], deniedPrefixes: ["git push"] },
			},
		})
		expect(isCommandDeniedByPolicy(snapshot, "git push --dry-run origin main")).toBe(true)
	})

	it("captures literal command rules without applying tool aliases or retaining mutable arrays", () => {
		const allowedPrefixes = ["execute_command", "git STATUS"]
		const deniedPrefixes = ["write_file"]
		const timeoutAllowlist = ["execute_command"]
		const snapshot = createToolPolicySnapshot({
			visibleTools: ["execute_command"],
			execution: { command: { allowedPrefixes, deniedPrefixes, timeoutAllowlist } },
		})
		allowedPrefixes.push("rm")
		deniedPrefixes.length = 0
		timeoutAllowlist.push("*")

		expect(snapshot.execution.command.allowedPrefixes).toEqual(["execute_command", "git STATUS"])
		expect(snapshot.execution.command.deniedPrefixes).toEqual(["write_file"])
		expect(snapshot.execution.command.timeoutAllowlist).toEqual(["execute_command"])
		expect(Object.isFrozen(snapshot.execution.command.allowedPrefixes)).toBe(true)
	})

	it.each([
		["npm test-extra", 20_000],
		["npm-impostor test", 20_000],
		["npm test && rm build", 20_000],
		["npm test &&", 20_000],
		['"npm" "test" --run', 0],
		["npm test && npm test --run", 0],
	])("enforces token boundaries and the entire chain for timeout exemption of %s", (command, timeout) => {
		expect(resolveCommandTimeoutMs(policy(), 0, command)).toBe(timeout)
	})
})
