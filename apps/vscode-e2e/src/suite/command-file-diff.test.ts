import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import type { AlphaMessage } from "@alpha-code/types"

import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { updateFilePatch } from "../scenarios/scriptedPatch"
import { waitFor } from "./utils"

interface CommandDiffTask {
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	alphaMessages: AlphaMessage[]
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
const editReadiness = new WeakMap<object, Promise<void>>()

interface FileEditScript {
	fileName: string
	originalContent: string
	finalContent: string
}

class CommandFileDiffAI {
	readonly id = "command-file-diff-host"
	removeFromCache?: () => void
	requests = 0

	get task(): CommandDiffTask | undefined {
		return observedTasks.get(this)
	}

	constructor(
		private readonly resolveTask: (taskId: string) => CommandDiffTask,
		private readonly scriptName: string | FileEditScript,
	) {}

	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string; attemptId?: string }) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Fixture task" }
			return
		}
		assert.ok(metadata?.taskId)
		observedTasks.set(this, this.resolveTask(metadata.taskId))
		const request = this.requests++
		if (typeof this.scriptName !== "string") {
			await editReadiness.get(this)
			if (request === 0) {
				yield {
					type: "tool_call" as const,
					id: "background-file-edit",
					name: "apply_patch",
					arguments: JSON.stringify({
						patch: updateFilePatch(
							this.scriptName.fileName,
							this.scriptName.originalContent,
							this.scriptName.finalContent,
						),
					}),
				}
				return
			}
			assert.equal(request, 1, "The native file edit must not retry or launch a command")
			yield { type: "text" as const, text: "Background file edit fixture complete." }
			return
		}
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
		assert.equal(vscode.version, "1.141.0")
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
			assertDiffs(task.alphaMessages)
			const { uiMessagesFilePath } = await host.getTaskWithId(taskId)
			const persisted = JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8")) as AlphaMessage[]
			assertDiffs(persisted)

			await api.clearCurrentTask()
			await host.showTaskWithId(taskId)
			await waitFor(
				() => {
					const reopened = host.getLiveTask(taskId)
					return (
						reopened !== undefined && reopened !== task && commandDiffs(reopened.alphaMessages).length > 0
					)
				},
				{
					description: "the persisted command diff to hydrate in the reopened task",
					timeout: 10_000,
					onTimeout: async () => ({
						persistedDiffCount: commandDiffs(
							JSON.parse(await fs.readFile(uiMessagesFilePath, "utf8")) as AlphaMessage[],
						).length,
						reopenedMessageCount: host.getLiveTask(taskId)?.alphaMessages.length,
					}),
				},
			)
			const reopened = host.getLiveTask(taskId)
			assert.ok(reopened)
			assertDiffs(reopened.alphaMessages)
		}, [
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
			() => fs.rm(scriptPath, { force: true }),
			() => fs.rm(successPath, { force: true }),
			() => fs.rm(failedPath, { force: true }),
		])
	})

	for (const savedFlag of [false, undefined] as const) {
		test(`keeps approved file edits in the background with saved focus flag ${savedFlag ?? "unset"}`, async () => {
			assert.equal(vscode.version, "1.141.0")
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			const workspace = process.env.ALPHA_E2E_WORKSPACE
			assert.ok(workspace)
			const suffix = randomUUID()
			const targetName = `alpha-background-edit-${suffix}.txt`
			const sentinelName = `alpha-background-sentinel-${suffix}.txt`
			const targetUri = vscode.Uri.file(path.join(workspace, targetName))
			const sentinelUri = vscode.Uri.file(path.join(workspace, sentinelName))
			const originalContent = "before background edit\n"
			const finalContent = "after background edit\n"
			const api = globalThis.api
			const originalConfiguration = api.getConfiguration()
			const host = (api as unknown as { sidebarProvider: CommandDiffHost }).sidebarProvider
			assert.ok(host)
			const scripted = new CommandFileDiffAI(
				(id) => {
					const task = host.getLiveTask(id)
					assert.ok(task)
					return task
				},
				{ fileName: targetName, originalContent, finalContent },
			)
			let releaseEdit!: () => void
			editReadiness.set(
				scripted,
				new Promise<void>((resolve) => {
					releaseEdit = resolve
				}),
			)
			const listeners: vscode.Disposable[] = []
			const allTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
			const isTarget = (uri: vscode.Uri) =>
				uri.toString() === targetUri.toString() || uri.path.endsWith(`/${targetName}`)
			const isTargetTab = (tab: vscode.Tab) => {
				const input = tab.input
				return (
					(input instanceof vscode.TabInputText && isTarget(input.uri)) ||
					(input instanceof vscode.TabInputTextDiff && (isTarget(input.original) || isTarget(input.modified)))
				)
			}
			const acknowledgeCompletion = createCompletionReviewAcknowledger()
			await withBoundedFixtureCleanup(async () => {
				await fs.writeFile(targetUri.fsPath, originalContent, { flag: "wx" })
				await fs.writeFile(sentinelUri.fsPath, "Keep this editor and cursor active.\n", { flag: "wx" })
				const experiments = savedFlag === undefined ? {} : { preventFocusDisruption: savedFlag }
				await api.setConfiguration({ ...originalConfiguration, experiments })
				assert.deepEqual(api.getConfiguration().experiments, experiments)
				await api.startNewTask({
					text: "Apply the approved file edit without opening an editor.",
					presentationModelCalls: false,
					configuration: {
						...originalConfiguration,
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						approvalMode: "ask",
						experiments,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				await waitFor(() => scripted.task !== undefined, { description: "the task-owned native edit request" })
				// Start observing after task startup has focused the sidebar, before the tool can execute.
				const editor = await vscode.window.showTextDocument(sentinelUri, { preview: false })
				editor.selection = new vscode.Selection(0, 3, 0, 7)
				const selection = editor.selection
				const initialTabs = allTabs()
				assert.equal(initialTabs.some(isTargetTab), false)
				const focusChanges: string[] = []
				const openedTargetTabs: vscode.Tab[] = []
				listeners.push(
					vscode.window.onDidChangeActiveTextEditor((active) => {
						focusChanges.push(active?.document.uri.toString() ?? "none")
					}),
					vscode.window.tabGroups.onDidChangeTabs((event) => {
						openedTargetTabs.push(...event.opened.filter(isTargetTab))
					}),
				)
				releaseEdit()
				await waitFor(
					() => {
						const task = scripted.task
						assert.equal(task?.abort, false, "The edit must remain on its owned task")
						const error = task?.alphaMessages.find((message) => message.say === "error")
						assert.equal(error, undefined, error?.text)
						const ask = task?.taskAsk
						return ask?.ask === "tool" && !ask.partial && !ask.isAnswered
					},
					{ description: "the required file-edit approval", timeout: 30_000 },
				)
				const task = scripted.task!
				assert.equal(
					await fs.readFile(targetUri.fsPath, "utf8"),
					originalContent,
					"Approval must precede the write",
				)
				assert.deepEqual(
					openedTargetTabs,
					[],
					"The approval must not automatically open a source or diff editor",
				)
				assert.deepEqual(focusChanges, [])
				assert.equal(vscode.window.activeTextEditor, editor)
				assert.ok(task.taskAsk?.text)
				const approval = JSON.parse(task.taskAsk.text) as Record<string, unknown>
				assert.equal(approval.tool, "appliedDiff")
				assert.equal(approval.path, targetName)
				assert.equal(approval.originalContent, originalContent)
				assert.equal(approval.finalContent, finalContent)
				assert.equal(approval.isOutsideWorkspace, false)
				task.approveAsk()
				await waitFor(
					() => {
						assert.equal(task.abort, false)
						acknowledgeCompletion(task)
						return task.didComplete
					},
					{ description: "the approved background edit to finish", timeout: 60_000 },
				)
				await task.waitForTermination()
				assert.equal(scripted.requests, 2)
				assert.equal((await fs.readFile(targetUri.fsPath, "utf8")).replaceAll("\r\n", "\n"), finalContent)
				assert.deepEqual(task.getCommandExecutionEvidence(), [], "The fixture must use the native file tool")
				assert.deepEqual(openedTargetTabs, [], "Saving must not automatically open the edited file or a diff")
				assert.equal(allTabs().some(isTargetTab), false)
				assert.deepEqual(allTabs(), initialTabs)
				assert.deepEqual(focusChanges, [])
				assert.equal(vscode.window.activeTextEditor, editor)
				assert.ok(editor.selection.isEqual(selection))
				assert.equal(editor.document.getText(), "Keep this editor and cursor active.\n")
			}, [
				() => releaseEdit(),
				() => {
					for (const listener of listeners) listener.dispose()
				},
				() => api.clearCurrentTask(),
				() => scripted.removeFromCache?.(),
				() => api.setConfiguration(originalConfiguration),
				async () => {
					const owned = allTabs().filter(
						(tab) =>
							isTargetTab(tab) ||
							(tab.input instanceof vscode.TabInputText &&
								tab.input.uri.toString() === sentinelUri.toString()),
					)
					if (owned.length) assert.equal(await vscode.window.tabGroups.close(owned, true), true)
				},
				() => fs.rm(targetUri.fsPath, { force: true }),
				() => fs.rm(sentinelUri.fsPath, { force: true }),
			])
		})
	}
})
