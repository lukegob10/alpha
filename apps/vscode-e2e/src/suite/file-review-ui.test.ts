import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"
import type { AlphaMessage } from "@alpha-code/types"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface ReviewTask {
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
}

interface ReviewHost {
	getLiveTask(taskId: string): ReviewTask | undefined
	showTaskWithId(taskId: string): Promise<void>
}

const observedTasks = new WeakMap<object, ReviewTask>()

function textDiffs(input: unknown): readonly vscode.TabInputTextDiff[] {
	if (input instanceof vscode.TabInputTextDiff) return [input]
	// Exact-host tab projection: VS Code 1.138.0 exposes multi-diff resources as textDiffs on an unknown input.
	if (
		input &&
		typeof input === "object" &&
		"textDiffs" in input &&
		Array.isArray(input.textDiffs) &&
		input.textDiffs.every((diff: unknown) => diff instanceof vscode.TabInputTextDiff)
	) {
		return input.textDiffs
	}
	return []
}

class FileReviewAI {
	readonly id = "file-review-ui-host"
	removeFromCache?: () => void
	requests = 0
	get task(): ReviewTask | undefined {
		return observedTasks.get(this)
	}
	constructor(
		private readonly resolveTask: (taskId: string) => ReviewTask,
		private readonly scriptName: string,
	) {}
	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		observedTasks.set(this, this.resolveTask(metadata.taskId))
		if (this.requests++ === 0) {
			yield {
				type: "tool_call" as const,
				id: "file-review-command",
				name: "exec_command",
				arguments: JSON.stringify({ cmd: `node ${this.scriptName}`, yield_time_ms: 10_000 }),
			}
			return
		}
		assert.equal(this.requests, 2)
		yield { type: "text" as const, text: "The file review fixture is complete." }
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

suite("Rendered file review", function () {
	this.timeout(180_000)
	test("opens the persisted command change from the activity trace and file panel", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const suffix = randomUUID()
		const scriptName = `alpha-file-review-${suffix}.cjs`
		const fileNames = [1, 2, 3].map((index) => `alpha-file-review-${suffix}-${index}.txt`)
		const scriptPath = path.join(workspace, scriptName)
		const filePaths = fileNames.map((fileName) => path.join(workspace, fileName))
		const snapshots = fileNames.map((fileName, index) => ({
			fileName,
			originalContent: `before review ${index + 1}\n`,
			finalContent: `after review ${index + 1}\n`,
			currentContent: `external review edit ${index + 1}\n`,
		}))
		const allTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
		const ownsTab = (tab: vscode.Tab) => {
			const diffs = textDiffs(tab.input)
			return (
				diffs.length > 0 &&
				diffs.every(
					(diff) =>
						diff.original.scheme === "cline-diff" &&
						diff.modified.scheme === "cline-diff" &&
						diff.original.path.includes(suffix) &&
						diff.modified.path.includes(suffix),
				)
			)
		}
		const closeOwnedTabs = async () => {
			const tabs = allTabs().filter(ownsTab)
			if (tabs.length > 0) assert.equal(await vscode.window.tabGroups.close(tabs, true), true)
			await waitFor(() => !allTabs().some(ownsTab), { description: "fixture diff editors to close" })
		}
		const assertSnapshot = async (diff: vscode.TabInputTextDiff, snapshot: (typeof snapshots)[number]) => {
			assert.equal(diff.original.scheme, "cline-diff")
			assert.equal(diff.modified.scheme, "cline-diff")
			assert.ok(diff.original.path.endsWith(`/${snapshot.fileName}/before`))
			assert.ok(diff.modified.path.endsWith(`/${snapshot.fileName}/after`))
			assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), snapshot.originalContent)
			assert.equal((await vscode.workspace.openTextDocument(diff.modified)).getText(), snapshot.finalContent)
		}
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: ReviewHost }).sidebarProvider
		assert.ok(host)
		const scripted = new FileReviewAI((id) => {
			const task = host.getLiveTask(id)
			assert.ok(task)
			return task
		}, scriptName)
		const acknowledgeCompletion = createCompletionReviewAcknowledger()

		await withBoundedFixtureCleanup(async () => {
			for (const snapshot of snapshots) {
				await fs.writeFile(path.join(workspace, snapshot.fileName), snapshot.originalContent, { flag: "wx" })
			}
			await fs.writeFile(
				scriptPath,
				snapshots
					.map(
						(snapshot) =>
							`require("node:fs").writeFileSync(${JSON.stringify(snapshot.fileName)}, ${JSON.stringify(snapshot.finalContent)})`,
					)
					.join("\n"),
				{
					flag: "wx",
				},
			)
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			const taskId = await api.startNewTask({
				text: "Run the file review fixture.",
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
					if (task) assert.equal(task.abort, false)
					acknowledgeCompletion(task)
					return task?.didComplete === true
				},
				{ description: "completed command review task", timeout: 90_000 },
			)
			await scripted.task!.waitForTermination()
			assert.equal(scripted.requests, 2)
			for (const snapshot of snapshots) {
				assert.equal(await fs.readFile(path.join(workspace, snapshot.fileName), "utf8"), snapshot.finalContent)
			}
			await api.clearCurrentTask()
			await host.showTaskWithId(taskId)
			await waitFor(
				() =>
					Boolean(
						host
							.getLiveTask(taskId)
							?.clineMessages.some((message) => message.text?.includes('"appliedDiff"')),
					),
				{
					description: "persisted file change in reopened task",
					timeout: 10_000,
				},
			)
			// Review must use the saved snapshots even when the workspace has changed since the command completed.
			for (const snapshot of snapshots) {
				await fs.writeFile(path.join(workspace, snapshot.fileName), snapshot.currentContent)
			}
			const existingTabs = new Set(allTabs())
			await uiFixtureBarrier("file-review", { version: vscode.version, fileNames })
			const reviewTab = () =>
				allTabs().find(
					(tab) =>
						!existingTabs.has(tab) &&
						ownsTab(tab) &&
						tab.label.startsWith("Alpha Diff") &&
						textDiffs(tab.input).length === snapshots.length,
				)
			await waitFor(() => reviewTab() !== undefined, {
				description: "new native multi-file diff from the rendered Review action",
				timeout: 15_000,
			})
			const multiTab = reviewTab()
			assert.ok(multiTab)
			const diffs = textDiffs(multiTab.input)
			assert.equal(diffs.length, snapshots.length)
			for (const snapshot of snapshots) {
				const diff = diffs.find((candidate) => candidate.modified.path.endsWith(`/${snapshot.fileName}/after`))
				assert.ok(diff, `Review must include ${snapshot.fileName}`)
				await assertSnapshot(diff, snapshot)
			}
			await closeOwnedTabs()

			const requested = snapshots[1]!
			await uiFixtureBarrier("file-review-file", { fileName: requested.fileName })
			const fileTab = () =>
				allTabs().find(
					(tab) =>
						ownsTab(tab) &&
						tab.label === `Alpha Diff: ${requested.fileName}` &&
						tab.input instanceof vscode.TabInputTextDiff &&
						tab.input.modified.path.endsWith(`/${requested.fileName}/after`),
				)
			await waitFor(() => fileTab() !== undefined, {
				description: "new native diff for the requested middle file",
				timeout: 15_000,
			})
			const singleTab = fileTab()
			assert.ok(singleTab?.input instanceof vscode.TabInputTextDiff)
			await assertSnapshot(singleTab.input, requested)
			for (const snapshot of snapshots) {
				assert.equal(
					await fs.readFile(path.join(workspace, snapshot.fileName), "utf8"),
					snapshot.currentContent,
				)
			}
		}, [
			closeOwnedTabs,
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
			() => fs.rm(scriptPath, { force: true }),
			...filePaths.map((filePath) => () => fs.rm(filePath, { force: true })),
		])
	})
})
