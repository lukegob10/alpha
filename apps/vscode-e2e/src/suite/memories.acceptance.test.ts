import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	DEFAULT_MEMORY_SETTINGS,
	type AlphaCodeSettings,
	type MemorySettings,
	type TaskMemoryState,
} from "@alpha-code/types"

import {
	FeatureScriptedAI,
	assertFeatureToolCall,
	assertFeatureToolResult,
	type FeatureRequest,
} from "../scenarios/featureWorkflowFixture"
import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const SUMMARY_MARKER = "ALPHA_MEMORY_CAPTURED_SUMMARY"
const REVISED_MARKER = "ALPHA_MEMORY_REVISED_SUMMARY"
const ROLLOUT_MARKER = "ALPHA_MEMORY_HOST_ROLLOUT"
const WORKSPACE_MARKER = "ALPHA_MEMORY_WORKSPACE_DECOY"
const MEMORY_TOOLS = ["memories_list", "memories_read", "memories_search", "memories_add_ad_hoc_note"]

type HistoryMessage = { role: string; content: unknown }
type LiveTask = {
	taskAsk?: { ask?: string; text?: string }
	memory: TaskMemoryState
	approveAsk(): void
	getMemoryContext(): Promise<string | undefined>
}
type MemoryStore = {
	home: string
	rootPath: string
	writeSummary(text: string): Promise<void>
	writeRolloutSummary(id: string, slug: string, text: string): Promise<string>
	listFiles(): Promise<string[]>
}
type MemoryHost = {
	getMemoryStore(): MemoryStore
	getMemorySettings(): MemorySettings
	resetMemories(): Promise<void>
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[]; historyItem: unknown }>
}

function summary(marker: string): string {
	return `v1
## User Profile
An isolated extension-host acceptance fixture.
## User preferences
${marker}
## General Tips
Use durable evidence only when relevant.
## What's in Memory
See rollout_summaries/e2e_reference.md for the host-local fixture.
`
}

function requestText(request: FeatureRequest): string {
	return `${request.system}\n${JSON.stringify(request.messages)}`
}

function assertMemoryContext(request: FeatureRequest, marker: string): void {
	assert.ok(requestText(request).includes(marker), "The captured memory summary must reach the real provider request")
	for (const tool of MEMORY_TOOLS) assert.ok(request.tools.includes(tool), `${tool} must use the native task surface`)
}

function assertNoMemory(request: FeatureRequest): void {
	assert.ok(!requestText(request).includes(SUMMARY_MARKER), "A new opted-out task must not receive earlier memory")
	assert.ok(!requestText(request).includes(REVISED_MARKER), "A new opted-out task must not read the current store")
	for (const tool of MEMORY_TOOLS) assert.ok(!request.tools.includes(tool), `${tool} must respect the task opt-in`)
}

function resultObject(messages: readonly unknown[], id: string): Record<string, unknown> {
	const result = assertFeatureToolResult(messages, id, { error: false })
	assert.equal(typeof result.content, "string")
	const parsed: unknown = JSON.parse(result.content as string)
	assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed))
	return parsed as Record<string, unknown>
}

