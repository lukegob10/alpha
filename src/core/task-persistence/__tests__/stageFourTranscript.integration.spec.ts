import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { Anthropic } from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import type { ToolSchedulerOutcome } from "../../agent/ToolScheduler"
import { EnvironmentContext } from "../../environment/EnvironmentContext"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../../task/Task"
import { createTaskToolSurface, type TaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { readApiMessages, type ApiMessage } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"

const TASK_ID = "stage-four-transcript"
const ORIGINAL_TEXT = "LEGACY-VALUE-A"
const EXTERNAL_TEXT = "LEGACY-VALUE-B"

const io = vi.hoisted(() => ({
	beforeRename: undefined as
		| ((...paths: Parameters<(typeof import("fs/promises"))["rename"]>) => Promise<void>)
		| undefined,
}))

// Native ESM exports cannot be spied on. This pass-through leaves every actual
// file operation intact except the explicitly controlled pre-rename barrier.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		rename: async (...paths: Parameters<typeof actual.rename>) => {
			await io.beforeRename?.(...paths)
			await actual.rename(...paths)
		},
	}
})

// These are existing Task boundaries, not substitute implementations. Keep the
// filesystem, history writers, receipt store, digest, scheduler, and flush real.
interface TaskPersistenceBoundaries {
	getSavedApiConversationHistory(): Promise<ApiMessage[]>
	assertCurrentProviderTranscriptBeforeEffects(): Promise<void>
	persistAssistantResponseBeforeEffects(
		message: Anthropic.MessageParam,
		reasoning?: string,
		response?: AgentResponse,
	): Promise<boolean>
	executeCanonicalToolCalls(
		response: AgentResponse,
		surface: TaskToolSurface,
		mode: string,
		state: undefined,
		signal: AbortSignal,
	): Promise<ToolSchedulerOutcome>
	finalizeTerminationAfterAbort(abortPromise: Promise<void>): Promise<void>
}

const boundaries = (task: Task) => task as unknown as TaskPersistenceBoundaries

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ status: "fulfilled" as const, value }),
		(error: unknown) => ({ status: "rejected" as const, error }),
	)
}

async function reachBarrier<T>(barrier: Promise<void>, operation: ReturnType<typeof observe<T>>) {
	await Promise.race([
		barrier,
		operation.then((result) => {
			throw new Error("Operation settled before reaching the controlled filesystem barrier", {
				cause: result.status === "rejected" ? result.error : undefined,
			})
		}),
	])
}

async function createHarness() {
	const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-stage-four-transcript-"))
	const storagePath = path.join(directory, "storage")
	const taskDirectory = await getTaskDirectoryPath(storagePath, TASK_ID)
	const legacyPath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
	const sidecarPath = path.join(taskDirectory, GlobalFileNames.providerTranscript)
	const persistenceKey = `${path.resolve(storagePath)}\u0000${TASK_ID}`
	const ownerGenerations = Reflect.get(Task, "apiConversationHistoryOwnerGenerations") as Map<string, number>
	const tasks: Task[] = []
	const provider = {}

	const makeTask = () => {
		const generation = (ownerGenerations.get(persistenceKey) ?? 0) + 1
		ownerGenerations.set(persistenceKey, generation)
		// Avoid extension activation and live provider/UI construction, as in the
		// legacy handoff integration fixture. No persistence method is replaced.
		const task = Object.assign(Object.create(Task.prototype), {
			taskId: TASK_ID,
			instanceId: `transcript-instance-${generation}`,
			taskKind: "primary",
			workspacePath: directory,
			globalStoragePath: storagePath,
			abort: false,
			api: {},
			apiConfiguration: { apiProvider: "openai-native", apiModelId: "gpt-4.1" },
			apiConversationHistory: [],
			apiConversationHistorySaveQueue: Promise.resolve(),
			apiConversationHistoryPersistenceKey: persistenceKey,
			apiConversationHistoryOwnerGeneration: generation,
			providerTranscriptStore: new ProviderTranscriptStore(TASK_ID, storagePath),
			assistantMessageSavedToHistory: false,
			persistedToolResultIds: new Set<string>(),
			pendingWaitAgentResultClaims: new Map<string, string>(),
			userMessageContent: [],
			userMessageContentReady: false,
			clineMessages: [],
			toolUsage: {},
			toolRepetitionDetector: new ToolRepetitionDetector(3),
			commandExecutionEvidence: new Map(),
			pendingCommandVerification: Promise.resolve(),
			canonicalLifecycleQueue: Promise.resolve(),
			taskCancellationController: new AbortController(),
			messageQueueService: new MessageQueueService(),
			environmentContext: new EnvironmentContext(),
			providerRef: { deref: () => provider },
			emit: vi.fn(),
			say: vi.fn<Task["say"]>(async () => undefined),
			// This additive telemetry log is not a transcript durability boundary.
			appendAgentTurnEvent: vi.fn(async () => undefined),
		}) as Task
		tasks.push(task)
		return task
	}

	return {
		directory,
		storagePath,
		legacyPath,
		sidecarPath,
		makeTask,
		readLegacy: () => readApiMessages({ taskId: TASK_ID, globalStoragePath: storagePath }),
		async dispose() {
			await Promise.all(tasks.map((task) => task.flushApiConversationHistoryPersistence()))
			for (const task of tasks) task.messageQueueService.removeAllListeners()
			ownerGenerations.delete(persistenceKey)
			await fs.rm(directory, { recursive: true, force: true })
		},
	}
}

