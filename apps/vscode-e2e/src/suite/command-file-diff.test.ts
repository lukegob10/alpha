import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import type { AlphaMessage } from "@alpha-code/types"

import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface CommandDiffTask {
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
	getCommandExecutionEvidence(): Array<{ toolCallId: string; exitCode?: number }>
}

interface CommandDiffHost {
	getLiveTask(taskId: string): CommandDiffTask | undefined
	getTaskWithId(taskId: string): Promise<{ uiMessagesFilePath: string }>
	showTaskWithId(taskId: string): Promise<void>
}

interface AppliedCommandDiff {
	tool: "appliedDiff"
	path: string
	diff: string
	diffStats: { added: number; removed: number }
	originalContent: string
	finalContent: string
	changeStatus: "applied"
	commandExecutionId: string
}

function commandDiffs(messages: readonly AlphaMessage[]): AppliedCommandDiff[] {
	return messages.flatMap((message) => {
		if (message.type !== "say" || message.say !== "tool" || !message.text || message.partial) return []
		const payload: unknown = JSON.parse(message.text)
		if (!payload || typeof payload !== "object" || !("tool" in payload) || payload.tool !== "appliedDiff") {
			return []
		}
		return [payload as AppliedCommandDiff]
	})
}

const observedTasks = new WeakMap<object, CommandDiffTask>()

class CommandFileDiffAI {
	readonly id = "command-file-diff-host"
	removeFromCache?: () => void
	requests = 0

	get task(): CommandDiffTask | undefined {
		return observedTasks.get(this)
	}

	constructor(
		private readonly resolveTask: (taskId: string) => CommandDiffTask,
		private readonly scriptName: string,
	) {}

	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		observedTasks.set(this, this.resolveTask(metadata.taskId))
		const request = this.requests++
		if (request < 2) {
			yield {
				type: "tool_call" as const,
				id: request === 0 ? "command-diff-success" : "command-diff-failed",
				name: "exec_command",
				arguments: JSON.stringify({
					cmd: `node ${this.scriptName} ${request === 0 ? "success" : "failure"}`,
					yield_time_ms: 10_000,
				}),
			}
			return
		}
		assert.equal(request, 2, "No unexpected provider retry or extra command")
		yield { type: "text" as const, text: "Command file diff fixture complete." }
	}

	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}

	async countTokens() {
		return 1
	}

	async completePrompt() {
		return ""
	}
}

suite("Command file diffs in the extension host", function () {
	this.timeout(120_000)

	test("persists only the completed successful command edit", async () => {
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const suffix = randomUUID()
		const scriptName = `alpha-command-file-diff-${suffix}.cjs`
		const successName = `alpha-command-success-${suffix}.txt`
		const failedName = `alpha-command-failed-${suffix}.txt`
		const scriptPath = path.join(workspace, scriptName)
		const successPath = path.join(workspace, successName)
		const failedPath = path.join(workspace, failedName)
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: CommandDiffHost }).sidebarProvider
		assert.ok(host)
		const scripted = new CommandFileDiffAI((id) => {
			const task = host.getLiveTask(id)
			assert.ok(task)
			return task
		}, scriptName)
		const acknowledgeCompletion = createCompletionReviewAcknowledger()

		await withBoundedFixtureCleanup(async () => {
			await fs.writeFile(successPath, "before success\n", { flag: "wx" })
			await fs.writeFile(failedPath, "before failure\n", { flag: "wx" })
			await fs.writeFile(
				scriptPath,
				`const fs = require("node:fs")\nconst mode = process.argv[2]\nif (mode === "success") fs.writeFileSync(${JSON.stringify(successName)}, "after success\\n")\nelse if (mode === "failure") { fs.writeFileSync(${JSON.stringify(failedName)}, "after failure\\n"); process.exitCode = 1 }\nelse throw new Error("Unexpected mode")\n`,
				{ flag: "wx" },
			)
			const taskId = await api.startNewTask({
				text: "Run the command file diff fixture.",
				configuration: {
					...originalConfiguration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					approvalMode: "auto",
					allowedCommands: ["*"],
					deniedCommands: [],
					terminalShellIntegrationDisabled: true,
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(
				() => {
					const task = scripted.task
					if (task) assert.equal(task.abort, false, "The command task must not abort")
					acknowledgeCompletion(task)
					return task?.didComplete === true
				},
				{ description: "both command edits and the completed task", timeout: 90_000 },
			)
			const task = scripted.task
			assert.ok(task)
			await task.waitForTermination()
			assert.equal(scripted.requests, 3)
			assert.equal(await fs.readFile(successPath, "utf8"), "after success\n")
			assert.equal(await fs.readFile(failedPath, "utf8"), "after failure\n")
			const evidence = task.getCommandExecutionEvidence()
			assert.equal(evidence.find((item) => item.toolCallId === "command-diff-success")?.exitCode, 0)
			assert.equal(evidence.find((item) => item.toolCallId === "command-diff-failed")?.exitCode, 1)

			const assertDiffs = (messages: AlphaMessage[]) => {
				const diffs = commandDiffs(messages)
				assert.equal(diffs.length, 1, "The nonzero command edit must not become a completed diff")
				assert.deepEqual(
					{
						tool: diffs[0]!.tool,
						path: diffs[0]!.path,
						diffStats: diffs[0]!.diffStats,
						originalContent: diffs[0]!.originalContent,
						finalContent: diffs[0]!.finalContent,
						changeStatus: diffs[0]!.changeStatus,
					},
					{
						tool: "appliedDiff",
						path: successName,
						diffStats: { added: 1, removed: 1 },
						originalContent: "before success\n",
						finalContent: "after success\n",
						changeStatus: "applied",
					},
				)
				assert.match(diffs[0]!.diff, /-before success/)
				assert.match(diffs[0]!.diff, /\+after success/)
				assert.ok(diffs[0]!.commandExecutionId, "The diff must identify its settled command")
			}
			assertDiffs(task.clineMessages)
			const { uiMessagesFilePath } = await host.getTaskWithId(taskId)
			const persisted = JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8")) as AlphaMessage[]
			assertDiffs(persisted)

			await api.clearCurrentTask()
			await host.showTaskWithId(taskId)
			await waitFor(
				() => {
					const reopened = host.getLiveTask(taskId)
					return (
						reopened !== undefined && reopened !== task && commandDiffs(reopened.clineMessages).length > 0
					)
				},
				{
					description: "the persisted command diff to hydrate in the reopened task",
					timeout: 10_000,
					onTimeout: async () => ({
						persistedDiffCount: commandDiffs(
							JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8")) as AlphaMessage[],
						).length,
						reopenedMessageCount: host.getLiveTask(taskId)?.clineMessages.length,
					}),
				},
			)
			const reopened = host.getLiveTask(taskId)
			assert.ok(reopened)
			assertDiffs(reopened.clineMessages)
		}, [
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
			() => fs.rm(scriptPath, { force: true }),
			() => fs.rm(successPath, { force: true }),
			() => fs.rm(failedPath, { force: true }),
		])
	})
})
