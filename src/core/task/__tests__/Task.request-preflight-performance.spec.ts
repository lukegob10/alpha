import * as fs from "fs/promises"
import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { AgentTurnEventLog, type PersistedAgentTurnEvent } from "../../agent/AgentTurnEventLog"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	appendFile: vi.fn(),
}))
vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getTaskDirectoryPath: vi.fn(async () => process.cwd()),
}))
vi.mock("../build-tools", async (importOriginal) => ({
	...(await importOriginal<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

function harness() {
	const startedAt = Date.now()
	const dispatchTimes: number[] = []
	const records: PersistedAgentTurnEvent[] = []
	vi.mocked(fs.appendFile).mockImplementation(async (_file, data) => {
		await new Promise<void>((resolve) => setTimeout(resolve, 25))
		records.push(JSON.parse(String(data)) as PersistedAgentTurnEvent)
	})
	const api = {
		getModel: () => ({
			id: "preflight-model",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: true } as ModelInfo,
		}),
		countTokens: vi.fn(async () => 1),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			dispatchTimes.push(Date.now() - startedAt)
			yield { type: "text", text: "Preflight fixture response" }
		}),
	} satisfies ApiHandler
	const apiConfiguration: ProviderSettings = { apiProvider: "openai", openAiModelId: "preflight-model" }
	const provider = { getState: vi.fn(async () => ({ mode: "code", approvalMode: "ask" })) }
	const log = new AgentTurnEventLog("preflight-performance", process.cwd(), { runId: "fixture-log-run" })
	const cancellation = new AbortController()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "preflight-performance",
		instanceId: "preflight-instance",
		taskKind: "primary",
		taskApprovalMode: "ask",
		workspacePath: process.cwd(),
		abort: false,
		taskCancellationController: cancellation,
		api,
		apiConfiguration,
		effectiveApiConfiguration: { ...apiConfiguration },
		reasoningPreference: { kind: "default" },
		reasoningState: {
			requested: { kind: "default" },
			effective: { kind: "default" },
			capabilities: { kind: "unavailable", canDisable: false },
		},
		reasoningByHandler: new WeakMap(),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: [{ role: "user", content: "Inspect the fixture" }],
		clineMessages: [],
		agentRunId: "fixture-agent-run",
		agentTurnId: "fixture-turn",
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		agentTurnEventLog: log,
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "Fixture system prompt"),
		getCurrentProfileId: vi.fn(async () => "fixture-profile"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => {}),
		publishCanonicalLifecyclePhase: vi.fn(async () => {}),
	}) as Task
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const surface = createTaskToolSurface({ registry, applyProfile: false, approvalMode: "ask" })
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({ tools: [], surface })
	const captureRequest = async () => {
		for await (const _chunk of task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			interruptionSignal: cancellation.signal,
		})) {
			// This fixture exercises provider admission without executing tools.
		}
	}
	return { task, api, log, records, dispatchTimes, captureRequest, cancellation }
}