suite("Host-local memories acceptance", function () {
	setDefaultSuiteTimeout(this)
	let provider: MemoryHost
	let store: MemoryStore
	let original: AlphaCodeSettings
	let settings: MemorySettings
	let rolloutPath: string
	const models: FeatureScriptedAI[] = []

	setup(async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const alphaHome = process.env.ALPHA_HOME
		assert.ok(alphaHome, "The launcher must isolate Alpha home before extension activation")
		assert.equal(await fs.realpath(path.dirname(alphaHome)), await fs.realpath(os.tmpdir()))
		assert.match(path.basename(alphaHome), /^alpha-vscode-e2e-home-/)
		assert.ok((await fs.lstat(alphaHome)).isDirectory())
		assert.ok(!(await fs.lstat(alphaHome)).isSymbolicLink())
		provider = (globalThis.api as unknown as { sidebarProvider: MemoryHost }).sidebarProvider
		assert.ok(provider)
		store = provider.getMemoryStore()
		// Fail before any reset or write if activation cached a different, potentially real home.
		assert.equal(path.resolve(store.home), path.resolve(alphaHome))
		assert.equal(path.resolve(store.rootPath), path.join(path.resolve(alphaHome), "memories_v2"))
		original = globalThis.api.getConfiguration()
		settings = {
			...DEFAULT_MEMORY_SETTINGS,
			enabled: true,
			useMemories: true,
			generateMemories: false,
			dedicatedTools: true,
		}
		await globalThis.api.setConfiguration({ ...original, memorySettings: settings })
		await provider.resetMemories()
		await store.writeSummary(summary(SUMMARY_MARKER))
		rolloutPath = await store.writeRolloutSummary("e2e", "reference", `${ROLLOUT_MARKER}\nRemembered evidence.\n`)
	})

	teardown(async () => {
		for (const model of models) model.dispose()
		models.length = 0
		await globalThis.api.clearCurrentTask().catch(() => undefined)
		if (original) await globalThis.api.setConfiguration(original)
	})

	async function run(model: FeatureScriptedAI, text: string): Promise<string> {
		models.push(model)
		const api = globalThis.api
		const completed: string[] = []
		const onCompleted = (id: string) => completed.push(id)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...api.getConfiguration(),
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			const id = await api.startNewTask({ configuration, text, presentationModelCalls: false })
			await waitFor(
				() => {
					model.assertHealthy()
					const task = provider.getLiveTask(id)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completed.filter((taskId) => taskId === id).length === 1
				},
				{ timeout: 60_000, description: "the production memory task to complete once" },
			)
			model.assertHealthy()
			return id
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
		}
	}

	test("injects the summary and executes bounded native retrieval with paired history and traversal rejection", async () => {
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		const decoy = path.join(workspace, ...rolloutPath.split("/"))
		await fs.mkdir(path.dirname(decoy), { recursive: true })
		await fs.writeFile(decoy, WORKSPACE_MARKER, { flag: "wx" })
		const calls = [
			{ name: "memories_list", arguments: { max_results: 10 } },
			{ name: "memories_read", arguments: { path: rolloutPath, line_offset: 1, max_lines: 2 } },
			{
				name: "memories_search",
				arguments: { queries: [ROLLOUT_MARKER], path: "rollout_summaries", max_results: 2, context_lines: 0 },
			},
			{ name: "memories_read", arguments: { path: "../outside.md" } },
			{ name: "memories_add_ad_hoc_note", arguments: { note: "Remember this model-authored preference." } },
		]
		const model = new FeatureScriptedAI((request) => {
			assertMemoryContext(request, SUMMARY_MARKER)
			if (request.ordinal === 2) {
				const list = resultObject(request.messages, `${model.id}-1`)
				assert.deepEqual(list.entries, [
					{ path: "memory_summary.md", entry_type: "file" },
					{ path: "rollout_summaries", entry_type: "directory" },
				])
				assert.equal(list.next_cursor, null)
			}
			if (request.ordinal === 3) {
				const read = resultObject(request.messages, `${model.id}-2`)
				assert.equal(read.path, rolloutPath)
				assert.equal(read.start_line_number, 1)
				assert.ok(String(read.content).includes(ROLLOUT_MARKER))
				assert.ok(
					!String(read.content).includes(WORKSPACE_MARKER),
					"Memory paths cannot select workspace files",
				)
			}
			if (request.ordinal === 4) {
				const search = resultObject(request.messages, `${model.id}-3`)
				assert.ok(Array.isArray(search.matches))
				assert.equal(search.matches.length, 1)
				assert.equal((search.matches[0] as Record<string, unknown>).path, rolloutPath)
			}
			if (request.ordinal === 5)
				assertFeatureToolResult(request.messages, `${model.id}-4`, {
					error: true,
					marker: "Invalid relative memory path",
				})
			if (request.ordinal === 6) {
				const denied = assertFeatureToolResult(request.messages, `${model.id}-5`, {
					error: true,
					marker: "exact, explicit human request",
				})
				assert.equal(JSON.parse(String(denied.content)).status, "denied")
			}
			assert.ok(request.ordinal <= 6)
			return calls[request.ordinal - 1]
		})
		const id = await run(
			model,
			"Look up the isolated saved reference and check that invalid memory paths fail safely.",
		)
		assert.equal(model.requests.length, 6)
		const persisted = (await provider.getTaskWithId(id)).apiConversationHistory
		for (const [index, call] of calls.entries()) {
			const callId = `${model.id}-${index + 1}`
			assertFeatureToolCall(persisted, callId, call.name, call.arguments)
			assertFeatureToolResult(persisted, callId, { error: index >= 3 })
		}
		assert.deepEqual(
			await store.listFiles(),
			["memory_summary.md", rolloutPath],
			"An unauthorized note must not write memory",
		)
	})

	test("freezes current context, applies use changes to the next task, and resets memory without deleting conversation", async () => {
		const model = new FeatureScriptedAI(async (request) => {
			assertMemoryContext(request, SUMMARY_MARKER)
			assert.ok(!request.system.includes(REVISED_MARKER), "A running task must retain its first summary snapshot")
			if (request.ordinal === 1) {
				settings = { ...settings, useMemories: false }
				await globalThis.api.setConfiguration({
					...globalThis.api.getConfiguration(),
					memorySettings: settings,
				})
				assert.equal(provider.getMemorySettings().useMemories, false)
				assert.equal(provider.getLiveTask(request.taskId)?.memory.useMemories, true)
				await store.writeSummary(summary(REVISED_MARKER))
				return { name: "memories_read", arguments: { path: rolloutPath, max_lines: 2 } }
			}
			assert.equal(request.ordinal, 2)
			assertFeatureToolResult(request.messages, `${model.id}-1`, { error: false, marker: ROLLOUT_MARKER })
			await provider.resetMemories()
			assert.deepEqual(await store.listFiles(), [])
			const captured = await provider.getLiveTask(request.taskId)?.getMemoryContext()
			assert.ok(captured?.includes(SUMMARY_MARKER))
			assert.ok(!captured?.includes(REVISED_MARKER), "Reset cannot rewrite context already sent to a provider")
			return undefined
		})
		const id = await run(model, "Use the saved reference while I update memory preferences.")
		const persisted = (await provider.getTaskWithId(id)).apiConversationHistory
		assertFeatureToolCall(persisted, `${model.id}-1`, "memories_read", { path: rolloutPath, max_lines: 2 })
		assertFeatureToolResult(persisted, `${model.id}-1`, { error: false, marker: ROLLOUT_MARKER })
		assert.ok(JSON.stringify(persisted).includes("Use the saved reference while I update memory preferences."))
		await store.writeSummary(summary(REVISED_MARKER))
		const optedOut = new FeatureScriptedAI((request) => {
			assertNoMemory(request)
			assert.equal(provider.getLiveTask(request.taskId)?.memory.useMemories, false)
			return undefined
		})
		await run(optedOut, "This new conversation has reading disabled.")
		assert.equal(optedOut.requests.length, 1)
		assert.deepEqual(await store.listFiles(), ["memory_summary.md"], "A read toggle must retain learned files")
	})

	test("global off prevents new memory context and tools while preserving learned files", async () => {
		settings = { ...settings, enabled: false }
		await globalThis.api.setConfiguration({ ...globalThis.api.getConfiguration(), memorySettings: settings })
		const model = new FeatureScriptedAI((request) => {
			assertNoMemory(request)
			assert.equal(provider.getLiveTask(request.taskId)?.memory.useMemories, false)
			return undefined
		})
		await run(model, "Run with the host memory feature disabled.")
		assert.equal(model.requests.length, 1)
		assert.deepEqual(await store.listFiles(), ["memory_summary.md", rolloutPath])
	})
})
