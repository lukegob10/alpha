import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { type AlphaCodeSettings, type AlphaMessage, type ExtensionState } from "@alpha-code/types"

import {
	EDITOR_RELOAD_COMPLETION,
	EDITOR_RELOAD_DRAFTS,
	EDITOR_RELOAD_FRESH_INPUT,
	EDITOR_RELOAD_MARKERS,
	EDITOR_RELOAD_MODEL,
	EDITOR_RELOAD_VERSION,
	parseEditorReloadTaskIds,
} from "../scenarios/editorChatReloadFixture"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface EditorTask {
	taskId: string
	didComplete: boolean
	taskAsk?: { ask?: string }
	alphaMessages: AlphaMessage[]
	messageQueueService: {
		ready: Promise<void>
		messages: Array<{ id: string; text: string }>
		addMessageDurably(text: string, images: undefined, id: string): Promise<unknown>
		getClaimedMessageIds(): string[]
		flush(): Promise<void>
	}
	overwriteAlphaMessages(messages: AlphaMessage[]): Promise<boolean>
	overwriteApiConversationHistory(messages: unknown[]): Promise<boolean>
	flushApiConversationHistoryPersistence(): Promise<void>
	waitForTermination(): Promise<void>
}

interface EditorHost {
	renderContext: "sidebar" | "editor"
	viewLaunched: boolean
	view?: vscode.WebviewPanel
	taskHistoryStoreReady: Promise<void>
	getHostProviders(): EditorHost[]
	getActiveTaskId(): string | undefined
	getLiveTask(taskId: string): EditorTask | undefined
	getTaskWithId(taskId: string): Promise<{ historyItem: { id: string } }>
	getStateToPostToWebview(): Promise<ExtensionState>
	postStateToWebview(): Promise<void>
	startBlankTask(): Promise<void>
	restoreEditorTask(taskId: string, isCurrent: () => boolean): Promise<boolean>
	createTask(
		text: string,
		images: undefined,
		parent: undefined,
		options: { startTask: false; preserveExisting: true; apiConfiguration: AlphaCodeSettings },
	): Promise<EditorTask>
	upsertProviderProfile(name: string, configuration: AlphaCodeSettings): Promise<unknown>
	activateProviderProfile(args: { name: string }): Promise<unknown>
	flushGlobalStateWriteThrough(): Promise<void>
}

