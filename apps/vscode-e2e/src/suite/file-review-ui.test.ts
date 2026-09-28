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
		assert.equal(vscode.version, "1.122.1")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const suffix = randomUUID()
		const scriptName = `alpha-file-review-${suffix}.cjs`
		const fileName = `alpha-file-review-${suffix}.txt`
		const scriptPath = path.join(workspace, scriptName)
		const filePath = path.join(workspace, fileName)
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
			await fs.writeFile(filePath, "before review\n", { flag: "wx" })
			await fs.writeFile(
				scriptPath,
				`require("node:fs").writeFileSync(${JSON.stringify(fileName)}, "after review\\n")\n`,
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
			assert.equal(await fs.readFile(filePath, "utf8"), "after review\n")
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
			await uiFixtureBarrier("file-review", { version: vscode.version })
			await waitFor(
				() =>
					vscode.window.tabGroups.all.some((group) =>
						group.tabs.some(
							(tab) =>
								tab.input instanceof vscode.TabInputTextDiff &&
								tab.input.original.scheme === "cline-diff" &&
								tab.input.modified.scheme === "cline-diff" &&
								tab.label.includes("Alpha Diff"),
						),
					),
				{ description: "immutable VS Code diff tab from the rendered Review action", timeout: 15_000 },
			)
		}, [
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
			() => fs.rm(scriptPath, { force: true }),
			() => fs.rm(filePath, { force: true }),
		])
	})
})