describe("Task request preflight latency", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("dispatches before optional journal writes while retaining their order, identity, and flush fence", async () => {
		const { task, api, log, records, dispatchTimes, captureRequest } = harness()
		const capture = captureRequest()
		try {
			await vi.advanceTimersByTimeAsync(0)
			expect(api.createMessage).toHaveBeenCalledOnce()
			expect(dispatchTimes).toEqual([0])
			expect(records).toEqual([])
			const metadata = api.createMessage.mock.calls[0][2]!
			// Delayed writes must retain the admitted step even if the live owner moves on.
			Reflect.set(task, "currentAgentStep", undefined)
			let flushed = false
			const flush = log.flush().then(() => (flushed = true))
			await vi.advanceTimersByTimeAsync(49)
			expect(flushed).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			await flush
			expect(records.map(({ sequence, event }) => [sequence, event.type])).toEqual([
				[1, "model_request_started"],
				[2, "policy_snapshot"],
			])
			for (const record of records) {
				expect(record).toMatchObject({
					turnId: "fixture-turn",
					stepId: "fixture-turn:step-1",
					requestId: metadata.requestId,
					attemptId: metadata.attemptId,
				})
			}
		} finally {
			await vi.runAllTimersAsync()
			await capture
			await log.close()
		}
	})

	it.each(["ensureCanonicalLifecycleStepStarted", "publishCanonicalLifecyclePhase"] as const)(
		"still awaits the canonical %s barrier before provider dispatch",
		async (method) => {
			const { task, api, log, captureRequest } = harness()
			const canonical = deferred()
			Reflect.set(
				task,
				method,
				vi.fn(() => canonical.promise),
			)
			const capture = captureRequest()
			try {
				await vi.advanceTimersByTimeAsync(0)
				expect(api.createMessage).not.toHaveBeenCalled()
				expect(fs.appendFile).not.toHaveBeenCalled()
				canonical.resolve()
				await vi.advanceTimersByTimeAsync(0)
				expect(api.createMessage).toHaveBeenCalledOnce()
			} finally {
				canonical.resolve()
				await vi.runAllTimersAsync()
				await capture
				await log.close()
			}
		},
	)

	it("cancels before dispatch when cancellation wins during canonical lifecycle admission", async () => {
		const { task, api, log, captureRequest, cancellation } = harness()
		const canonical = deferred()
		Reflect.set(
			task,
			"ensureCanonicalLifecycleStepStarted",
			vi.fn(() => canonical.promise),
		)
		const capture = captureRequest()
		const cancelled = expect(capture).rejects.toThrow("Request cancelled by user")
		await vi.advanceTimersByTimeAsync(0)
		cancellation.abort(new Error("Request cancelled by user"))
		await cancelled
		canonical.resolve()
		await vi.runAllTimersAsync()
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(fs.appendFile).not.toHaveBeenCalled()
		await log.close()
	})

	it("cancels an admitted request while optional writes finish with the original identity", async () => {
		const { task, api, log, records, captureRequest, cancellation } = harness()
		const response = deferred()
		api.createMessage.mockImplementation(async function* () {
			await response.promise
			yield { type: "text", text: "Late fixture response" }
		})
		const capture = captureRequest()
		const cancelled = expect(capture).rejects.toThrow("Request cancelled by user")
		await vi.advanceTimersByTimeAsync(0)
		expect(api.createMessage).toHaveBeenCalledOnce()
		const metadata = api.createMessage.mock.calls[0][2]!
		cancellation.abort(new Error("Request cancelled by user"))
		await cancelled
		expect(metadata.signal?.aborted).toBe(true)
		expect(Reflect.get(task, "currentRequestAbortController")).toBeUndefined()
		expect(Reflect.get(task, "currentRequestSignal")).toBeUndefined()
		Reflect.set(task, "currentAgentStep", undefined)
		response.resolve()
		await vi.runAllTimersAsync()
		await log.flush()
		expect(records).toHaveLength(2)
		for (const record of records) {
			expect(record).toMatchObject({ requestId: metadata.requestId, attemptId: metadata.attemptId })
		}
		await log.close()
	})

	it("handles rejected optional writes without failing the provider request or leaking a rejection", async () => {
		const { api, log, records, captureRequest } = harness()
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(fs.appendFile).mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 25))
			throw new Error("Fixture telemetry write failure")
		})
		const capture = captureRequest()
		await vi.advanceTimersByTimeAsync(0)
		expect(api.createMessage).toHaveBeenCalledOnce()
		await vi.runAllTimersAsync()
		await capture
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Failed to append agent turn event"),
			expect.objectContaining({ message: "Fixture telemetry write failure" }),
		)
		// The failed additive append remains observable at the journal's durability boundary.
		await expect(log.flush()).rejects.toThrow("Fixture telemetry write failure")
		expect(records.map(({ event }) => event.type)).toEqual(["policy_snapshot"])
		await log.close()
	})
})
