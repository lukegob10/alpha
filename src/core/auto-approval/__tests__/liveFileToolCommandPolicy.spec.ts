import { describe, expect, it } from "vitest"

import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { getCommandDecision } from "../commands"
import { checkAutoApproval } from "../index"

const fixtureCommands = ["node", "rg", "cut"]
const savedDenials = ["git push", "git remote", "git config", "npm install", "pnpm install"]

function fixtureState() {
	return {
		approvalMode: "auto" as const,
		autoApprovalEnabled: true,
		alwaysAllowExecute: true,
		allowedCommands: [...fixtureCommands],
		deniedCommands: [...savedDenials],
	}
}

function capture(state: ReturnType<typeof fixtureState>) {
	return createToolPolicySnapshot({
		visibleTools: ["exec_command"],
		approvalMode: state.approvalMode,
		autoApprovalEnabled: state.autoApprovalEnabled,
		execution: {
			command: { allowedPrefixes: state.allowedCommands, deniedPrefixes: state.deniedCommands },
		},
	}).execution.command
}

describe("live file-tool command policy without executing commands", () => {
	it("retains the finite fixture allowlist and saved denials in the captured step", () => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		expect(state.allowedCommands).toEqual(["node", "rg", "cut"])
		expect(state.allowedCommands).not.toContain("*")
		expect(state.deniedCommands).toEqual(savedDenials)
		expect(commandPolicy.allowedPrefixes).toEqual([...state.allowedCommands].sort())
		expect(commandPolicy.deniedPrefixes).toEqual([...state.deniedCommands].sort())
		expect(Object.isFrozen(commandPolicy.allowedPrefixes)).toBe(true)
		expect(Object.isFrozen(commandPolicy.deniedPrefixes)).toBe(true)
	})

	it.each([
		"rg --no-config -n needle live-file-tools/read.txt",
		"rg --no-config --fixed-strings -n needle live-file-tools/read.txt",
		"rg --no-config -n -m 4 ALPHA_READ_PROBE live-file-tools/read.txt",
		"cut -c 1-8 live-file-tools/read.txt",
		"node --version",
	])("approves an observable bounded argv read with the retained denials: %s", async (text) => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		expect(getCommandDecision(text, state.allowedCommands, state.deniedCommands)).toBe("auto_approve")
		await expect(checkAutoApproval({ ask: "command", text, state, commandPolicy })).resolves.toEqual({
			decision: "approve",
		})
	})

	it.each([
		'node -p "1 + 1"',
		'node -e "process.stdout.write(1)"',
		"node -e \"require('fs').readFileSync('live-file-tools/read.txt', 'utf8')\"",
	])("keeps opaque inline code under manual review despite the configured executable: %s", async (text) => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		expect(getCommandDecision(text, state.allowedCommands, state.deniedCommands)).toBe("ask_user")
		await expect(checkAutoApproval({ ask: "command", text, state, commandPolicy })).resolves.toEqual({
			decision: "ask",
		})
	})

	it.each([
		"git push origin main",
		"git remote -v",
		"git config --get user.name",
		"npm install package-name",
		"pnpm install",
		"rg --no-config -n needle live-file-tools/read.txt && git push origin main",
	])("keeps an explicit saved denial authoritative in Auto: %s", async (text) => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		expect(getCommandDecision(text, state.allowedCommands, state.deniedCommands)).toBe("auto_deny")
		await expect(checkAutoApproval({ ask: "command", text, state, commandPolicy })).resolves.toEqual({
			decision: "deny",
		})
	})

	it.each(["node-impostor --version", "rg-extra needle live-file-tools/read.txt", "cut-extra -c 1-8 read.txt"])(
		"does not broaden a raw finite command rule to another executable: %s",
		(text) => {
			expect(getCommandDecision(text, fixtureCommands, savedDenials)).toBe("ask_user")
		},
	)

	it("a later live denial narrows the frozen read policy", async () => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		state.allowedCommands.push("extra-reader")
		state.deniedCommands.push("rg")
		expect(commandPolicy.allowedPrefixes).toEqual([...fixtureCommands].sort())
		expect(commandPolicy.deniedPrefixes).toEqual([...savedDenials].sort())
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "rg --no-config -n needle live-file-tools/read.txt",
				state,
				commandPolicy,
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it("removing a live denial cannot widen an existing step's opaque-code authority", async () => {
		const state = fixtureState()
		const commandPolicy = capture(state)
		state.deniedCommands.length = 0
		await expect(
			checkAutoApproval({ ask: "command", text: 'node -p "1 + 1"', state, commandPolicy }),
		).resolves.toEqual({ decision: "ask" })
		expect(commandPolicy.deniedPrefixes).toEqual([...savedDenials].sort())
	})
})
