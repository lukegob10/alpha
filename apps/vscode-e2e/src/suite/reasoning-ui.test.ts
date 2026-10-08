import * as assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	type ProviderSettings,
	type TaskReasoningProjection,
	type CreateTaskOptions,
} from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface ReasoningTask {
	taskId: string
	apiConfiguration: ProviderSettings
	taskAsk?: { ask: string }
	approveAsk(): void
	getReasoningState(): TaskReasoningProjection
	updateApiConfiguration(configuration: ProviderSettings): void
	messageQueueService: { messages: Array<{ text: string }> }
}
interface ReasoningHost {
	viewLaunched: boolean
	upsertProviderProfile(name: string, configuration: ProviderSettings): Promise<unknown>
	activateProviderProfile(args: { name: string }): Promise<unknown>
	providerSettingsManager: { getProfile(args: { name: string }): Promise<unknown>; listConfig(): Promise<unknown[]> }
	getLiveTask(id: string): ReasoningTask | undefined
	showTaskWithId(id: string): Promise<void>
	postStateToWebview(): Promise<void>
	getActiveTaskId(): string | undefined
	createTask(text: string, images?: string[], parent?: undefined, options?: CreateTaskOptions): Promise<ReasoningTask>
	removeTaskFromStack(options: { taskId: string }): Promise<void>
}

suite("Rendered reasoning controls", function () {
	this.timeout(300_000)
	test("uses acknowledged reasoning and scoped Windows hotkeys without saving a profile", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.125.0")
		const provider = (globalThis.api as unknown as { sidebarProvider: ReasoningHost }).sidebarProvider
		const requests: Array<{ model: string; reasoning_effort?: string }> = []
		const requestMessages: string[] = []
		let heldResponse: ServerResponse | undefined
		let heldRequestCancelled = false
		const createdTaskIds: string[] = []
		const server = createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = []
				for await (const chunk of request) chunks.push(Buffer.from(chunk))
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
				requests.push({ model: body.model, reasoning_effort: body.reasoning_effort })
				const messages = JSON.stringify(body.messages)
				requestMessages.push(messages)
				if (
					messages.includes("Windows steering fixture") &&
					!messages.includes("Windows steering instruction")
				) {
					heldResponse = response
					response.once("close", () => {
						heldRequestCancelled = true
					})
					return
				}
				const approval = messages.includes("Windows approval fixture")
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
								message: approval
									? {
											role: "assistant",
											content: null,
											tool_calls: [
												{
													id: "windows-hotkey-approval",
													type: "function",
													function: {
														name: "exec_command",
														arguments: JSON.stringify({ cmd: "git --version" }),
													},
												},
											],
										}
									: { role: "assistant", content: "The deterministic fixture is complete." },
								finish_reason: approval ? "tool_calls" : "stop",
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
			openAiModelId: "gpt-6-luna",
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
		const alternateConfiguration: ProviderSettings = {
			...configuration,
			openAiModelId: "gpt-5.6-luna",
			openAiCustomModelInfo: {
				contextWindow: 128_000,
				maxTokens: 4096,
				supportsPromptCache: false,
				supportsReasoningEffort: ["low", "high"],
				reasoningEffort: "low",
			},
		}
		let completions = 0
		const completed = () => {
			completions++
		}
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, completed)
		try {
			await provider.upsertProviderProfile("GPT 6 Luna", configuration)
			await provider.upsertProviderProfile("GPT 5.6 Luna", alternateConfiguration)
			await provider.activateProviderProfile({ name: "GPT 6 Luna" })
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
			const profile = await provider.providerSettingsManager.getProfile({ name: "GPT 6 Luna" })
			const count = (await provider.providerSettingsManager.listConfig()).length
			const before = globalThis.api.getConfiguration()
			await uiFixtureBarrier("reasoning-high", { version: vscode.version })
			await uiFixtureBarrier("reasoning-model-switch", { version: vscode.version, maxDurationMs: 5000 })
			await acceptCompletion(2)
			assert.equal(requests.length, 2)
			assert.deepEqual(requests[1], { model: "gpt-5.6-luna", reasoning_effort: "high" })
			assert.deepEqual(await provider.providerSettingsManager.getProfile({ name: "GPT 6 Luna" }), profile)
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
			if (process.platform === "win32") {
				const createFixture = async (text: string) => {
					const task = await provider.createTask(text, undefined, undefined, {
						preserveExisting: true,
						apiConfiguration: configuration,
						taskApprovalMode: "ask",
						enableCheckpoints: false,
					})
					createdTaskIds.push(task.taskId)
					return task
				}
				const steering = await createFixture("Windows steering fixture: wait for direction.")
				await waitFor(() => !!heldResponse, { description: "held steering request" })
				await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
				await provider.postStateToWebview()
				const beforeQueue = requests.length
				await uiFixtureBarrier("hotkeys-queue")
				await waitFor(() =>
					steering.messageQueueService.messages.some((m) => m.text.includes("Windows queue instruction")),
				)
				assert.equal(requests.length, beforeQueue, "Enter must queue without interrupting the held turn")
				assert.equal(heldRequestCancelled, false)
				await uiFixtureBarrier("hotkeys-steer")
				await waitFor(() => requestMessages.some((m) => m.includes("Windows steering instruction")), {
					description: "steered guidance on the next model request",
				})
				assert.equal(heldRequestCancelled, true, "Steering must cancel the previous model request")
				await waitFor(() => completions >= 3 || steering.taskAsk?.ask === "completion_result")
				if (completions < 3) steering.approveAsk()
				await waitFor(() => completions >= 3)
				assert.ok(
					requestMessages.some(
						(m) => m.includes("Windows steering instruction") && m.includes("Windows queue instruction"),
					),
					"Previously queued input must reach the model before task completion",
				)
				await uiFixtureBarrier("hotkeys-previous")
				await waitFor(() => provider.getActiveTaskId() === taskId)
				assert.equal(editor.getActiveTaskId(), taskId, "Sidebar navigation must preserve the editor selection")
				await uiFixtureBarrier("hotkeys-next")
				await waitFor(() => provider.getActiveTaskId() === steering.taskId)
				const approval = await createFixture("Windows approval fixture: request command approval.")
				await waitFor(() => approval.taskAsk?.ask === "command", { description: "pending command approval" })
				await provider.showTaskWithId(steering.taskId)
				await uiFixtureBarrier("hotkeys-attention")
				await waitFor(() => provider.getActiveTaskId() === approval.taskId)
				assert.equal(approval.taskAsk?.ask, "command", "Navigation must not approve the command")
				await uiFixtureBarrier("hotkeys-new")
				await waitFor(() => provider.getActiveTaskId() === undefined)
				assert.ok(provider.getLiveTask(approval.taskId), "New task must preserve the pending task")
				await uiFixtureBarrier("hotkeys-editor-next")
				await waitFor(() => editor.getActiveTaskId() === steering.taskId)
				assert.equal(provider.getActiveTaskId(), undefined, "Editor navigation must preserve the sidebar draft")
				await uiFixtureBarrier("hotkeys-editor-previous")
				await waitFor(() => editor.getActiveTaskId() === taskId)
			}
		} finally {
			globalThis.api.off(AlphaCodeEventName.TaskCompleted, completed)
			for (const id of createdTaskIds) await provider.removeTaskFromStack({ taskId: id }).catch(() => undefined)
			await globalThis.api.clearCurrentTask().catch(() => undefined)
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
