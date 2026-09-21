import * as assert from "node:assert/strict"
import { createServer } from "node:http"
import * as vscode from "vscode"
import { AlphaCodeEventName, type ProviderSettings, type TaskReasoningProjection } from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface ReasoningTask {
	apiConfiguration: ProviderSettings
	taskAsk?: { ask: string }
	approveAsk(): void
	getReasoningState(): TaskReasoningProjection
	updateApiConfiguration(configuration: ProviderSettings): void
}
interface ReasoningHost {
	viewLaunched: boolean
	upsertProviderProfile(name: string, configuration: ProviderSettings): Promise<unknown>
	activateProviderProfile(args: { name: string }): Promise<unknown>
	providerSettingsManager: { getProfile(args: { name: string }): Promise<unknown>; listConfig(): Promise<unknown[]> }
	getLiveTask(id: string): ReasoningTask | undefined
	showTaskWithId(id: string): Promise<void>
	postStateToWebview(): Promise<void>
}

suite("Rendered reasoning controls", function () {
	this.timeout(300_000)
	test("uses the acknowledged composer choice on the wire without saving a profile", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.122.1")
		const provider = (globalThis.api as unknown as { sidebarProvider: ReasoningHost }).sidebarProvider
		const requests: Array<{ model: string; reasoning_effort?: string }> = []
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = []
				for await (const chunk of request) chunks.push(Buffer.from(chunk))
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
				requests.push({ model: body.model, reasoning_effort: body.reasoning_effort })
				response.writeHead(200, { "Content-Type": "application/json" })
				response.end(
					JSON.stringify({
						id: `fixture-${requests.length}`,
						object: "chat.completion",
						created: 1,
						model: body.model,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "The deterministic fixture is complete." },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
					}),
				)
			})().catch(() => {
				response.writeHead(500)
				response.end()
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		assert.ok(address && typeof address !== "string")
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
			openAiApiKey: "local-fixture",
			openAiModelId: "reasoning-fixture",
			openAiStreamingEnabled: false,
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 4096,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "high"],
				reasoningEffort: "low",
			},
			enableReasoningEffort: true,
			reasoningEffort: "low",
		}
		let completions = 0
		const completed = () => {
			completions++
		}
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, completed)
		try {
			await provider.upsertProviderProfile("reasoning-ui-fixture", configuration)
			await provider.activateProviderProfile({ name: "reasoning-ui-fixture" })
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			const taskId = await globalThis.api.startNewTask({
				text: "Complete the first fixture turn.",
				configuration: {
					...configuration,
					mode: "code",
					autoApprovalEnabled: false,
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			const acceptCompletion = async (count: number) => {
				await waitFor(
					() => completions >= count || provider.getLiveTask(taskId)?.taskAsk?.ask === "completion_result",
					{ timeout: 30_000 },
				)
				if (completions < count) provider.getLiveTask(taskId)!.approveAsk()
				await waitFor(() => completions >= count, { timeout: 30_000 })
			}
			await acceptCompletion(1)
			assert.equal(requests[0]?.reasoning_effort, "low")
			const profile = await provider.providerSettingsManager.getProfile({ name: "reasoning-ui-fixture" })
			const count = (await provider.providerSettingsManager.listConfig()).length
			const before = globalThis.api.getConfiguration()
			await uiFixtureBarrier("reasoning-high", { version: vscode.version })
			await acceptCompletion(2)
			assert.equal(requests.length, 2)
			assert.deepEqual(requests[1], { model: "reasoning-fixture", reasoning_effort: "high" })
			assert.deepEqual(
				await provider.providerSettingsManager.getProfile({ name: "reasoning-ui-fixture" }),
				profile,
			)
			assert.equal((await provider.providerSettingsManager.listConfig()).length, count)
			assert.equal(globalThis.api.getConfiguration().mode, before.mode)
			assert.equal(globalThis.api.getConfiguration().autoApprovalEnabled, before.autoApprovalEnabled)
			await globalThis.api.clearCurrentTask()
			await provider.showTaskWithId(taskId)
			assert.deepEqual(provider.getLiveTask(taskId)?.getReasoningState().requested, {
				kind: "effort",
				effort: "high",
			})
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global)
			await uiFixtureBarrier("reasoning-reload")
			provider.getLiveTask(taskId)!.updateApiConfiguration({
				...configuration,
				openAiModelId: "unknown-fixture",
				reasoningEffort: undefined,
				openAiCustomModelInfo: { contextWindow: 128_000, supportsPromptCache: false },
			})
			await provider.postStateToWebview()
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", "Default High Contrast", vscode.ConfigurationTarget.Global)
			await uiFixtureBarrier("reasoning-fallback")
			provider.getLiveTask(taskId)!.updateApiConfiguration(configuration)
			await provider.postStateToWebview()
			const editor = await vscode.commands.executeCommand<ReasoningHost>("alpha.openInNewTab")
			assert.ok(editor)
			await waitFor(() => editor.viewLaunched, { timeout: 15_000 })
			await editor.showTaskWithId(taskId)
			await editor.postStateToWebview()
			await uiFixtureBarrier("reasoning-editor")
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, completed)
			await globalThis.api.clearCurrentTask().catch(() => undefined)
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
