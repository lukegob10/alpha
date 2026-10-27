import assert from "node:assert/strict"
import test from "node:test"
import type { AlphaCodeSettings, AlphaMessage } from "@alpha-code/types"

import {
	assertLiveFileToolBoundary,
	createCompletionReviewAcknowledger,
	withBoundedFixtureCleanup,
} from "../suite/proportional-context-support"

const commands = ["node", "rg", "cut"]
type Ask = Pick<AlphaMessage, "ask" | "partial" | "isAnswered" | "text">

for (const ask of ["command", "tool"] as const) {
	test(`a finalized ${ask} review fails even when fixture commands are configured`, () => {
		let approvals = 0
		const task = {
			taskAsk: {
				ask,
				partial: false,
				text: ask === "tool" ? JSON.stringify({ tool: "readFile", isOutsideWorkspace: false }) : "node -p 1",
			},
			approveAsk: () => approvals++,
		}
		assert.throws(() => assertLiveFileToolBoundary(task, commands), new RegExp(`Unexpected boundary: ${ask}`))
		assert.equal(createCompletionReviewAcknowledger()(task), false)
		assert.equal(approvals, 0, "A command or tool review must never be acknowledged by the fixture")
	})
}

test("partial and automatically answered prompts do not become manual reviews", () => {
	const prompts: Ask[] = [
		{ ask: "command", partial: true, text: "node -p 1" },
		{ ask: "command", isAnswered: true, text: "rg --no-config -n needle live-file-tools/read.txt" },
		{ ask: "command_output", isAnswered: true },
		{ ask: "tool", partial: true, text: "{" },
		{ ask: "tool", isAnswered: true, text: JSON.stringify({ tool: "readFile", isOutsideWorkspace: false }) },
		{ ask: "followup", isAnswered: true, text: "Resolved question" },
	]
	for (const taskAsk of prompts) {
		assert.doesNotThrow(() => assertLiveFileToolBoundary({ taskAsk }, commands))
	}
	assert.doesNotThrow(() => assertLiveFileToolBoundary(undefined, commands))
	assert.doesNotThrow(() => assertLiveFileToolBoundary({}, commands))
	assert.doesNotThrow(() =>
		assertLiveFileToolBoundary({ didComplete: true, taskAsk: { ask: "command", text: "node -p 1" } }, commands),
	)
	assert.doesNotThrow(() =>
		assertLiveFileToolBoundary({ abort: true, taskAsk: { ask: "followup", text: "Cancelled question" } }, commands),
	)
	const transientTranscript = {
		alphaMessages: [{ type: "ask", ask: "command", partial: false, text: "rg --no-config -n needle read.txt" }],
		taskAsk: undefined,
	}
	assert.doesNotThrow(() => assertLiveFileToolBoundary(transientTranscript, commands))
})

test("command-output progress keeps its configured-command exemption", () => {
	let approvals = 0
	const task = { taskAsk: { ask: "command_output" as const }, approveAsk: () => approvals++ }
	assert.doesNotThrow(() => assertLiveFileToolBoundary(task, commands))
	assert.throws(() => assertLiveFileToolBoundary(task), /Unexpected boundary: command_output/)
	assert.throws(() => assertLiveFileToolBoundary(task, []), /Unexpected boundary: command_output/)
	assert.equal(createCompletionReviewAcknowledger()(task), false)
	assert.equal(approvals, 0)
})

test("completion review is the only unanswered boundary the fixture may acknowledge", () => {
	let approvals = 0
	const task = { taskAsk: { ask: "completion_result" as const }, approveAsk: () => approvals++ }
	assert.doesNotThrow(() => assertLiveFileToolBoundary(task, commands))
	const acknowledge = createCompletionReviewAcknowledger()
	assert.equal(acknowledge(task), true)
	assert.equal(acknowledge(task), false)
	assert.equal(approvals, 1)
	assert.throws(
		() => assertLiveFileToolBoundary({ taskAsk: { ask: "followup", text: "Need a decision" } }, commands),
		/Unexpected boundary: followup/,
	)
})

test("outside-workspace tool review keeps its specific failure", () => {
	assert.throws(
		() =>
			assertLiveFileToolBoundary(
				{ taskAsk: { ask: "tool", text: JSON.stringify({ tool: "readFile", isOutsideWorkspace: true }) } },
				commands,
			),
		/Fixture requested outside-workspace access/,
	)
})

for (const fail of [false, true]) {
	test(`fixture cleanup restores the full saved configuration after ${fail ? "a failed review" : "completion"}`, async () => {
		const original: AlphaCodeSettings = {
			apiProvider: "vscode-lm",
			approvalMode: "ask",
			autoApprovalEnabled: false,
			alwaysAllowExecute: false,
			allowedCommands: ["git status"],
			deniedCommands: ["git push", "git remote", "git config", "npm install", "pnpm install"],
			commandExecutionTimeout: 17,
			commandTimeoutAllowlist: ["git status"],
			terminalShellIntegrationDisabled: false,
			terminalShellIntegrationTimeout: 4321,
			execaShellPath: "C:\\fixture\\saved-shell.exe",
			enableCheckpoints: true,
			mcpEnabled: true,
		}
		const saved = structuredClone(original)
		let active: AlphaCodeSettings = {
			...original,
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			allowedCommands: [...commands],
			commandExecutionTimeout: 300,
		}
		let restorations = 0
		const cleanups: string[] = []
		const operation = withBoundedFixtureCleanup(
			async () => {
				assert.deepEqual(active.deniedCommands, saved.deniedCommands)
				assert.deepEqual(active.commandTimeoutAllowlist, saved.commandTimeoutAllowlist)
				assert.equal(active.execaShellPath, saved.execaShellPath)
				assert.equal(active.terminalShellIntegrationDisabled, saved.terminalShellIntegrationDisabled)
				assert.equal(active.terminalShellIntegrationTimeout, saved.terminalShellIntegrationTimeout)
				assertLiveFileToolBoundary({ taskAsk: { ask: fail ? "followup" : "completion_result" } }, commands)
				return "completed"
			},
			[
				() => {
					cleanups.push("task")
				},
				() => {
					cleanups.push("listeners")
				},
				() => {
					active = original
					restorations++
					cleanups.push("configuration")
				},
			],
			() => () => {},
		)
		if (fail) await assert.rejects(operation, /Unexpected boundary: followup/)
		else assert.equal(await operation, "completed")
		assert.deepEqual(cleanups, ["task", "listeners", "configuration"])
		assert.equal(restorations, 1)
		assert.equal(active, original)
		assert.deepEqual(active, saved)
		assert.deepEqual(original, saved, "The saved policy and shell settings must remain intact")
	})
}
