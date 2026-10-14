import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import type { AlphaMessage } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { record, runLiveCase } from "./live-file-tool-support"

const file = "live-file-tools/command-diff.txt"
const before = "before command\n"
const after = "after command\n"
const command = `node -e "require('node:fs').writeFileSync('${file}','after command\\n')"`

function appliedDiffs(messages: readonly AlphaMessage[]) {
	return messages.flatMap((message) => {
		if (message.type !== "say" || message.say !== "tool" || !message.text || message.partial) return []
		const payload = record(JSON.parse(message.text))
		return payload.tool === "appliedDiff" ? [payload] : []
	})
}

suite("Live Copilot command file diff", function () {
	this.timeout(230_000)

	suiteSetup(function () {
		if (process.env.ALPHA_E2E_PROVIDER_MODE !== "live-copilot") this.skip()
		const expectedVersion = process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION
		if (expectedVersion) assert.equal(vscode.version, expectedVersion)
	})

	test("persists the completed exec_command edit with original and final content", async () => {
		await runLiveCase(
			"command-file-diff-live",
			["exec_command"],
			{ [file]: before },
			`Run exactly one exec_command call with this cmd unchanged: ${JSON.stringify(command)}. It edits ${file}. Then finish.`,
			async (calls, messages, workspace, _answer, task) => {
				const commands = calls.filter((call) => call.name === "exec_command")
				assert.equal(commands.length, 1, "The real model must submit one command")
				assert.equal(commands[0]!.input.cmd, command)
				assert.equal(commands[0]!.isError, false)
				assert.equal(await fs.readFile(path.join(workspace, file), "utf8"), after)

				const assertDiff = (source: readonly AlphaMessage[]) => {
					const diffs = appliedDiffs(source)
					assert.equal(diffs.length, 1, "The completed command must publish one applied diff")
					const diff = diffs[0]!
					assert.deepEqual(
						{
							tool: diff.tool,
							path: diff.path,
							diffStats: diff.diffStats,
							originalContent: diff.originalContent,
							finalContent: diff.finalContent,
							changeStatus: diff.changeStatus,
						},
						{
							tool: "appliedDiff",
							path: file,
							diffStats: { added: 1, removed: 1 },
							originalContent: before,
							finalContent: after,
							changeStatus: "applied",
						},
					)
					assert.match(String(diff.diff), /-before command/)
					assert.match(String(diff.diff), /\+after command/)
					assert.ok(typeof diff.commandExecutionId === "string" && diff.commandExecutionId)
					return diff
				}
				const liveDiff = assertDiff(messages)
				const host = (
					globalThis.api as unknown as {
						sidebarProvider: { getTaskWithId(id: string): Promise<{ uiMessagesFilePath: string }> }
					}
				).sidebarProvider
				const { uiMessagesFilePath } = await host.getTaskWithId(task.taskId)
				const persisted = await readBoundedJson(uiMessagesFilePath)
				assert.ok(Array.isArray(persisted))
				const savedDiff = assertDiff(persisted as AlphaMessage[])
				assert.deepEqual(savedDiff, liveDiff, "Saved diff content must match the completed UI message")
			},
			{
				commands: ["node"],
				requestLimit: 6,
				scope: "Make only the one described edit inside live-file-tools. Do not delegate, inspect other files, or run other commands.",
			},
		)
	})
})
