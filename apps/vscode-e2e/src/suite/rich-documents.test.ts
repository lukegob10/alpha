import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import type { ClineMessage, SkillMetadata } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface DocumentTask {
	taskId: string
	clineMessages: ClineMessage[]
	taskAsk?: ClineMessage
	didComplete: boolean
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface DocumentProvider {
	getSkillsManager(): {
		refreshSkills(): Promise<SkillMetadata[]>
		getSkillsForMode(mode: string): SkillMetadata[]
	}
	getLiveTask(id: string): DocumentTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
}

interface ScriptState {
	requests: number
	taskId?: string
	inputs: string[]
	plan: { name: string; arguments: Record<string, unknown> }[]
	link: string
	removeRegistration?: () => void
}

// The fake provider is serialized in configuration. Keep callbacks and observations outside that payload.
const scripts = new WeakMap<object, ScriptState>()
class DocumentScriptedAI {
	readonly id = `rich-document-${randomUUID()}`
	constructor(state: ScriptState) {
		scripts.set(this, state)
	}
	get removeFromCache(): undefined {
		return undefined
	}
	set removeFromCache(value: (() => void) | undefined) {
		scripts.get(this)!.removeRegistration = value
	}
	async *createMessage(system: string, messages: unknown[], metadata?: { taskId?: string }) {
		const state = scripts.get(this)!
		assert.ok(metadata?.taskId)
		state.taskId ??= metadata.taskId
		assert.equal(metadata.taskId, state.taskId, "Revisions must stay in the originating task")
		assert.ok(++state.requests <= 12, "Document fixture exceeded its deterministic request budget")
		state.inputs.push(JSON.stringify({ system, messages }))
		const tool = state.plan.shift()
		if (tool) {
			yield {
				type: "tool_call" as const,
				id: `${this.id}-${state.requests}`,
				name: tool.name,
				arguments: JSON.stringify(tool.arguments),
			}
		} else {
			yield {
				type: "text" as const,
				text: `The fixture spec requires same-file revision. [Open document](${state.link})`,
			}
		}
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

const html = (revision: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="alpha-document" content="1">
<title>Document revision fixture ${revision}</title></head><body><main class="alpha-doc" data-alpha-kit="1">
<h1>Keep revisions in one document</h1><p>This deterministic test spec defines fixture behavior, not production measurements.</p>
<section><h2>Acceptance criteria</h2><ol><li>Open the HTML in Alpha.</li><li>Revise the same source file.</li></ol></section>
<section><h2>Revision evidence</h2><p>Scripted revision ${revision}; no measured performance claims.</p></section>
</main></body></html>`

suite("Rich document authoring through captured task tools", function () {
	this.timeout(180_000)
	for (const source of ["builtin", "project"] as const) {
		test(`${source}: skill load, source write, preview, same-task revision and reopen`, async function () {
			if (process.env.TEST_FILE !== "rich-documents.test") this.skip()
			assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
			assert.equal(vscode.version, "1.122.1")
			const workspace = process.env.ALPHA_E2E_WORKSPACE
			const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
			assert.ok(workspace && artifacts)
			assert.equal(
				await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath),
				await fs.realpath(workspace),
			)
			const extension = vscode.extensions.all.find((item) => item.isActive && item.exports === globalThis.api)
			assert.ok(extension, "Resolve packaged resources from the active extension, never a developer checkout")
			if (process.env.ALPHA_E2E_INSTALLED_EXTENSION_DIR) {
				assert.equal(
					await fs.realpath(extension.extensionPath),
					await fs.realpath(process.env.ALPHA_E2E_INSTALLED_EXTENSION_DIR),
				)
				assert.equal(extension.packageJSON.version, process.env.ALPHA_E2E_INSTALLED_EXTENSION_VERSION)
			}
			const provider = (globalThis.api as unknown as { sidebarProvider: DocumentProvider }).sidebarProvider
			const manager = provider.getSkillsManager()
			const configuration = globalThis.api.getConfiguration()
			const relativeFile = `rich-document-${source}-${randomUUID()}.html`
			const documentPath = path.join(workspace, relativeFile)
			const uri = vscode.Uri.file(documentPath)
			const readDocument = async () => (await fs.readFile(documentPath, "utf8")).replace(/\r\n/g, "\n")
			const documentTabs = () =>
				vscode.window.tabGroups.all
					.flatMap((group) => group.tabs)
					.filter(
						(tab) =>
							tab.input instanceof vscode.TabInputWebview &&
							tab.input.viewType.includes("alpha.htmlDocument"),
					)
			const waitForRevision = async (revision: number) => {
				await waitFor(
					() => documentTabs().some((tab) => tab.label === `Document revision fixture ${revision}`),
					{
						timeout: 15_000,
						description: `document viewer accepted revision ${revision}`,
					},
				)
				assert.equal(documentTabs().length, 1, "The same file must retain one preview panel")
			}
			const overrideDirectory = path.join(workspace, ".alpha", "skills", "rich-documents")
			const overridePath = path.join(overrideDirectory, "SKILL.md")
			const marker = "Fixture project override: preserve semantic HTML and revise the same source."
			let ownsOverride = false
			const state: ScriptState = {
				requests: 0,
				inputs: [],
				plan: [],
				link: `alpha-document://open?uri=${encodeURIComponent(uri.toString())}`,
			}
			const scripted = new DocumentScriptedAI(state)
			await withBoundedFixtureCleanup(async () => {
				await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
				if (source === "project") {
					await fs.mkdir(overrideDirectory, { recursive: true })
					await fs.writeFile(
						overridePath,
						`---\nname: rich-documents\ndescription: Fixture rich document override.\n---\n${marker}\n`,
						{ flag: "wx" },
					)
					ownsOverride = true
				}
				await globalThis.api.setConfiguration({
					...configuration,
					disabledBuiltinSkills: source === "project" ? ["rich-documents"] : [],
				})
				await manager.refreshSkills()
				const selected = manager.getSkillsForMode("code").find((item) => item.name === "rich-documents")
				assert.equal(selected?.source, source)
				assert.ok(selected)
				if (source === "builtin") assert.ok(selected.path.startsWith(extension.extensionPath))
				else assert.equal(await fs.realpath(selected.path), await fs.realpath(overridePath))
				state.plan = [
					{ name: "skill", arguments: { skill: "rich-documents" } },
					{
						name: "read_file",
						arguments: {
							path:
								source === "builtin"
									? path.join(
											extension.extensionPath,
											"webview-ui/build/artifact-kit/v1/reference.md",
										)
									: overridePath,
						},
					},
					{ name: "write_to_file", arguments: { path: relativeFile, content: html(1) } },
				]
				const taskId = await globalThis.api.startNewTask({
					text: "Use the rich-documents skill to create a substantial HTML spec for same-file document revisions. Return a preview link.",
					configuration: {
						...configuration,
						disabledBuiltinSkills: source === "project" ? ["rich-documents"] : [],
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowReadOnlyOutsideWorkspace: true,
						alwaysAllowWrite: true,
						alwaysAllowWriteOutsideWorkspace: false,
						alwaysAllowWriteProtected: false,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				const settle = async (minimumRequests: number) => {
					const acknowledge = createCompletionReviewAcknowledger()
					await waitFor(
						() => {
							const task = provider.getLiveTask(taskId)
							if (task?.taskAsk && !task.taskAsk.partial)
								assert.ok(
									["completion_result", "tool"].includes(task.taskAsk.ask ?? ""),
									`Unexpected task boundary: ${task.taskAsk.ask}`,
								)
							acknowledge(task)
							return state.requests >= minimumRequests && task?.didComplete === true
						},
						{ timeout: 60_000, description: "document task completion" },
					)
					await waitFor(
						async () => {
							const task = provider.getLiveTask(taskId)!
							await task.waitForTermination()
							await task.flushApiConversationHistoryPersistence()
							return true
						},
						{ timeout: 30_000, description: "document task durable settlement" },
					)
				}
				await settle(4)
				assert.equal(await readDocument(), html(1))
				assert.ok(
					state.inputs[1]!.includes(source === "builtin" ? "Rich documents" : marker),
					"The real skill result must reach the provider",
				)
				assert.ok(
					state.inputs[2]!.includes(source === "builtin" ? "data-alpha-chart" : marker),
					"The referenced resource must be read through the real file tool",
				)
				assert.ok(
					provider.getLiveTask(taskId)!.clineMessages.some((message) => message.text?.includes(state.link)),
				)
				assert.ok((await vscode.commands.getCommands(true)).includes("alpha.previewHtmlDocument"))
				await waitForRevision(1)
				assert.equal(
					documentTabs()[0]!.group.viewColumn,
					vscode.ViewColumn.Two,
					"Delivery opens in the right group",
				)
				state.plan = [
					{ name: "read_file", arguments: { path: relativeFile } },
					{
						name: "write_to_file",
						arguments: {
							path: relativeFile,
							content: html(2).replace(
								'name="alpha-document" content="1"',
								'name="alpha-document" content="999"',
							),
						},
					},
				]
				await globalThis.api.sendMessage(
					"Revise the existing document to scripted revision 2; retain its URI and preview link.",
				)
				await settle(7)
				assert.equal(
					await readDocument(),
					html(2).replace('name="alpha-document" content="1"', 'name="alpha-document" content="999"'),
				)
				await vscode.commands.executeCommand("alpha.previewHtmlDocument", uri)
				state.plan = [
					{ name: "read_file", arguments: { path: relativeFile } },
					{ name: "write_to_file", arguments: { path: relativeFile, content: html(3) } },
				]
				await globalThis.api.sendMessage(
					"Correct the unsupported document marker using the shipped contract in the same document. Do not reset this task.",
				)
				await settle(10)
				assert.equal(await readDocument(), html(3))
				await waitForRevision(3)
				await vscode.window.tabGroups.close(documentTabs())
				await vscode.commands.executeCommand("alpha.previewHtmlDocument", uri)
				await waitForRevision(3)
				await provider.getLiveTask(taskId)!.flushApiConversationHistoryPersistence()
				const { taskDirPath } = await provider.getTaskWithId(taskId)
				const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
				const transactions = inspectToolTransactions(history)
				assert.ok(!JSON.stringify(history).includes('"is_error":true'), "All document tool calls must succeed")
				assert.deepEqual(transactions.errors, [])
				assert.equal(transactions.callCount, 7)
				assert.equal(transactions.resultCount, 7)
				await fs.writeFile(
					path.join(artifacts, `rich-documents-${source}.json`),
					JSON.stringify(
						{
							hostVersion: vscode.version,
							source,
							taskId,
							requests: state.requests,
							transactions,
							extensionPath: extension.extensionPath,
							sourceRevisions: [1, "unsupported-version", 3],
							automaticDeliveryOpenedPreview: true,
							previewCommandDispatched: true,
							viewerAcceptedRevisions: [1, 3],
							sameFileRefreshAndReopen: true,
							unverified: [
								"webview DOM refresh",
								"extension reload",
								"visual quality of model-authored documents",
							],
						},
						null,
						2,
					),
					{ flag: "wx" },
				)
				if (source === "project") {
					await fs.unlink(overridePath)
					ownsOverride = false
					await manager.refreshSkills()
					assert.ok(
						!manager.getSkillsForMode("code").some((item) => item.name === "rich-documents"),
						"A removed override must not resurrect a disabled builtin",
					)
				}
			}, [
				async () => {
					await vscode.window.tabGroups.close(documentTabs())
				},
				() => globalThis.api.clearCurrentTask(),
				() => state.removeRegistration?.(),
				async () => {
					if (ownsOverride) await fs.unlink(overridePath)
				},
				() => globalThis.api.setConfiguration(configuration),
				() => manager.refreshSkills(),
			])
		})
	}
})
