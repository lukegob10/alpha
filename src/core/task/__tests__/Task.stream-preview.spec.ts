import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { TelemetryService } from "@alpha-code/telemetry"
import type { AlphaMessage, ProviderSettings } from "@alpha-code/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildApiHandler, type ApiHandler } from "../../../api"
import { createApiStreamOutcome, type ApiStream, type ApiStreamChunk } from "../../../api/transform/stream"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { readApiMessages } from "../../task-persistence/apiMessages"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("../../../api", async (original) => ({
	...(await original<typeof import("../../../api")>()),
	buildApiHandler: vi.fn(),
}))
vi.mock("../../ignore/AlphaIgnoreController", () => ({
	AlphaIgnoreController: class {
		async initialize() {}
		dispose() {}
	},
}))
vi.mock("../../protect/AlphaProtectedController", () => ({ AlphaProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose() {}
	},
}))
vi.mock("../../../integrations/editor/DiffViewProvider", () => ({
	DiffViewProvider: class {
		isEditing = false
		async reset() {}
		async revertChanges() {}
	},
}))
vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(async ({ userContent }) => ({ content: userContent })),
}))
vi.mock("../../environment/getEnvironmentDetails", async (original) => ({
	...(await original<typeof import("../../environment/getEnvironmentDetails")>()),
	captureEnvironmentDetails: vi.fn(async () => ({ details: "", commit() {}, release() {} })),
}))
vi.mock("../../agent/CompletionHooks", async (original) => ({
	...(await original<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(() => ({ stop: [], subagentStop: [] })),
}))
vi.mock("../build-tools", async (original) => ({
	...(await original<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

type PreviewScript = (attempt: number, task: Task) => ApiStream
type TaskHooks = {
	getSystemPrompt: Task["getSystemPrompt"]
	deliverAgentMessages: Task["deliverAgentMessages"]
	maybeWaitForProviderRateLimit: Task["maybeWaitForProviderRateLimit"]
	maybeCompactAfterTurn: Task["maybeCompactAfterTurn"]
	appendAgentTurnEvent: Task["appendAgentTurnEvent"]
	flushAgentTurnEvents: Task["flushAgentTurnEvents"]
}

const cleanups: Array<() => Promise<void>> = []
const textRows = (messages: readonly AlphaMessage[]) =>
	messages.filter((message) => message.type === "say" && message.say === "text")

async function harness(script: PreviewScript) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const temporaryRoot = await fs.realpath(os.tmpdir())
	const storage = await fs.mkdtemp(path.join(temporaryRoot, "alpha-stream-preview-"))
	const cwd = path.join(storage, "workspace")
	await fs.mkdir(cwd)
	const taskId = "stream-preview"
	const journal = await AgentLifecycleJournal.open(taskId, storage)
	let task: Task | undefined
	let running: Promise<void> | undefined
	// Task weakly references its provider; the fixture owns it until termination and cleanup finish.
	let provider: AlphaProvider | undefined
	cleanups.push(async () => {
		await task?.abortTask(true).catch(() => undefined)
		await running?.catch(() => undefined)
		await task?.waitForTermination().catch(() => undefined)
		await journal.close()
		expect(path.dirname(path.resolve(storage))).toBe(path.resolve(temporaryRoot))
		expect(path.basename(storage)).toMatch(/^alpha-stream-preview-/)
		await fs.rm(storage, { recursive: true, force: true })
		provider = undefined
	})

	const effectUiSnapshots: AlphaMessage[][] = []
	const effect = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
		effectUiSnapshots.push(await readTaskMessages({ taskId, globalStoragePath: storage, requireExisting: true }))
		callbacks.pushToolResult("fixture effect completed")
	})
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "exec_command",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "exec_command",
				description: "A synthetic serial effect",
				parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
			},
		},
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
		execute: effect,
	})
	const surface = createTaskToolSurface({
		registry,
		mode: "code",
		applyProfile: false,
		approvalMode: "ask",
		autoApprovalEnabled: false,
		readGrant: { enabled: false, workspaceRoot: cwd, showIgnoredFiles: false },
		execution: { workspaceRoots: [cwd] },
	})
	const state = { mode: "code", autoApprovalEnabled: false, autoCondenseContext: false, requestDelaySeconds: 0 }
	provider = {
		context: { globalStorageUri: { fsPath: storage } },
		getState: async () => state,
		getValues: () => state,
		getSkillsManager: async () => undefined,
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		replayAgentLifecycle: () => journal.replay(),
		publishAgentLifecycleEvent: async (input: AgentLifecycleEventInput, options?: { durable?: boolean }) => ({
			accepted: true,
			...(await journal.append(input, options)),
		}),
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		postTaskQueueToWebview: vi.fn(async () => undefined),
		updateTaskHistory: vi.fn(async () => undefined),
		prepareTaskCompletionLifecycle: vi.fn(async () => undefined),
		rollbackTaskCompletionLifecycle: vi.fn(async () => undefined),
		log: vi.fn(),
	} as unknown as AlphaProvider
	let attempts = 0
	const createMessage = vi.fn<ApiHandler["createMessage"]>(async function* () {
		if (!task) throw new Error("The preview fixture task has not been initialized")
		yield* script(++attempts, task)
	})
	const api: ApiHandler = {
		getModel: () => ({
			id: "preview-model",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async () => 0),
		createMessage,
		streamCapabilities: { lifecycle: true, cancellation: true },
		dispose: vi.fn(),
	}
	vi.mocked(buildApiHandler).mockReturnValue(api)
	const configuration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "preview-model",
		openAiApiKey: "synthetic-preview-key",
	}
	task = new Task({
		provider,
		apiConfiguration: configuration,
		taskId,
		task: "Preview the response once.",
		taskMode: "code",
		taskApiConfigName: "preview-fixture",
		taskApprovalMode: "ask",
		toolApprovalReviewer: async () => ({ decision: "approve" }),
		workspacePath: cwd,
		startTask: false,
		enableCheckpoints: false,
		presentationModelCalls: false,
	})
	const currentTask = task
	const hooks = currentTask as unknown as TaskHooks
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockImplementation(async () => ({
		tools: structuredClone([...surface.schemas]),
		allowedFunctionNames: [...surface.allowedFunctionNames],
		surface,
	}))
	vi.spyOn(hooks, "getSystemPrompt").mockResolvedValue("Follow the fixture instructions.")
	vi.spyOn(currentTask, "recordCompletionCandidate").mockImplementation(() => undefined)
	vi.spyOn(currentTask, "waitForCompletionGateDecision").mockResolvedValue({
		allowed: true,
		modelCanResolveRejection: true,
	})
	// Terminal promotion must not hide a preview that remained partial at EOF.
	vi.spyOn(currentTask, "presentCompletionResult").mockResolvedValue(undefined)
	vi.spyOn(currentTask, "finalizeTaskCompletion").mockImplementation(async () => {
		currentTask.markCompleted()
		return true
	})
	for (const method of [
		"deliverAgentMessages",
		"maybeWaitForProviderRateLimit",
		"maybeCompactAfterTurn",
		"appendAgentTurnEvent",
		"flushAgentTurnEvents",
	] as const) {
		vi.spyOn(hooks, method).mockImplementation(async () => undefined)
	}
	return {
		task: currentTask,
		effect,
		effectUiSnapshots,
		createMessage,
		run: () => {
			running = currentTask["ownBackgroundLifecycle"](
				"start",
				currentTask["initiateTaskLoop"]([{ type: "text", text: "Preview the response once." }]),
			)
			return running
		},
		uiHistory: () => readTaskMessages({ taskId, globalStoragePath: storage, requireExisting: true }),
		apiHistory: () => readApiMessages({ taskId, globalStoragePath: storage }),
	}
}

beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
	vi.restoreAllMocks()
})

describe("Task streaming text previews", () => {
	it.each(["complete", "incremental"] as const)(
		"keeps text around a %s tool call distinct and executes its provider ID once",
		async (format) => {
			const callId = "provider_preview_call_01"
			const args = JSON.stringify({ cmd: "fixture command" })
			const fixture = await harness(async function* (attempt, task) {
				if (attempt === 1) {
					yield { type: "text", text: "First. " }
					await task["streamingPreviewQueue"]
					const toolChunks: ApiStreamChunk[] =
						format === "complete"
							? [{ type: "tool_call", id: callId, name: "exec_command", arguments: args }]
							: [
									{ type: "tool_call_start", id: callId, name: "exec_command" },
									{ type: "tool_call_delta", id: callId, delta: args },
									{ type: "tool_call_end", id: callId },
								]
					yield* toolChunks
					yield { type: "text", text: "Second." }
				} else {
					yield { type: "text", text: "Final." }
				}
				await task["streamingPreviewQueue"]
				yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
			})

			await fixture.run()

			expect(fixture.task.isCompleted()).toBe(true)
			expect(fixture.createMessage).toHaveBeenCalledTimes(2)
			expect(fixture.effect).toHaveBeenCalledOnce()
			expect(fixture.effect.mock.calls[0]?.[0].call.id).toBe(callId)
			expect(
				textRows(fixture.effectUiSnapshots[0] ?? []).map(({ text, partial }) => ({ text, partial })),
			).toEqual([
				{ text: "First. ", partial: false },
				{ text: "Second.", partial: false },
			])
			expect(textRows(await fixture.uiHistory()).map(({ text, partial }) => ({ text, partial }))).toEqual([
				{ text: "First. ", partial: false },
				{ text: "Second.", partial: false },
				{ text: "Final.", partial: false },
			])
			const blocks = (await fixture.apiHistory()).flatMap((message) =>
				Array.isArray(message.content) ? message.content : [],
			)
			expect(blocks.filter((block) => block.type === "tool_use" && block.id === callId)).toHaveLength(1)
			expect(blocks.filter((block) => block.type === "tool_result" && block.tool_use_id === callId)).toHaveLength(
				1,
			)
		},
	)

	it("durably closes a text-only preview at EOF without completion promotion", async () => {
		const fixture = await harness(async function* (_attempt, task) {
			yield { type: "text", text: "Finished at EOF." }
			await task["streamingPreviewQueue"]
			yield createApiStreamOutcome({ status: "completed", semanticOutputObserved: true })
		})

		await fixture.run()

		expect(fixture.createMessage).toHaveBeenCalledOnce()
		expect(fixture.effect).not.toHaveBeenCalled()
		expect(textRows(await fixture.uiHistory()).map(({ text, partial }) => ({ text, partial }))).toEqual([
			{ text: "Finished at EOF.", partial: false },
		])
	})
})