type Harness = Awaited<ReturnType<typeof createHarness>>

function responseWithCalls(count = 1): AgentResponse {
	return createAgentResponse([
		{ type: "text", text: "Inspect the requested files." },
		...Array.from({ length: count }, (_, index) => ({
			type: "tool_call" as const,
			id: `read-${index + 1}`,
			name: "read_file",
			arguments: { path: `file-${index + 1}.txt` },
		})),
	])
}

async function persistAssistant(task: Task, response = responseWithCalls()) {
	const assistant: ApiMessage & { opaqueProviderState: unknown; vscodeLmStatefulMarker: string } = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Preserve the provider state.", signature: "opaque-signature" },
			{ type: "text", text: response.text },
			...response.toolCalls.map((call) => ({
				type: "tool_use" as const,
				id: call.id,
				name: call.name,
				input: call.arguments,
			})),
		],
		encrypted_content: "encrypted-provider-state",
		reasoning_content: "interleaved provider reasoning",
		reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-detail", signature: "detail-signature" }],
		opaqueProviderState: { ordered: ["first", { futureField: "preserve-me" }, "last"] },
		vscodeLmStatefulMarker: "vscode-state-marker",
	}
	expect(await boundaries(task).persistAssistantResponseBeforeEffects(assistant, undefined, response)).toBe(true)
	await boundaries(task).assertCurrentProviderTranscriptBeforeEffects()
	return response
}

async function seedTask(harness: Harness) {
	const task = harness.makeTask()
	expect(await task.overwriteApiConversationHistory([{ role: "user", content: ORIGINAL_TEXT, ts: 1 }])).toBe(true)
	return task
}

async function tamperLegacy(harness: Harness, mode: "in-place" | "replacement") {
	const original = await fs.readFile(harness.legacyPath, "utf8")
	const originalStat = await fs.stat(harness.legacyPath)
	const edited = original.replace(ORIGINAL_TEXT, EXTERNAL_TEXT)
	expect(edited).not.toBe(original)
	expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original))
	if (mode === "in-place") {
		await fs.writeFile(harness.legacyPath, edited, "utf8")
	} else {
		const replacement = path.join(path.dirname(harness.legacyPath), "external-replacement.json")
		await fs.writeFile(replacement, edited, "utf8")
		await fs.rename(replacement, harness.legacyPath)
	}
	// Size and restored timestamps are deliberately not sufficient evidence of
	// identity; the sidecar stays untouched while authoritative bytes change.
	await fs.utimes(harness.legacyPath, originalStat.atime, originalStat.mtime)
	return edited
}

function serialReadSurface(execute: ToolDescriptor["execute"]) {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const descriptor: ToolDescriptor = {
		name: "read_file",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "read_file",
				description: "Read one integration fixture file",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
			},
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		execute,
	}
	registry.register(descriptor)
	return createTaskToolSurface({ registry, schemas: [descriptor.schema], mode: "code" })
}

