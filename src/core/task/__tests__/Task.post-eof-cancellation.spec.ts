import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { ProviderSettings, ToolApprovalRequest } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { digestValue } from "../../agent/StepContext"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { captureEnvironmentDetails } from "../../environment/getEnvironmentDetails"
import { processUserContentMentions } from "../../mentions/processUserContentMentions"
import { readApiMessages } from "../../task-persistence/apiMessages"
import * as apiMessagePersistence from "../../task-persistence/apiMessages"
import { ProviderTranscriptStore, digestProviderTranscript } from "../../task-persistence/ProviderTranscriptStore"
import { TaskGoalStore } from "../../task-persistence/TaskGoalStore"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import { Task } from "../Task"

// Only host presentation and input capture are replaced. The request loop,
// approvals, scheduler, lifecycle journal, and transcript/goal stores remain real.
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
vi.mock("../../integrations/editor/DiffViewProvider", () => ({
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

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

const fixtures: Array<{ task: Task; journal: AgentLifecycleJournal; storage: string; release: () => void }> = []
const callId = "accepted-read"
const opaqueState = "opaque-reasoning+/=\r\n"
const boundaries = [
	"EOF",
	"last usage",
	"provider throw",
	"preview drain",
	"early read tail",
	"finish",
	"apply",
	"reasoning update",
	"UI save",
] as const
type Boundary = (typeof boundaries)[number]

// Test barriers wrap native methods without changing their contracts or effects.
type TaskHooks = {
	updateAlphaMessage: Task["updateAlphaMessage"]
	saveAlphaMessages: Task["saveAlphaMessages"]
	scheduleStreamingPreview: Task["scheduleStreamingPreview"]
	deliverAgentMessages: Task["deliverAgentMessages"]
	maybeWaitForProviderRateLimit: Task["maybeWaitForProviderRateLimit"]
	retrySaveApiConversationHistory: Task["retrySaveApiConversationHistory"]
	summarizeReasoning: Task["summarizeReasoning"]
	appendAgentTurnEvent: Task["appendAgentTurnEvent"]
	drainStreamingPreviews: Task["drainStreamingPreviews"]
	executeCanonicalToolCalls: Task["executeCanonicalToolCalls"]
	applyCanonicalAgentResponse: Task["applyCanonicalAgentResponse"]
	attemptApiRequest: Task["attemptApiRequest"]
}

async function harness(
	boundary: Boundary = "EOF",
	options: { holdReceipt?: boolean; approvedRead?: boolean; throughEngine?: boolean } = {},
) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const storage = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-post-eof-cancellation-"))
	const cwd = path.join(storage, "workspace")
	await fs.mkdir(cwd)
	const taskId = "post-eof-cancellation"
	const journal = await AgentLifecycleJournal.open(taskId, storage)
	const approvalStarted = barrier()
	const releaseApproval = barrier()
	const releaseProvider = barrier()
	const providerEof = barrier()
	const boundaryEntered = barrier()
	const releaseBoundary = barrier()
	const earlyTailSettled = barrier()
	const releaseEarlyTail = barrier()
	const accepted = barrier()
	const receiptEntered = barrier()
	const releaseReceipt = barrier()
	const effectEntered = barrier()
	const releaseEffect = barrier()
	const earlyRead = ["EOF", "last usage", "provider throw", "preview drain", "early read tail"].includes(boundary)
	const effect = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
		if (options.approvedRead) {
			effectEntered.resolve()
			await releaseEffect.promise
			if (callbacks.signal?.aborted) throw new Error("The held approved read was interrupted.")
		}
		callbacks.pushToolResult("effect ran")
	})
	const state = { autoApprovalEnabled: false, alwaysAllowReadOnly: false, allowedCommands: [], customModes: [] }
	const publications: Array<{ type: string; durable: boolean }> = []
	const provider = {
		context: { globalStorageUri: { fsPath: storage } },
		getState: async () => state,
		getValues: () => state,
		getSkillsManager: async () => undefined,
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		replayAgentLifecycle: () => journal.replay(),
		publishAgentLifecycleEvent: async (event: AgentLifecycleEventInput, options?: { durable?: boolean }) => {
			const receipt = await journal.append(event, options)
			publications.push({ type: receipt.event.type, durable: options?.durable === true })
			if (receipt.event.type === "tool_call_accepted") accepted.resolve()
			return { accepted: true, ...receipt }
		},
		settleIndependentTaskWaitReceiptsForParent: vi.fn(async () => undefined),
		getVerificationProgressState: () => ({ stateFingerprint: "post-eof-cancellation" }),
		postStateToWebview: vi.fn(async () => undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => undefined),
		postMessageToWebview: vi.fn(async () => undefined),
		postTaskQueueToWebview: vi.fn(async () => undefined),
		log: vi.fn(),
	}
	const configuration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "gpt-6.1-sol",
		openAiApiKey: "synthetic-test-key",
	}
	const taskOptions = {
		provider: provider as unknown as AlphaProvider,
		apiConfiguration: configuration,
		taskId,
		task: "Inspect safely",
		taskMode: "code",
		taskApiConfigName: "test-profile",
		taskApprovalMode: "ask",
		workspacePath: cwd,
		startTask: false,
		toolApprovalReviewer: async (_request: ToolApprovalRequest, signal: AbortSignal) => {
			expect(signal.aborted).toBe(false)
			approvalStarted.resolve()
			if (options.approvedRead) return { decision: "approve" as const }
			await releaseApproval.promise
			return { decision: "deny" as const }
		},
	} satisfies ConstructorParameters<typeof Task>[0]
	const task = new Task(taskOptions)
	const hooks = task as unknown as TaskHooks
	fixtures.push({
		task,
		journal,
		storage,
		release: () => {
			releaseApproval.resolve()
			releaseProvider.resolve()
			releaseBoundary.resolve()
			releaseEarlyTail.resolve()
			releaseReceipt.resolve()
			releaseEffect.resolve()
		},
	})
	vi.spyOn(task, "say").mockImplementation(async (say, text, _images, partial) => {
		task.clineMessages.push({ ts: task.clineMessages.length + 1, type: "say", say, text, partial })
	})
	vi.spyOn(hooks, "updateAlphaMessage").mockResolvedValue(undefined)
	vi.spyOn(hooks, "saveAlphaMessages").mockResolvedValue(true)
	vi.spyOn(task, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
	vi.spyOn(hooks, "scheduleStreamingPreview").mockImplementation(() => undefined)
	vi.spyOn(hooks, "deliverAgentMessages").mockResolvedValue(undefined)
	vi.spyOn(hooks, "maybeWaitForProviderRateLimit").mockResolvedValue(undefined)
	vi.spyOn(hooks, "retrySaveApiConversationHistory").mockResolvedValue(false)
	vi.spyOn(hooks, "summarizeReasoning").mockImplementation(() => undefined)
	if (options.holdReceipt) {
		const transcript = task["providerTranscriptStore"]
		const commit = transcript.commitAuthoritativeTranscript.bind(transcript)
		let held = false
		vi.spyOn(transcript, "commitAuthoritativeTranscript").mockImplementation(async (...args) => {
			const messages = await readApiMessages({ taskId, globalStoragePath: storage })
			if (
				!held &&
				messages.some(
					(message) =>
						Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"),
				)
			) {
				held = true
				receiptEntered.resolve()
				await releaseReceipt.promise
			}
			return commit(...args)
		})
	}
	vi.mocked(processUserContentMentions).mockImplementation(async ({ userContent }) => ({ content: userContent }))
	vi.mocked(captureEnvironmentDetails).mockResolvedValue({ details: "", commit() {}, release() {} })
	const api: ApiHandler = {
		getModel: () => ({
			id: "gpt-6.1-sol",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async () => 0),
		createMessage: vi.fn(async function* () {}),
		streamCapabilities: { lifecycle: true, cancellation: true },
	}
	task.api = api
	const commandDescriptor: ToolDescriptor = {
		name: "exec_command",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "exec_command",
				description: "An audited read that still requires review",
				parameters: {
					type: "object",
					properties: { cmd: { type: "string" }, workdir: { type: "string" } },
					required: ["cmd"],
				},
			},
		},
		capabilities: {
			concurrency: "serial",
			sideEffects: "workspace",
			controlFlow: false,
			requiresApproval: true,
			parallelCommandRead: true,
		},
		prepareParallelCommand: async (context) => {
			if (!(await context.callbacks.askApproval("command", "git status --short"))) return undefined
			return {
				scope: cwd,
				run: async (approvedCallbacks) => {
					await effect({ ...context, callbacks: { ...context.callbacks, ...approvedCallbacks } })
					return async () => undefined
				},
			}
		},
		execute: effect,
	}
	const descriptor: ToolDescriptor = earlyRead
		? commandDescriptor
		: {
				name: "read_file",
				aliases: [],
				schema: {
					type: "function",
					function: {
						name: "read_file",
						description: "A read awaiting the canonical boundary",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
				capabilities: {
					concurrency: "serial",
					sideEffects: "none",
					controlFlow: false,
					requiresApproval: true,
				},
				execute: effect,
			}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register(descriptor)
	const surface = createTaskToolSurface({
		registry,
		mode: "code",
		applyProfile: false,
		approvalMode: "ask",
		autoApprovalEnabled: false,
		readGrant: { enabled: false, workspaceRoot: cwd, showIgnoredFiles: false },
		execution: { workspaceRoots: [cwd] },
	})
	await task["beginCanonicalLifecycleTurn"]()
	const goalController = task["goalController"]!
	const goal = await goalController.create({ objective: "Inspect safely", tokenBudget: 50 }, "user")
	if (!options.throughEngine)
		task["activeGoalStep"] = {
			controller: goalController,
			goalTaskId: taskId,
			goalId: goal.goalId,
			controlVersion: goal.controlVersion,
			requestGeneration: goalController.getRequestGeneration(),
			eventId: "request-step",
			startedAt: Date.now(),
			accountElapsed: false,
		}
	const appendEvent = task["appendAgentTurnEvent"].bind(task)
	let usageHeld = false
	const events = vi.spyOn(hooks, "appendAgentTurnEvent").mockImplementation(async (...args) => {
		await appendEvent(...args)
		if (boundary === "last usage" && args[0].type === "request_usage" && !usageHeld) {
			usageHeld = true
			boundaryEntered.resolve()
			await releaseBoundary.promise
		}
	})
	const drain = task["drainStreamingPreviews"].bind(task)
	let drainHeld = false
	vi.spyOn(hooks, "drainStreamingPreviews").mockImplementation(async (reason) => {
		await drain(reason)
		if (["preview drain", "early read tail"].includes(boundary) && reason === "stream completion" && !drainHeld) {
			drainHeld = true
			boundaryEntered.resolve()
			if (boundary === "preview drain") await releaseBoundary.promise
		}
	})
	if (boundary === "early read tail") {
		const execute = task["executeCanonicalToolCalls"].bind(task)
		vi.spyOn(hooks, "executeCanonicalToolCalls").mockImplementation(async (...args) => {
			const outcome = await execute(...args)
			if (args[5]?.deferResultCommit) {
				earlyTailSettled.resolve()
				await releaseEarlyTail.promise
			}
			return outcome
		})
	}
	if (boundary === "finish") {
		const finish = AgentResponseAccumulator.prototype.finish
		let held = false
		vi.spyOn(AgentResponseAccumulator.prototype, "finish").mockImplementation(async function (
			this: AgentResponseAccumulator,
			...args
		) {
			const response = await finish.apply(this, args)
			if (!held && response.outcome?.status === "completed") {
				held = true
				boundaryEntered.resolve()
				await releaseBoundary.promise
			}
			return response
		})
	}
	if (boundary === "apply") {
		const apply = task["applyCanonicalAgentResponse"].bind(task)
		let held = false
		vi.spyOn(hooks, "applyCanonicalAgentResponse").mockImplementation(async (response) => {
			await apply(response)
			if (!held && response.outcome?.status === "completed") {
				held = true
				boundaryEntered.resolve()
				await releaseBoundary.promise
			}
		})
	}
	if (boundary === "reasoning update") {
		let held = false
		vi.mocked(task["updateAlphaMessage"]).mockImplementation(async (message) => {
			if (!held && message.say === "reasoning" && !message.partial && task["currentAgentResponse"]) {
				held = true
				boundaryEntered.resolve()
				await releaseBoundary.promise
			}
		})
	}
	if (boundary === "UI save") {
		let held = false
		vi.mocked(task["saveAlphaMessages"]).mockImplementation(async () => {
			if (!held && task["currentAgentResponse"]?.outcome?.status === "completed") {
				held = true
				boundaryEntered.resolve()
				await releaseBoundary.promise
			}
			return true
		})
	}
	const attempt = vi.spyOn(hooks, "attemptApiRequest").mockImplementation(() =>
		(async function* (): AsyncGenerator<ApiStreamChunk> {
			const snapshot = new AgentStepContextBuilder<ApiHandler>().build({
				kind: "agent",
				retryAttempt: 0,
				task: { taskId, cwd },
				mode: { slug: "code" },
				provider: {
					apiProvider: "openai",
					apiProtocol: "openai",
					modelId: "gpt-6.1-sol",
					modelInfo: api.getModel().info,
					options: {},
				},
				instructions: { systemPrompt: "Inspect safely", sources: [] },
				environment: { roots: [cwd], capabilities: [descriptor.name] },
				transcript: {
					messages: task.apiConversationHistory,
					boundary: {
						startIndex: 0,
						endIndex: task.apiConversationHistory.length,
						messageCount: task.apiConversationHistory.length,
						digest: digestValue(task.apiConversationHistory),
					},
				},
				tools: {
					schemas: [descriptor.schema],
					allowedFunctionNames: [descriptor.name],
					parallelToolCalls: false,
					digest: digestValue([descriptor.schema]),
				},
				policy: surface.policy,
				budget: {
					contextWindow: 128_000,
					maxOutputTokens: 4096,
					compaction: { action: "none", attempted: false },
				},
				request: { metadata: { taskId, mode: "code", tools: [descriptor.schema] } },
				handler: api,
			})
			const step = {
				snapshot,
				surface,
				turnId: task["agentTurnId"]!,
				stepId: `${task["agentTurnId"]}:step-1`,
				requestId: "request-one",
				attemptId: "attempt-one",
				createReasoningSummaryHandler: () => api,
				getRequest: () => ({
					systemPrompt: "Inspect safely",
					messages: [],
					metadata: { taskId, mode: "code", tools: [descriptor.schema] },
				}),
				releaseRequest() {},
			}
			task["currentAgentStep"] = step
			task["currentTaskToolSurface"] = surface
			await task["ensureCanonicalLifecycleStepStarted"](step)
			yield { type: "text", text: "Checking.", id: "message-progress", phase: "commentary", outputIndex: 0 }
			yield {
				type: "reasoning",
				text: boundary === "reasoning update" ? "Checking safety." : "",
				encryptedContent: opaqueState,
				id: "reasoning-one",
				summary: [],
				outputIndex: 1,
			}
			yield {
				type: "tool_call",
				id: callId,
				name: descriptor.name,
				arguments: JSON.stringify(earlyRead ? { cmd: "git status --short", workdir: "." } : { path: "a.ts" }),
			}
			yield { type: "tool_call_end", id: callId }
			yield {
				type: "text",
				text: "Ready to inspect.",
				id: "message-final",
				phase: "final_answer",
				outputIndex: 3,
			}
			yield { type: "usage", inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
			await releaseProvider.promise
			providerEof.resolve()
			if (boundary === "EOF") boundaryEntered.resolve()
			if (boundary === "provider throw") {
				boundaryEntered.resolve()
				await releaseBoundary.promise
				throw new Error("Held provider tail rejected after accepted output.")
			}
		})(),
	)
	const input = [{ type: "text" as const, text: "Inspect safely" }]
	const run = options.throughEngine ? task["initiateTaskLoop"](input) : task.runAgentRequests(input)
	// Use the same ownership join as start/resume without running unrelated startup.
	task["ownBackgroundLifecycle"](
		"start",
		run.then(() => undefined),
	)
	void run.catch(() => undefined)
	return {
		task,
		taskId,
		storage,
		journal,
		approvalStarted: approvalStarted.promise,
		providerEof: providerEof.promise,
		boundaryEntered: boundaryEntered.promise,
		releaseBoundary: releaseBoundary.resolve,
		earlyTailSettled: earlyTailSettled.promise,
		releaseEarlyTail: releaseEarlyTail.resolve,
		accepted: accepted.promise,
		receiptEntered: receiptEntered.promise,
		releaseReceipt: releaseReceipt.resolve,
		effectEntered: effectEntered.promise,
		releaseEffect: releaseEffect.resolve,
		earlyRead,
		descriptor,
		makeReplacement: () => {
			const replacement = new Task(taskOptions)
			vi.spyOn(replacement as unknown as TaskHooks, "saveAlphaMessages").mockResolvedValue(true)
			vi.spyOn(replacement, "emitFinalTokenUsageUpdate").mockImplementation(() => undefined)
			fixtures.push({ task: replacement, journal, storage, release: () => undefined })
			return replacement
		},
		releaseProvider: releaseProvider.resolve,
		effect,
		publications,
		attempt,
		events,
		run,
	}
}

afterEach(async () => {
	const owned = fixtures.splice(0)
	for (const fixture of owned) fixture.release()
	for (const fixture of owned) {
		await fixture.task.abortTask(true).catch(() => undefined)
		await fixture.task.waitForTermination().catch(() => undefined)
	}
	for (const journal of new Set(owned.map((fixture) => fixture.journal))) await journal.close()
	for (const storage of new Set(owned.map((fixture) => fixture.storage)))
		await fs.rm(storage, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe("Task cancellation after accepted output reaches EOF", () => {
	it.each(boundaries.flatMap((boundary) => [false, true].map((abandoned) => ({ boundary, abandoned }))))(
		"closes the durable call at $boundary (abandoned=$abandoned)",
		async ({ boundary, abandoned }) => {
			const fixture = await harness(boundary, { holdReceipt: true })
			await Promise.race([
				fixture.earlyRead ? fixture.approvalStarted : fixture.accepted,
				fixture.run.then(() => {
					throw new Error("Request ended before approval")
				}),
			])
			expect(fixture.task.hasPendingToolApprovalRequest()).toBe(fixture.earlyRead)
			expect(
				(await new AgentLifecycleJournal(fixture.taskId, fixture.storage).replay())?.acceptedToolCallIds,
			).toEqual([callId])
			expect(fixture.publications).toContainEqual({ type: "tool_call_accepted", durable: true })
			expect(fixture.task.assistantMessageSavedToHistory).toBe(false)
			fixture.releaseProvider()
			await Promise.race([
				fixture.boundaryEntered,
				fixture.run.then(() => {
					throw new Error("Request ended before the held boundary")
				}),
			])
			if (boundary !== "last usage" && boundary !== "provider throw")
				expect(fixture.task["isStreaming"]).toBe(boundary === "EOF")
			const abort = fixture.task.abortTask(abandoned)
			let terminated = false
			const termination = fixture.task.waitForTermination().then(() => {
				terminated = true
			})
			void termination.catch(() => undefined)
			await Promise.resolve()
			expect(terminated).toBe(false)
			fixture.releaseBoundary()
			if (boundary === "early read tail") {
				await fixture.earlyTailSettled
				expect(terminated).toBe(false)
				expect(fixture.task.assistantMessageSavedToHistory).toBe(false)
				fixture.releaseEarlyTail()
			}
			await Promise.race([
				fixture.receiptEntered,
				termination.then(() => {
					throw new Error("Termination resolved before its held durable receipt")
				}),
			])
			expect(terminated).toBe(false)
			fixture.releaseReceipt()
			await abort
			const result = await fixture.run.catch((error: unknown) => error)
			await termination.catch(() => undefined)
			const messages = await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })
			const store = new ProviderTranscriptStore(fixture.taskId, fixture.storage)
			const reloaded = await store.read()
			expect(reloaded.messages).toEqual(messages)
			expect(reloaded.digest).toBe(digestProviderTranscript(messages))
			expect.soft(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
			expect.soft(result).toMatchObject({ status: "aborted", response: { outcome: { status: "cancelled" } } })
			expect.soft(terminated).toBe(true)
			expect(fixture.task.isCompleted()).toBe(false)
			expect(fixture.effect).not.toHaveBeenCalled()
			expect(fixture.attempt).toHaveBeenCalledOnce()
			const assistant = messages.find((message) => message.role === "assistant")
			expect.soft(assistant?.content).toMatchObject([
				{ type: "text", id: "message-progress", phase: "commentary", text: "Checking.", outputIndex: 0 },
				{ type: "reasoning", id: "reasoning-one", encrypted_content: opaqueState },
				{ type: "tool_use", id: callId, name: fixture.descriptor.name },
				{ type: "text", id: "message-final", phase: "final_answer", text: "Ready to inspect.", outputIndex: 3 },
			])
			expect.soft(messages.at(-1)?.content).toEqual([
				expect.objectContaining({
					type: "tool_result",
					tool_use_id: callId,
					is_error: true,
					content: expect.stringContaining("cancelled"),
				}),
			])
			const lifecycle = await fixture.journal.replay()
			expect.soft(lifecycle?.terminalToolCallIds).toEqual([callId])
			expect(lifecycle?.items.filter((item) => item.type === "tool_result")).toHaveLength(1)
			expect
				.soft(lifecycle?.items.filter((item) => item.type === "tool_result"))
				.toMatchObject([{ toolCallId: callId, status: "cancelled" }])
			expect.soft(lifecycle?.effectStartedToolCallIds).toEqual([])
			if (fixture.earlyRead)
				expect(lifecycle?.items.filter((item) => item.type === "approval")).toMatchObject([
					{ status: "cancelled" },
				])
			expect
				.soft(messages.at(-1)?.content)
				.not.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ content: expect.stringContaining("read completed") }),
					]),
				)
			const usageEvents = fixture.events.mock.calls.filter(([event]) => event.type === "request_usage")
			expect(usageEvents).toHaveLength(1)
			const requestCard = fixture.task.clineMessages.find((message) => message.say === "api_req_started")
			expect
				.soft(JSON.parse(requestCard?.text ?? "{}"))
				.toMatchObject({ tokensIn: 7, tokensOut: 3, cacheReads: 2, cancelReason: "user_cancelled" })
			const goal = await new TaskGoalStore(fixture.storage, fixture.taskId).read()
			expect.soft(goal.usageReceipts).toEqual([expect.objectContaining({ tokens: 8, timeMs: 0 })])
			const receipt = store.getLastCommitReceipt()!
			await store.assertCommitReceipt(receipt)
			await fixture.task.abortTask(abandoned)
			await fixture.task.waitForTermination()
			expect((await store.read()).revision).toBe(receipt.revision)
			expect(await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })).toEqual(
				messages,
			)
			expect((await new TaskGoalStore(fixture.storage, fixture.taskId).read()).usageReceipts).toEqual(
				goal.usageReceipts,
			)
		},
	)

	it("records an unknown outcome for an approved early read interrupted after durable effect start", async () => {
		const fixture = await harness("EOF", { approvedRead: true, holdReceipt: true })
		await Promise.race([
			fixture.effectEntered,
			fixture.run.then(() => {
				throw new Error("Request ended before approved read started")
			}),
		])
		expect(fixture.task.hasPendingToolApprovalRequest()).toBe(false)
		expect((await fixture.journal.replay())?.effectStartedToolCallIds).toEqual([callId])
		expect(fixture.publications).toContainEqual({ type: "tool_effect_started", durable: true })
		fixture.releaseProvider()
		await fixture.boundaryEntered
		const abort = fixture.task.abortTask(true)
		let terminated = false
		const termination = fixture.task.waitForTermination().then(() => {
			terminated = true
		})
		void termination.catch(() => undefined)
		fixture.releaseEffect()
		await fixture.receiptEntered
		expect(terminated).toBe(false)
		fixture.releaseReceipt()
		await abort
		expect(await fixture.run).toMatchObject({ status: "aborted", response: { outcome: { status: "cancelled" } } })
		await termination
		const store = new ProviderTranscriptStore(fixture.taskId, fixture.storage)
		const saved = await store.read()
		expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
		expect(saved.messages.at(-1)?.content).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: callId,
				is_error: true,
				content: expect.stringContaining("outcome is unknown"),
			}),
		])
		expect(JSON.stringify(saved.messages.at(-1)?.content)).not.toMatch(/not executed|read completed|effect ran/)
		const lifecycle = await fixture.journal.replay()
		expect(lifecycle?.items.filter((item) => item.type === "tool_result")).toMatchObject([
			{ toolCallId: callId, status: "indeterminate" },
		])
		expect(lifecycle?.terminalToolCallIds).toEqual([callId])
		expect(fixture.effect).toHaveBeenCalledOnce()
		await store.assertCommitReceipt(store.getLastCommitReceipt()!)
	})

	it("rejects termination and retains a cancelled receipt when its authoritative write fails", async () => {
		const fixture = await harness("EOF")
		await fixture.approvalStarted
		const write = apiMessagePersistence.saveApiMessages
		vi.spyOn(apiMessagePersistence, "saveApiMessages").mockImplementation(async (input) => {
			if (
				input.messages.some(
					(message) =>
						Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"),
				)
			) {
				throw new Error("Injected authoritative terminal receipt write failure.")
			}
			return write(input)
		})
		fixture.releaseProvider()
		await fixture.boundaryEntered
		await fixture.task.abortTask(true)
		await fixture.run.catch(() => undefined)
		await expect(fixture.task.waitForTermination()).rejects.toThrow(/durably|save|write|persist/i)
		const messages = await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
		expect(fixture.task.userMessageContent).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: callId, is_error: true }),
		])
		const pending = structuredClone(fixture.task.userMessageContent)
		await fixture.task.abortTask(true)
		await expect(fixture.task.waitForTermination()).rejects.toThrow(/durably|save|write|persist/i)
		expect(fixture.task.userMessageContent).toEqual(pending)
		expect(fixture.effect).not.toHaveBeenCalled()
		const store = new ProviderTranscriptStore(fixture.taskId, fixture.storage)
		expect((await store.read()).messages).toEqual(messages)
		await store.assertCommitReceipt(store.getLastCommitReceipt()!)
	})

	it.each([false, true])(
		"keeps the new owner's history, turn, and goal intact after finish (Engine=%s)",
		async (throughEngine) => {
			const fixture = await harness("finish", { throughEngine })
			await fixture.accepted
			fixture.releaseProvider()
			await fixture.boundaryEntered
			const replacement = fixture.makeReplacement()
			expect(
				await replacement["addToApiConversationHistory"]({ role: "user", content: "Replacement input" }),
			).toBe(true)
			// Seed the recovery records that a joined handoff would already have
			// written, then begin a real new Task turn before releasing the stale loop.
			const previous = (await fixture.journal.replay())!
			const identity = {
				version: 1 as const,
				taskId: fixture.taskId,
				runId: previous.runId,
				turnId: previous.turnId,
				occurredAt: Date.now(),
			}
			await fixture.journal.append(
				{
					...identity,
					eventId: "replacement-recovery",
					stepId: previous.currentStepId!,
					type: "tool_result_recorded",
					payload: {
						item: {
							itemId: `${previous.currentStepId}:replacement-recovery`,
							stepId: previous.currentStepId!,
							type: "tool_result",
							toolCallId: callId,
							status: "cancelled",
							output: "Recovered before the replacement turn.",
						},
					},
				},
				{ durable: true },
			)
			await fixture.journal.append(
				{
					...identity,
					eventId: "replacement-close",
					type: "turn_terminal",
					payload: { status: "interrupted" },
				},
				{ durable: true },
			)
			await replacement["beginCanonicalLifecycleTurn"]()
			const newTurn = (await fixture.journal.replay())!
			expect(newTurn.turnId).not.toBe(previous.turnId)
			expect(newTurn.runId).not.toBe(previous.runId)
			expect(newTurn.status).toBe("in_progress")
			const saved = await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })
			const goal = await new TaskGoalStore(fixture.storage, fixture.taskId).read()
			const store = new ProviderTranscriptStore(fixture.taskId, fixture.storage)
			await store.read()
			const receipt = store.getLastCommitReceipt()!
			const eventsFile = await fixture.journal.getEventsFilePath()
			const journalBytes = await fs.readFile(eventsFile, "utf8")
			await fixture.task.abortTask(true)
			fixture.releaseBoundary()
			await fixture.run.catch(() => undefined)
			await fixture.task.waitForTermination().catch(() => undefined)
			expect(await readApiMessages({ taskId: fixture.taskId, globalStoragePath: fixture.storage })).toEqual(saved)
			await store.assertCommitReceipt(receipt)
			expect((await store.read()).revision).toBe(receipt.revision)
			expect(await fs.readFile(eventsFile, "utf8")).toBe(journalBytes)
			expect(await fixture.journal.replay()).toEqual(newTurn)
			expect(await new TaskGoalStore(fixture.storage, fixture.taskId).read()).toEqual(goal)
			expect(goal.usageReceipts).toEqual([])
			expect(goal.goal?.tokensUsed).toBe(0)
			expect(fixture.effect).not.toHaveBeenCalled()
		},
	)
})