suite("Native editor chat persistence across owned host processes", function () {
	this.timeout(180_000)
	test("restores two identities and queued drafts without submitting until fresh renderer input", async function () {
		const phase = process.env.ALPHA_EDITOR_RELOAD_PHASE
		if (!phase) return this.skip()
		assert.ok(phase === "seed" || phase === "reopen")
		assert.equal(vscode.version, EDITOR_RELOAD_VERSION)
		assert.equal(process.env.ALPHA_E2E_LAUNCH_KIND, "development-sidecar")
		assert.ok(process.env.ALPHA_UI_ACCEPTANCE_NONCE)
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifacts)
		const baseUrl = new URL(process.env.ALPHA_EDITOR_RELOAD_BASE_URL!)
		assert.equal(baseUrl.protocol, "http:")
		assert.equal(baseUrl.hostname, "127.0.0.1")
		assert.equal(baseUrl.pathname, "/v1")
		const sidebar = (globalThis.api as unknown as { sidebarProvider: EditorHost }).sidebarProvider
		await sidebar.taskHistoryStoreReady
		const editorHosts = () => sidebar.getHostProviders().filter((host) => host.renderContext === "editor")
		const receipt: Record<string, unknown> = {
			schemaVersion: 1,
			phase,
			hostVersion: vscode.version,
			pid: process.pid,
		}

		if (phase === "seed") {
			await vscode.workspace
				.getConfiguration("window")
				.update("restoreWindows", "all", vscode.ConfigurationTarget.Global)
			const configuration: AlphaCodeSettings = {
				apiProvider: "openai",
				openAiBaseUrl: baseUrl.toString().replace(/\/$/, ""),
				openAiApiKey: "local-editor-reload-fixture",
				openAiModelId: EDITOR_RELOAD_MODEL,
				openAiStreamingEnabled: false,
				openAiCustomModelInfo: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false },
				mode: "code",
				approvalMode: "auto",
				autoApprovalEnabled: true,
				alwaysAllowExecute: false,
				alwaysAllowReadOnly: true,
				mcpEnabled: false,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				maxConcurrentTasks: 4,
			}
			await globalThis.api.setConfiguration(configuration)
			await sidebar.upsertProviderProfile("Editor reload fixture", configuration)
			await sidebar.activateProviderProfile({ name: "Editor reload fixture" })
			const taskIds: string[] = []
			for (const [index, marker] of EDITOR_RELOAD_MARKERS.entries()) {
				const editor = await vscode.commands.executeCommand<EditorHost>("alpha.openInNewTab")
				assert.ok(editor?.view)
				editor.view.reveal(index === 0 ? vscode.ViewColumn.One : vscode.ViewColumn.Two)
				await waitFor(() => editor.viewLaunched)
				const task = await editor.createTask(marker, undefined, undefined, {
					startTask: false,
					preserveExisting: true,
					apiConfiguration: configuration,
				})
				assert.equal(await task.overwriteApiConversationHistory([{ role: "user", content: marker }]), true)
				assert.equal(
					await task.overwriteAlphaMessages([{ type: "say", say: "text", ts: Date.now(), text: marker }]),
					true,
				)
				await task.messageQueueService.addMessageDurably(
					EDITOR_RELOAD_DRAFTS[index]!,
					undefined,
					`editor-draft-${index}`,
				)
				await task.messageQueueService.flush()
				await task.flushApiConversationHistoryPersistence()
				assert.equal((await editor.getTaskWithId(task.taskId)).historyItem.id, task.taskId)
				await editor.postStateToWebview()
				taskIds.push(task.taskId)
			}
			assert.equal(editorHosts().length, 2)
			await sidebar.flushGlobalStateWriteThrough()
			await uiFixtureBarrier("seeded", { version: vscode.version, pid: process.pid, taskIds })
			receipt.taskIds = taskIds
			receipt.nativePanelsLeftOpenForNormalShutdown = true
		} else {
			const savedTaskIds = process.env.ALPHA_EDITOR_RELOAD_TASK_IDS
			assert.ok(savedTaskIds)
			const taskIds = parseEditorReloadTaskIds(JSON.parse(savedTaskIds))
			const [firstTaskId, secondTaskId] = taskIds
			await waitFor(
				() =>
					editorHosts().length === 2 &&
					taskIds.every((id) => editorHosts().some((host) => host.getActiveTaskId() === id)),
				{
					description: "VS Code to call both native chat serializers with their persisted identities",
					timeout: 60_000,
				},
			)
			const requireEditor = (taskId: string): EditorHost => {
				const editor = editorHosts().find((host) => host.getActiveTaskId() === taskId)
				assert.ok(editor, "The native serializer must restore the requested editor")
				return editor
			}
			const firstEditor = requireEditor(firstTaskId)
			const secondEditor = requireEditor(secondTaskId)
			const editors = [firstEditor, secondEditor]
			const restoredChats = [
				{
					taskId: firstTaskId,
					editor: firstEditor,
					marker: EDITOR_RELOAD_MARKERS[0],
					draft: EDITOR_RELOAD_DRAFTS[0],
					queueId: "editor-draft-0",
				},
				{
					taskId: secondTaskId,
					editor: secondEditor,
					marker: EDITOR_RELOAD_MARKERS[1],
					draft: EDITOR_RELOAD_DRAFTS[1],
					queueId: "editor-draft-1",
				},
			]
			for (const { taskId, editor, marker, draft, queueId } of restoredChats) {
				await waitFor(() => editor.viewLaunched && editor.getLiveTask(taskId)?.taskAsk?.ask === "resume_task")
				const task: EditorTask | undefined = editor.getLiveTask(taskId)
				assert.ok(task)
				await task.messageQueueService.ready
				assert.deepEqual(
					task.messageQueueService.messages.map(({ id, text }) => ({ id, text })),
					[{ id: queueId, text: draft }],
				)
				assert.deepEqual(task.messageQueueService.getClaimedMessageIds(), [])
				assert.ok(task.alphaMessages.some((message) => message.text === marker))
				assert.equal((await editor.getStateToPostToWebview()).currentView?.type, "task")
			}
			await uiFixtureBarrier("restored", { version: vscode.version, pid: process.pid, taskIds })

			// The real async history join yields before focus, even when its promise is already settled.
			const staleRestore = firstEditor.restoreEditorTask(secondTaskId, () => true)
			const newView = firstEditor.startBlankTask()
			assert.equal(await staleRestore, false)
			await newView
			assert.deepEqual((await firstEditor.getStateToPostToWebview()).currentView, { type: "newTaskDraft" })
			await uiFixtureBarrier("newer-view", { version: vscode.version, pid: process.pid })
			assert.equal(await firstEditor.restoreEditorTask(firstTaskId, () => true), true)
			await firstEditor.postStateToWebview()
			await uiFixtureBarrier("continue-ready", { version: vscode.version, pid: process.pid })
			const first: EditorTask | undefined = firstEditor.getLiveTask(firstTaskId)
			assert.ok(first)
			await waitFor(() => first.didComplete && first.messageQueueService.messages.length === 0, {
				description: "fresh renderer continuation and retained draft to complete",
				timeout: 60_000,
				onTimeout: async () => {
					const detail = {
						currentView: (await firstEditor.getStateToPostToWebview()).currentView,
						didComplete: first.didComplete,
						activeAsk: first.taskAsk?.ask,
						claimedMessageIds: first.messageQueueService.getClaimedMessageIds(),
						queue: first.messageQueueService.messages.map(({ id, text }) => ({
							id,
							retainedDraft: text === EDITOR_RELOAD_DRAFTS[0],
							freshHumanContinuation: text === EDITOR_RELOAD_FRESH_INPUT,
						})),
						transcriptTail: first.alphaMessages.slice(-10).map(({ ts, type, ask, say, partial }) => ({
							ts,
							type,
							ask,
							say,
							partial,
						})),
					}
					await fs.writeFile(
						path.join(artifacts, "editor-continuation-timeout.json"),
						JSON.stringify(detail, null, 2),
						{ flag: "wx" },
					)
					return detail
				},
			})
			await first.waitForTermination()
			assert.ok(first.alphaMessages.some((message) => message.text === EDITOR_RELOAD_COMPLETION))
			assert.equal(secondEditor.getActiveTaskId(), secondTaskId)
			const second: EditorTask | undefined = secondEditor.getLiveTask(secondTaskId)
			assert.ok(second)
			assert.equal(second.messageQueueService.messages[0]?.text, EDITOR_RELOAD_DRAFTS[1])
			await uiFixtureBarrier("completed", { version: vscode.version, pid: process.pid })
			for (const editor of editors) {
				assert.ok(editor.view)
				editor.view.dispose()
			}
			await waitFor(
				() => editorHosts().length === 0 && taskIds.every((id) => sidebar.getLiveTask(id) === undefined),
				{
					description: "editor providers and task lifetimes to be disposed",
				},
			)
			for (const id of taskIds) assert.equal((await sidebar.getTaskWithId(id)).historyItem.id, id)
			Object.assign(receipt, {
				taskIds,
				nativeIdentityRestored: true,
				draftsRetained: true,
				staleRestoreRejected: true,
				cleanupComplete: true,
			})
		}
		await fs.writeFile(path.join(artifacts, "editor-chat-reload.json"), JSON.stringify(receipt, null, 2), {
			flag: "wx",
		})
	})
})
