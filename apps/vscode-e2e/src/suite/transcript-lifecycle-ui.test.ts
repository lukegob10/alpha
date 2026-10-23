import * as assert from "node:assert/strict"
import * as vscode from "vscode"
import type { AlphaMessage, ExtensionMessage } from "@alpha-code/types"

import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { SELECTION_LAYOUT_ROUNDS, selectionLayoutStage } from "../ui/renderedSelectionLayout"
import { waitFor } from "./utils"

interface TranscriptTask {
	didComplete: boolean
	clineMessages: AlphaMessage[]
	overwriteAlphaMessages(messages: AlphaMessage[]): Promise<void>
}

interface TranscriptHost {
	getLiveTask(taskId: string): TranscriptTask | undefined
	postStateToWebview(): Promise<void>
	postMessageToWebview(message: ExtensionMessage): Promise<void>
	condenseTaskContext(taskId: string): Promise<void>
}

/** Gates let the renderer observe actual task and compaction transitions without timing sleeps. */
class TranscriptLifecycleAI {
	readonly id = "transcript-lifecycle-ui"
	mainRequests = 0
	summaryRequests = 0
	removeFromCache?: () => void
	private releaseMain?: () => void
	private mainGate?: Promise<void>
	private releaseSummary?: () => void

	holdMain(): void {
		this.mainGate = new Promise<void>((resolve) => {
			this.releaseMain = resolve
		})
	}

	continueMain(): void {
		this.releaseMain?.()
	}

	continueSummary(): void {
		this.releaseSummary?.()
	}

	async *createMessage(systemPrompt: string, _messages: unknown[], metadata?: { attemptId?: string }) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Transcript lifecycle fixture" }
			return
		}
		if (systemPrompt.includes("tasked with summarizing conversations")) {
			this.summaryRequests++
			await new Promise<void>((resolve) => {
				this.releaseSummary = resolve
			})
			yield { type: "text" as const, text: `Summary ${this.summaryRequests}: the fixture answer is 42.` }
			return
		}
		this.mainRequests++
		await this.mainGate
		this.mainGate = undefined
		yield {
			type: "text" as const,
			text: `The fixture answer is 42. Turn ${this.mainRequests}.\n\n${"ARCHIVE_EVIDENCE ".repeat(1_000)}`,
		}
	}

	getModel() {
		return { id: this.id, info: { contextWindow: 200_000, maxTokens: 4096, supportsPromptCache: false } }
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((total, block) => total + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

suite("Transcript lifecycle renderer", function () {
	this.timeout(300_000)

	test("keeps a restored growing transcript mounted through compaction and hide/reveal", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.ok(process.env.ALPHA_UI_ACCEPTANCE_NONCE)
		const api = globalThis.api
		const original = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: TranscriptHost }).sidebarProvider
		const model = new TranscriptLifecycleAI()
		try {
			const taskId = await api.startNewTask({
				text: "Complete the local transcript lifecycle fixture. The fixture answer is 42.",
				configuration: {
					...original,
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "code",
					approvalMode: "auto",
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
					autoCondenseContext: false,
					postTurnCondenseContextPercent: 0,
				},
			})
			await waitFor(() => host.getLiveTask(taskId)?.didComplete === true, { timeout: 30_000 })
			const task = host.getLiveTask(taskId)
			assert.ok(task)
			let row = 0
			const appendRows = async (count: number) => {
				const timestamp = Math.max(Date.now(), ...task.clineMessages.map((message) => message.ts)) + 1
				const rows: AlphaMessage[] = Array.from({ length: count }, (_, index) => ({
					type: "say",
					say: "text",
					ts: timestamp + index,
					text: `Lifecycle fixture row ${++row}.\n\n\`\`\`typescript\nconst fixtureAnswer = 42\n\`\`\`\n\n${"Preserve the completed project evidence. ".repeat(8)}`,
					partial: false,
				}))
				await task.overwriteAlphaMessages([...task.clineMessages, ...rows])
				await host.postStateToWebview()
			}
			await appendRows(1_200)
			await uiFixtureBarrier("transcript-selected", { version: vscode.version, taskId })
			// The selected task must exist before App hydrates and mounts ChatView, as on a developer refresh.
			await vscode.commands.executeCommand("workbench.action.webview.reloadWebviewAction")
			await uiFixtureBarrier("transcript-hydrated", { version: vscode.version, taskId })
			for (const [index, cycle] of ["one", "two", "three"].entries()) {
				model.holdMain()
				await api.sendMessage(`Continue fixture turn ${index + 2}, retaining the answer 42.`)
				await waitFor(() => model.mainRequests === index + 2, { timeout: 20_000 })
				await appendRows(320)
				await uiFixtureBarrier(`transcript-growing-${cycle}`, { version: vscode.version, taskId })
				model.continueMain()
				await waitFor(() => task.didComplete, { timeout: 30_000 })
				await uiFixtureBarrier(`transcript-compact-${cycle}`, { version: vscode.version, taskId })
				// Automatic compaction projects the same start event while the task continues independently.
				await host.postMessageToWebview({ type: "condenseTaskContextStarted", text: taskId })
				const compacting = host.condenseTaskContext(taskId)
				void compacting.catch(() => undefined)
				await waitFor(() => model.summaryRequests === index + 1, { timeout: 20_000 })
				await uiFixtureBarrier(`transcript-busy-${cycle}`, { version: vscode.version, taskId })
				if (cycle === "two") {
					await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility")
					await appendRows(320)
					await uiFixtureBarrier("transcript-hidden", { version: vscode.version, taskId })
					await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
					await uiFixtureBarrier("transcript-revealed", { version: vscode.version, taskId })
				}
				model.continueSummary()
				await compacting
				await waitFor(
					() =>
						task.clineMessages.filter((message) => message.contextCondense?.condenseId).length ===
						index + 1,
					{ timeout: 30_000, description: "a real compaction receipt" },
				)
				await host.postStateToWebview()
				await uiFixtureBarrier(`transcript-compacted-${cycle}`, { version: vscode.version, taskId })
			}
			await uiFixtureBarrier("transcript-browse", { version: vscode.version, taskId })
			await appendRows(40)
			await uiFixtureBarrier("transcript-browse-appended", { version: vscode.version, taskId })
			for (let round = 0; round < SELECTION_LAYOUT_ROUNDS; round++) {
				await uiFixtureBarrier(selectionLayoutStage("before", round), { version: vscode.version, taskId })
				if (round % 2 === 0) {
					// Following output evicts the selected oldest mounted row through the real transcript hook.
					await appendRows(4)
				} else {
					const messages = [...task.clineMessages]
					const last = messages.at(-1)!
					const partial = round % 4 === 1
					const fence = "```"
					messages[messages.length - 1] = {
						...last,
						text: `${fence}typescript\n${`const selectionFixture = ${round}\n`.repeat(50)}${partial ? "" : fence}`,
						partial,
					}
					await task.overwriteAlphaMessages(messages)
					await host.postStateToWebview()
				}
				await uiFixtureBarrier(selectionLayoutStage("after", round), { version: vscode.version, taskId })
			}
			// Native trace completion is asynchronous; keep the owned host alive until the driver collects it.
			await uiFixtureBarrier("selection-layout-finished", { version: vscode.version, taskId })
			assert.equal(model.mainRequests, 4)
			assert.equal(model.summaryRequests, 3)
		} finally {
			model.continueMain()
			model.continueSummary()
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
			model.removeFromCache?.()
		}
	})
})
