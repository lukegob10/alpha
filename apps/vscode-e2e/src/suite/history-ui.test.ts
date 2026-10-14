import * as assert from "node:assert/strict"
import * as vscode from "vscode"
import type { HistoryItem } from "@alpha-code/types"
import type { AlphaMessage } from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface HistoryFixtureHost {
	updateTaskHistory(item: HistoryItem, options: { broadcast: boolean }): Promise<unknown>
	postStateToWebview(): Promise<void>
}

interface NavigationFixtureTask {
	abort: boolean
	didComplete: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	waitForTermination(): Promise<void>
	overwriteAlphaMessages(messages: AlphaMessage[]): Promise<void>
}

interface NavigationFixtureHost extends HistoryFixtureHost {
	getLiveTask(taskId: string): NavigationFixtureTask | undefined
}

class HistoryNavigationAI {
	readonly id = "history-ui-navigation"
	removeFromCache?: () => void

	async *createMessage() {
		yield { type: "text" as const, text: "The rendered navigation fixture is ready." }
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

const SYNTHETIC_TRANSCRIPT_MESSAGES = 1_200
const TRANSCRIPT_SENTINEL = "history-ui-navigation-transcript-sentinel"

suite("Inline Chats rendered history", function () {
	this.timeout(240_000)
	test("retains the composer and searchable history across host themes", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, process.env.ALPHA_UI_EXPECTED_VSCODE_VERSION ?? "1.125.0")
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const provider = (api as unknown as { sidebarProvider: NavigationFixtureHost }).sidebarProvider
		await globalThis.api.setConfiguration({
			apiProvider: "openai",
			openAiApiKey: "local-fixture",
			openAiModelId: "fixture",
		})
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspace)
		await provider.updateTaskHistory(
			{
				id: "history-foreign-project",
				task: "Foreign project history must stay hidden",
				ts: Date.now(),
				number: 100,
				tokensIn: 10,
				tokensOut: 5,
				totalCost: 0,
				workspace: `${workspace}-other`,
			},
			{ broadcast: false },
		)
		const titles = [
			"hello world and test launch 2 subagents but just close them",
			"hello world",
			"Investigate and fix scroll bar issue",
			"Review workspace cancellation handling",
			"Can you clean out the docs folder and keep the useful guides?",
		]
		for (let index = 0; index < 40; index++) {
			await provider.updateTaskHistory(
				{
					id: `history-visual-${index}`,
					task: `${titles[index % titles.length]}${index > 4 ? ` (${index})` : ""}`,
					ts: Date.now() - (index + 1) * 86_400_000,
					number: index + 1,
					tokensIn: 10,
					tokensOut: 5,
					totalCost: 0,
					workspace,
				},
				{ broadcast: false },
			)
			if (index === 2) {
				await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
				await provider.postStateToWebview()
				await uiFixtureBarrier("chats-small", { version: vscode.version })
			}
		}
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await provider.postStateToWebview()
		for (const [stage, theme] of [
			["chats-dark", "Default Dark Modern"],
			["chats-light", "Default Light Modern"],
			["chats-contrast", "Default High Contrast"],
		] as const) {
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", theme, vscode.ConfigurationTarget.Global)
			await uiFixtureBarrier(stage, { version: vscode.version })
		}

		const navigationAI = new HistoryNavigationAI()
		try {
			const taskId = await api.startNewTask({
				text: "Create a completed task for the renderer navigation fixture.",
				configuration: {
					...originalConfiguration,
					apiProvider: "fake-ai",
					fakeAi: navigationAI,
					mode: "code",
					approvalMode: "auto",
					allowedCommands: [],
					deniedCommands: [],
					terminalShellIntegrationDisabled: true,
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(() => provider.getLiveTask(taskId)?.didComplete === true, {
				description: "the navigation fixture to finalize completion",
				timeout: 30_000,
			})
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.abort, false)

			const syntheticMessages: AlphaMessage[] = Array.from(
				{ length: SYNTHETIC_TRANSCRIPT_MESSAGES },
				(_, index) => ({
					type: "say",
					say: "text",
					ts: Date.now() + index + 1,
					text:
						index === SYNTHETIC_TRANSCRIPT_MESSAGES - 1
							? TRANSCRIPT_SENTINEL
							: `Transcript renderer fixture row ${String(index).padStart(4, "0")}. This persisted row exercises task reopening with a long transcript.`,
					partial: true,
				}),
			)
			await task.overwriteAlphaMessages([...task.clineMessages, ...syntheticMessages])
			await provider.postStateToWebview()
			await uiFixtureBarrier("navigation-ready", {
				version: vscode.version,
				taskId,
				expectedVisibleMessages: SYNTHETIC_TRANSCRIPT_MESSAGES,
				persistedTranscriptMessages: task.clineMessages.length,
				sentinel: TRANSCRIPT_SENTINEL,
			})

			await vscode.commands.executeCommand("alpha.plusButtonClicked")
			await uiFixtureBarrier("navigation-new-chat", { version: vscode.version, taskId })
			await waitFor(() => task.didComplete, {
				description: "the long transcript task is finalized before a cold reopen",
				timeout: 10_000,
			})
			await task.waitForTermination()
			await api.clearCurrentTask()
			assert.equal(provider.getLiveTask(taskId), undefined, "Cold reopen must begin without an in-memory Task")
			await uiFixtureBarrier("navigation-reopen-ready", { version: vscode.version, taskId })
		} finally {
			await api.clearCurrentTask().catch(() => undefined)
			navigationAI.removeFromCache?.()
			await api.setConfiguration(originalConfiguration)
		}
	})
})