function toolResults(messages: ApiMessage[]) {
	return messages.flatMap((message) =>
		message.role === "user" && Array.isArray(message.content)
			? message.content.filter((block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result")
			: [],
	)
}

describe("Stage Four real Task transcript persistence", () => {
	const harnesses: Harness[] = []
	const setup = async () => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
		const harness = await createHarness()
		harnesses.push(harness)
		return harness
	}
	afterEach(async () => {
		io.beforeRename = undefined
		vi.restoreAllMocks()
		await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()))
	})

	it("commits the real assistant/result boundary and reloads opaque provider metadata without duplicating results", async () => {
		const harness = await setup()
		const task = await seedTask(harness)
		const response = await persistAssistant(task)
		expect(
			task.pushToolResultToUserContent({ type: "tool_result", tool_use_id: "read-1", content: "file contents" }),
		).toBe(true)
		expect(await task.flushPendingToolResultsToHistory()).toBe(true)
		expect(await task.flushPendingToolResultsToHistory()).toBe(true)
		await task.flushApiConversationHistoryPersistence()
		const committed = structuredClone(task.apiConversationHistory)
		expect(committed[1]).toMatchObject({
			encrypted_content: "encrypted-provider-state",
			reasoning_content: "interleaved provider reasoning",
			reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-detail", signature: "detail-signature" }],
			opaqueProviderState: { ordered: ["first", { futureField: "preserve-me" }, "last"] },
			vscodeLmStatefulMarker: "vscode-state-marker",
			agentResponseItems: response.items,
			content: [
				{ type: "thinking", thinking: "Preserve the provider state.", signature: "opaque-signature" },
				{ type: "text", text: response.text },
				{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "file-1.txt" } },
			],
		})
		expect(await harness.readLegacy()).toEqual(committed)
		const store = new ProviderTranscriptStore(TASK_ID, harness.storagePath)
		expect((await store.read()).messages).toEqual(committed)

		const restarted = harness.makeTask()
		expect(await boundaries(restarted).getSavedApiConversationHistory()).toEqual(committed)
		expect(toolResults(await harness.readLegacy())).toEqual([
			expect.objectContaining({ tool_use_id: "read-1", content: "file contents" }),
		])
		expect((await new ProviderTranscriptStore(TASK_ID, harness.storagePath).read()).messages).toEqual(committed)
	})

	it.each(["in-place", "replacement"] as const)(
		"rejects an equal-size legacy-only %s edit after warming the receipt",
		async (mode) => {
			const harness = await setup()
			const task = await seedTask(harness)
			await persistAssistant(task)
			const sidecar = await fs.readFile(harness.sidecarPath, "utf8")
			const edited = await tamperLegacy(harness, mode)
			expect(await fs.readFile(harness.sidecarPath, "utf8")).toBe(sidecar)
			await expect(boundaries(task).assertCurrentProviderTranscriptBeforeEffects()).rejects.toThrow()
			expect(await fs.readFile(harness.legacyPath, "utf8")).toBe(edited)
		},
	)

	it("retains pending results when the receipt replacement fails after the legacy commit and recovers from legacy", async () => {
		const harness = await setup()
		const task = await seedTask(harness)
		await persistAssistant(task)
		const originalSidecar = await fs.readFile(harness.sidecarPath, "utf8")
		task.pushToolResultToUserContent({ type: "tool_result", tool_use_id: "read-1", content: "durable effect" })
		const pending = structuredClone(task.userMessageContent)
		io.beforeRename = async (_source, destination) => {
			if (String(destination) === harness.sidecarPath) {
				throw Object.assign(new Error("Injected sidecar commit failure"), { code: "EIO" })
			}
		}
		try {
			expect(await task.flushPendingToolResultsToHistory()).toBe(false)
			expect(task.userMessageContent).toEqual(pending)
			expect(toolResults(await harness.readLegacy())).toHaveLength(1)
			expect(await fs.readFile(harness.sidecarPath, "utf8")).toBe(originalSidecar)
		} finally {
			io.beforeRename = undefined
		}

		const durableLegacy = await harness.readLegacy()
		const restarted = harness.makeTask()
		expect(await boundaries(restarted).getSavedApiConversationHistory()).toEqual(durableLegacy)
		expect((await new ProviderTranscriptStore(TASK_ID, harness.storagePath).read()).messages).toEqual(durableLegacy)
		expect(await restarted.overwriteApiConversationHistory(durableLegacy)).toBe(true)
		expect(toolResults(await harness.readLegacy())).toHaveLength(1)
	})

	it("drains the old transaction before replacement and rejects a later stale-instance snapshot", async () => {
		const harness = await setup()
		const oldTask = await seedTask(harness)
		const entered = deferred()
		const release = deferred()
		let intercepted = false
		io.beforeRename = async (_source, destination) => {
			if (!intercepted && String(destination) === harness.legacyPath) {
				intercepted = true
				entered.resolve()
				await release.promise
			}
		}
		const oldSave = observe(oldTask.overwriteApiConversationHistory([{ role: "user", content: "old in flight" }]))
		let staleSave: ReturnType<typeof observe<boolean>> | undefined
		let replacementSave: ReturnType<typeof observe<boolean>> | undefined
		let drain: Promise<void> | undefined
		let drained = false
		try {
			await reachBarrier(entered.promise, oldSave)
			staleSave = observe(oldTask.overwriteApiConversationHistory([{ role: "user", content: "stale queued" }]))
			const replacement = harness.makeTask()
			replacementSave = observe(
				replacement.overwriteApiConversationHistory([{ role: "user", content: "replacement final" }]),
			)
			drain = replacement.flushApiConversationHistoryPersistence().then(() => {
				drained = true
			})
			await Promise.resolve()
			expect(drained).toBe(false)
		} finally {
			release.resolve()
			await Promise.all([oldSave, staleSave, replacementSave, drain])
		}
		expect(await oldSave).toEqual({ status: "fulfilled", value: true })
		expect(await staleSave).toEqual({ status: "fulfilled", value: false })
		expect(await replacementSave).toEqual({ status: "fulfilled", value: true })
		expect(drained).toBe(true)
		const expected = [{ role: "user", content: "replacement final" }]
		expect(await harness.readLegacy()).toEqual(expected)
		expect((await new ProviderTranscriptStore(TASK_ID, harness.storagePath).read()).messages).toEqual(expected)
	})

	it("joins a late tool-result producer and its real disk commit before termination settles", async () => {
		const harness = await setup()
		const task = await seedTask(harness)
		await persistAssistant(task)
		const producerRelease = deferred()
		const writeEntered = deferred()
		const writeRelease = deferred()
		const producer = producerRelease.promise.then(() => {
			task.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: "read-1",
				content: "completed before cancellation settled",
			})
		})
		Reflect.set(task, "ownedLifecyclePromise", producer)
		task.abort = true
		io.beforeRename = async (_source, destination) => {
			if (String(destination) === harness.sidecarPath) {
				writeEntered.resolve()
				await writeRelease.promise
			}
		}
		const termination = boundaries(task).finalizeTerminationAfterAbort(Promise.resolve())
		Reflect.set(task, "taskTerminationPromise", termination)
		let terminated = false
		const joined = observe(
			task.waitForTermination().then(() => {
				terminated = true
			}),
		)
		try {
			await Promise.resolve()
			expect(terminated).toBe(false)
			producerRelease.resolve()
			await reachBarrier(writeEntered.promise, joined)
			expect(terminated).toBe(false)
			expect(task.userMessageContent).toHaveLength(1)
		} finally {
			producerRelease.resolve()
			writeRelease.resolve()
			await joined
		}
		expect(await joined).toEqual({ status: "fulfilled", value: undefined })
		expect(task.userMessageContent).toEqual([])
		const restarted = harness.makeTask()
		const reloaded = await boundaries(restarted).getSavedApiConversationHistory()
		expect(toolResults(reloaded)).toEqual([
			expect.objectContaining({ tool_use_id: "read-1", content: "completed before cancellation settled" }),
		])
		expect((await new ProviderTranscriptStore(TASK_ID, harness.storagePath).read()).messages).toEqual(reloaded)
	})

	it("stops the second serial tool after legacy tampering and durably retains one truthful result per call", async () => {
		const harness = await setup()
		const task = await seedTask(harness)
		const response = await persistAssistant(task, responseWithCalls(2))
		const executed: string[] = []
		const surface = serialReadSurface(async ({ call, callbacks }) => {
			executed.push(call.id!)
			callbacks.pushToolResult(`completed:${call.id}`)
			if (call.id === "read-1") await tamperLegacy(harness, "in-place")
		})
		const outcome = await boundaries(task).executeCanonicalToolCalls(
			response,
			surface,
			"code",
			undefined,
			new AbortController().signal,
		)
		expect(executed).toEqual(["read-1"])
		expect(outcome).toMatchObject({
			status: "failed",
			failure: { kind: "effect_fence", callId: "read-2" },
			results: [
				{ callId: "read-1", status: "success" },
				{ callId: "read-2", status: "error" },
			],
		})
		expect(task.userMessageContent).toEqual([])
		const restarted = harness.makeTask()
		const reloaded = await boundaries(restarted).getSavedApiConversationHistory()
		expect(toolResults(reloaded)).toEqual([
			expect.objectContaining({ tool_use_id: "read-1", content: "completed:read-1", is_error: false }),
			expect.objectContaining({ tool_use_id: "read-2", is_error: true }),
		])
		expect((await new ProviderTranscriptStore(TASK_ID, harness.storagePath).read()).messages).toEqual(reloaded)
		expect(executed).toEqual(["read-1"])
	})
})
