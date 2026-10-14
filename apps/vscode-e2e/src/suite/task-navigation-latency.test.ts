import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import type { AlphaMessage } from "@alpha-code/types"

import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface NavigationTask {
	abort: boolean
	didComplete: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	waitForTermination(): Promise<void>
}

interface NavigationHost {
	getActiveTaskId(): string | undefined
	getLiveTask(taskId: string): NavigationTask | undefined
	getTaskWithId(taskId: string): Promise<{ uiMessagesFilePath: string }>
	showTaskWithId(taskId: string): Promise<void>
	startBlankTask(): Promise<void>
}

class NavigationProbeAI {
	readonly id = "navigation-probe"
	removeFromCache?: () => void
	requests = 0

	async *createMessage() {
		const request = this.requests++
		if (request < 12) {
			yield {
				type: "tool_call" as const,
				id: `navigation-command-${request}`,
				name: "exec_command",
				arguments: JSON.stringify({
					cmd: `node -e "console.log('navigation fixture step ${request + 1} completed')"`,
					yield_time_ms: 10_000,
				}),
			}
			return
		}
		assert.equal(request, 12, "The navigation fixture must not need retries")
		yield { type: "text" as const, text: "The multi-step navigation fixture is complete." }
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

suite("Task navigation latency on a completed multi-step task", function () {
	this.timeout(180_000)

	test("records titlebar New Chat, cold reopen, and warm reopen separately", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifactsDir)
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: NavigationHost }).sidebarProvider
		assert.ok(host)
		const scripted = new NavigationProbeAI()

		await withBoundedFixtureCleanup(async () => {
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			const taskId = await api.startNewTask({
				text: "Run the twelve-step navigation fixture and report completion.",
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
			await waitFor(() => host.getLiveTask(taskId)?.didComplete === true, {
				description: "the navigation fixture to finalize completion",
				timeout: 120_000,
			})
			const task = host.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.abort, false)
			assert.equal(scripted.requests, 13)
			const messageCount = task.clineMessages.length

			const beganNewChat = performance.now()
			await vscode.commands.executeCommand("alpha.plusButtonClicked")
			const titlebarNewChatMs = performance.now() - beganNewChat
			assert.equal(host.getActiveTaskId(), undefined)
			await waitFor(() => task.didComplete, { description: "completion accepted by New Chat", timeout: 10_000 })
			await task.waitForTermination()

			await api.clearCurrentTask()
			assert.equal(host.getLiveTask(taskId), undefined, "Cold reopen must not reuse a live Task instance")
			const beganColdReopen = performance.now()
			await host.showTaskWithId(taskId)
			await waitFor(
				() =>
					host
						.getLiveTask(taskId)
						?.clineMessages.some(
							(message) => message.type === "say" && message.say === "completion_result",
						) === true,
				{ description: "completed transcript after cold reopen", timeout: 10_000, interval: 10 },
			)
			const coldReopenMs = performance.now() - beganColdReopen
			assert.equal(host.getActiveTaskId(), taskId)
			const coldReopenedTask = host.getLiveTask(taskId)
			assert.ok(coldReopenedTask, "Cold reopen must construct a Task")

			await host.startBlankTask()
			assert.equal(host.getLiveTask(taskId), coldReopenedTask, "Warm reopen must retain the same live Task")
			const beganWarmReopen = performance.now()
			await host.showTaskWithId(taskId)
			await waitFor(
				() =>
					host
						.getLiveTask(taskId)
						?.clineMessages.some(
							(message) => message.type === "say" && message.say === "completion_result",
						) === true,
				{ description: "completed transcript after warm reopen", timeout: 10_000, interval: 10 },
			)
			const warmReopenMs = performance.now() - beganWarmReopen
			assert.equal(host.getActiveTaskId(), taskId)
			assert.equal(host.getLiveTask(taskId), coldReopenedTask, "Warm reopen must reuse the retained Task")

			const persisted = await host.getTaskWithId(taskId)
			assert.ok((await fs.stat(persisted.uiMessagesFilePath)).size > 0)
			const report = {
				schemaVersion: 1,
				hostVersion: vscode.version,
				provider: "scripted",
				requestCount: scripted.requests,
				messageCount,
				cacheState: {
					beforeColdReopen: "task-object-absent",
					beforeWarmReopen: "same-task-object-retained",
				},
				measurementsMs: { titlebarNewChatMs, coldReopenMs, warmReopenMs },
				measurementBoundary:
					"New Chat command returned; reopened task transcript became available in the extension host; renderer paint is not included",
			}
			await fs.writeFile(
				path.join(artifactsDir, "task-navigation-latency.json"),
				JSON.stringify(report, null, 2),
				{
					flag: "wx",
				},
			)
			console.log(`[task-navigation-latency] ${JSON.stringify(report)}`)
		}, [
			() => api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
		])
	})
})
