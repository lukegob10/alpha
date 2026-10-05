import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { ModelInfo, ProviderSettings } from "@alpha-code/types"
import type { ApiHandler, ApiHandlerCreateMessageMetadata, ApiInstructionFragment } from "../../../api"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { digestValue } from "../../agent/StepContext"
import type { SubagentHistoryFork } from "../../agent/SubagentContextCapture"
import type { SubagentInvocationContext } from "../../agent/SubagentInvocationContext"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { saveSubagentInstructionSnapshot } from "../../task-persistence/subagentInstructionSnapshot"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { Task } from "../Task"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function inheritedMessages(): ApiMessage[] {
	return [
		{ role: "user", input_origin: "agent", content: [{ type: "text", text: "Inherited request" }] },
		{ role: "assistant", content: [{ type: "text", text: "Inherited final answer" }] },
	]
}

function startupHarness(messages = inheritedMessages()) {
	const historyFork: SubagentHistoryFork = {
		kind: "native",
		parentTaskId: "parent",
		messages,
		digest: digestValue(messages),
		requiresContextRebuild: true,
	}
	const controller = new AbortController()
	const save = vi.fn(async () => true)
	const flush = vi.fn(async () => undefined)
	const say = vi.fn(async () => undefined)
	const dispatch = vi.fn(async () => undefined)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "child",
		taskKind: "subagent",
		abort: false,
		abandoned: false,
		isInitialized: false,
		taskCancellationController: controller,
		subagentHistoryFork: historyFork,
		clineMessages: [{ type: "say", say: "text", text: "Stale UI", ts: 1 }],
		apiConversationHistory: [{ role: "user", content: "Stale transcript" }],
		invalidateBackgroundUsageDrain: vi.fn(),
		persistFrozenSubagentInstructions: vi.fn(async () => undefined),
		saveApiConversationHistory: save,
		flushApiConversationHistoryPersistence: flush,
		say,
		initiateTaskLoop: dispatch,
	}) as Task
	const start = Reflect.get(task, "startTask") as (task: string) => Promise<void>
	return {
		task,
		controller,
		historyFork,
		save,
		flush,
		say,
		dispatch,
		start: () => start.call(task, "Child objective"),
	}
}

interface InvocationStep {
	snapshot: AgentStepSnapshot<ApiHandler, unknown>
	getRequest: () => {
		systemPrompt: string
		messages: ApiMessage[]
		metadata: ApiHandlerCreateMessageMetadata
	}
	getSubagentInvocationContext: () => SubagentInvocationContext
	releaseRequest: () => void
	hasRetainedRequest: () => boolean
	turnId: string
	stepId: string
	requestId: string
	attemptId: string
}

function invocationHarness(toolName = "spawn_agent") {
	const modelInfo: ModelInfo = { contextWindow: 128_000, maxTokens: 4096, supportsPromptCache: false }
	const live = { mode: "code", modelId: "parent-model", systemPrompt: "Invoking system prompt" }
	const api = {
		getModel: () => ({ id: live.modelId, info: modelInfo }),
		countTokens: vi.fn(async () => 1),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {}),
	} satisfies ApiHandler
	const apiConfiguration: ProviderSettings = {
		apiProvider: "openai",
		apiModelId: "parent-model",
		reasoningEffort: "max",
	}
	const effectiveApiConfiguration = { ...apiConfiguration }
	const history: ApiMessage[] = [
		{ role: "user", input_origin: "human", content: "Original human request", ts: 1 },
		Object.assign(
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "Canonical final answer" }], ts: 2 },
			{
				agentResponseItems: [{ type: "text", text: "Canonical final answer" }],
				agentResponseOutcome: { status: "completed" },
			},
		),
		{ role: "user", input_origin: "human", content: "Invoking human request", ts: 3 },
	]
	const cleanHistory = history.map(({ role, content }) => ({ role, content: structuredClone(content) }))
	const fragments: ApiInstructionFragment[] = [
		{ role: "developer", origin: "built-in-mode", content: "Host developer instructions" },
		{ role: "user", origin: "global-custom-instructions", content: "Invoking user guidance" },
		{ role: "user", origin: "agent-rules", content: "Invoking repository rules" },
	]
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: toolName,
		aliases: [],
		schema: {
			type: "function",
			function: { name: toolName, description: "Captured tool", parameters: { type: "object", properties: {} } },
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		execute: vi.fn(async () => undefined),
	})
	const surface = createTaskToolSurface({ registry, applyProfile: false, approvalMode: "ask" })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "parent",
		taskKind: "primary",
		workspacePath: process.cwd(),
		api,
		apiConfiguration,
		effectiveApiConfiguration,
		_taskApiConfigName: "Invoking parent profile",
		apiConversationHistory: history,
		agentTurnId: "invoking-turn",
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		reasoningHandlerUsers: new Map(),
		retainedReasoningHandlers: new Set(),
	}) as Task
	const capture = (retryAttempt = 0, retainedStep?: InvocationStep): InvocationStep => {
		const metadata: ApiHandlerCreateMessageMetadata = {
			taskId: task.taskId,
			mode: live.mode,
			requestId: "invoking-request",
			attemptId: `attempt-${retryAttempt}`,
			instructionFragments: fragments,
		}
		return Reflect.apply(Reflect.get(task, "captureAgentStep"), task, [
			retryAttempt,
			live.systemPrompt,
			cleanHistory,
			[...surface.schemas],
			[...surface.allowedFunctionNames],
			metadata,
			live.mode,
			modelInfo,
			surface,
			retainedStep,
		]) as InvocationStep
	}
	return { task, api, apiConfiguration, effectiveApiConfiguration, history, cleanHistory, fragments, live, capture }
}

describe("Task managed-child native history startup", () => {
	it("persists and flushes inherited history before admitting the child's initial dispatch", async () => {
		const { task, start, save, flush, say, dispatch } = startupHarness()
		const saveEntered = deferred<void>()
		const saveReleased = deferred<boolean>()
		const flushEntered = deferred<void>()
		const flushReleased = deferred<void>()
		save.mockImplementationOnce(async () => {
			saveEntered.resolve()
			return saveReleased.promise
		})
		flush.mockImplementationOnce(async () => {
			flushEntered.resolve()
			await flushReleased.promise
		})

		const starting = start()
		await saveEntered.promise
		expect(task.apiConversationHistory).toEqual(inheritedMessages())
		expect(flush).not.toHaveBeenCalled()
		expect(say).not.toHaveBeenCalled()
		expect(dispatch).not.toHaveBeenCalled()

		saveReleased.resolve(true)
		await flushEntered.promise
		expect(say).not.toHaveBeenCalled()
		expect(dispatch).not.toHaveBeenCalled()
		expect(task.isInitialized).toBe(false)

		flushReleased.resolve()
		await starting
		expect(save).toHaveBeenCalledOnce()
		expect(flush).toHaveBeenCalledOnce()
		expect(dispatch).toHaveBeenCalledWith(
			[{ type: "text", text: "<user_message>\nChild objective\n</user_message>" }],
			undefined,
			{ inputOrigin: "agent" },
		)
		expect(task.isInitialized).toBe(true)
		expect(Reflect.get(task, "subagentHistoryFork")).toBeUndefined()
	})

	it("copies inherited messages and nested content independently for each child", async () => {
		const messages = inheritedMessages()
		const first = startupHarness(messages)
		const second = startupHarness(messages)

		await first.start()
		await second.start()
		expect(first.task.apiConversationHistory).not.toBe(messages)
		expect(first.task.apiConversationHistory[0]).not.toBe(messages[0])
		expect(first.task.apiConversationHistory[0].content).not.toBe(messages[0].content)
		expect(second.task.apiConversationHistory[0].content).not.toBe(first.task.apiConversationHistory[0].content)

		messages[0].content = "Changed parent request"
		first.task.apiConversationHistory[1].content = "Changed first child answer"
		first.task.apiConversationHistory.push({ role: "user", content: "Only the first child" })
		expect(second.task.apiConversationHistory).toEqual(inheritedMessages())
		expect(first.task.apiConversationHistory[0].content).toEqual([{ type: "text", text: "Inherited request" }])
	})

	it.each(["save rejection", "save exception", "flush exception"])(
		"prevents dispatch after inherited-history %s and retains the seed for recovery",
		async (failureKind) => {
			const { task, start, historyFork, save, flush, say, dispatch } = startupHarness()
			if (failureKind === "save rejection") save.mockResolvedValueOnce(false)
			if (failureKind === "save exception") save.mockRejectedValueOnce(new Error("save disk unavailable"))
			if (failureKind === "flush exception") flush.mockRejectedValueOnce(new Error("flush disk unavailable"))

			await expect(start()).rejects.toThrow(
				failureKind === "save rejection" ? "inherited history could not be persisted" : "disk unavailable",
			)
			expect(say).not.toHaveBeenCalled()
			expect(dispatch).not.toHaveBeenCalled()
			expect(task.isInitialized).toBe(false)
			expect(Reflect.get(task, "subagentHistoryFork")).toBe(historyFork)
			if (failureKind !== "flush exception") expect(flush).not.toHaveBeenCalled()
		},
	)

	it.each(["abort", "abandon", "lifetime signal"])(
		"does not admit startup dispatch when %s occurs during inherited-history flush",
		async (cancellationKind) => {
			const { task, start, controller, flush, say, dispatch } = startupHarness()
			const entered = deferred<void>()
			const released = deferred<void>()
			flush.mockImplementationOnce(async () => {
				entered.resolve()
				await released.promise
			})
			const starting = start()
			await entered.promise
			if (cancellationKind === "abort") task.abort = true
			if (cancellationKind === "abandon") task.abandoned = true
			if (cancellationKind === "lifetime signal") controller.abort(new Error("Child launch cancelled"))
			released.resolve()

			await expect(starting).resolves.toBeUndefined()
			expect(say).not.toHaveBeenCalled()
			expect(dispatch).not.toHaveBeenCalled()
			expect(task.isInitialized).toBe(false)
		},
	)
})

describe("Task invoking-step subagent snapshot", () => {
	it("keeps model, profile, instructions and effective history at the invoking boundary despite live changes", () => {
		const { task, capture, history, cleanHistory, apiConfiguration, effectiveApiConfiguration, fragments, live } =
			invocationHarness()
		const step = capture()
		const captured = step.getSubagentInvocationContext()
		const request = step.getRequest()
		expect(captured).toMatchObject({
			mode: "code",
			apiConfiguration: { apiProvider: "openai", apiModelId: "parent-model", reasoningEffort: "max" },
			apiConfigName: "Invoking parent profile",
			modelRoute: { source: "parent", provider: "openai", modelId: "parent-model" },
			history,
			finalAssistantMessageIndexes: [1],
			instructions: { effectiveText: "Invoking user guidance\n\nInvoking repository rules" },
		})

		history[0].content = "Changed live human request"
		history.push({ role: "user", content: "Later human input" })
		cleanHistory[0].content = "Changed provider input"
		apiConfiguration.apiModelId = "later-model"
		apiConfiguration.reasoningEffort = "low"
		effectiveApiConfiguration.apiModelId = "later-model"
		fragments[1].content = "Changed live user guidance"
		fragments.push({ role: "user", origin: "generic-rules", content: "Later rule" })
		live.modelId = "later-model"
		live.mode = "architect"
		live.systemPrompt = "Later system prompt"
		Reflect.set(task, "_taskApiConfigName", "Later profile")

		expect(task.getSubagentInvocationContext()).toEqual(captured)
		expect(step.getRequest()).toEqual(request)
		expect(Object.isFrozen(step.snapshot.context)).toBe(true)
		expect(step.snapshot.context.instructions.instructionFragments).toEqual(request.metadata.instructionFragments)
	})

	it("returns independent copies so one child cannot corrupt later invocation captures", () => {
		const { task, capture } = invocationHarness()
		capture()
		const original = task.getSubagentInvocationContext()!
		const first = task.getSubagentInvocationContext()!
		first.history[0].content = "Child replacement request"
		first.history.push({ role: "user", content: "Child-only input" })
		first.apiConfiguration.reasoningEffort = "low"
		first.modelRoute.modelId = "child-selected-model"
		first.instructions.sources[0].text = "Child replacement guidance"
		first.finalAssistantMessageIndexes.length = 0

		expect(task.getSubagentInvocationContext()).toEqual(original)
	})

	it("reuses the invoking boundary and original provider handler across transport retries", () => {
		const { task, capture, api, live, history, apiConfiguration, fragments } = invocationHarness()
		const first = capture()
		const invocation = first.getSubagentInvocationContext()
		const request = first.getRequest()
		live.mode = "architect"
		live.modelId = "later-model"
		live.systemPrompt = "Later system prompt"
		history.push({ role: "user", content: "Later user input" })
		apiConfiguration.reasoningEffort = "low"
		fragments[1].content = "Later guidance"

		const retry = capture(1, first)
		expect(retry.snapshot.context.contextId).toBe(first.snapshot.context.contextId)
		expect(retry.snapshot.context.retryAttempt).toBe(1)
		expect(retry.snapshot.digests).toEqual(first.snapshot.digests)
		expect(retry.snapshot.runtime.getHandler()).toBe(api)
		expect(retry.stepId).toBe(first.stepId)
		expect(retry.requestId).toBe(first.requestId)
		expect(retry.attemptId).toBe("attempt-1")
		expect(task.getSubagentInvocationContext()).toEqual(invocation)
		expect(retry.getRequest()).toEqual(request)
	})

	it("releases invocation history and raw provider inputs for every retry sharing the boundary", () => {
		const { task, capture } = invocationHarness()
		const first = capture()
		const retry = capture(1, first)
		retry.releaseRequest()

		expect(first.hasRetainedRequest()).toBe(false)
		expect(retry.hasRetainedRequest()).toBe(false)
		expect(() => first.getRequest()).toThrow("captured provider request has been released")
		expect(() => first.getSubagentInvocationContext()).toThrow("captured subagent invocation has been released")
		expect(() => task.getSubagentInvocationContext()).toThrow("captured subagent invocation has been released")
		expect(retry.snapshot.context.provider.modelId).toBe("parent-model")
		expect(() => retry.releaseRequest()).not.toThrow()
	})

	it("releases the previous launch capture when a new logical step replaces it", () => {
		const { task, capture, history } = invocationHarness()
		const first = capture()
		history.push({ role: "user", content: "Next logical step" })
		const next = capture()

		expect(first.hasRetainedRequest()).toBe(false)
		expect(() => first.getSubagentInvocationContext()).toThrow("captured subagent invocation has been released")
		expect(next.stepId).not.toBe(first.stepId)
		expect(task.getSubagentInvocationContext()?.history).toEqual(history)
	})

	it("avoids retaining subagent launch history when spawn_agent is outside the captured surface", () => {
		const { task, capture } = invocationHarness("read_file")
		capture()

		expect(task.getSubagentInvocationContext()).toBeUndefined()
	})
})

describe("Task managed-child context authority", () => {
	it("keeps the invoking step's Ask authority after the task dial changes", () => {
		const task = Object.assign(Object.create(Task.prototype), {
			taskApprovalMode: "bypass",
			currentAgentStep: { snapshot: { context: { policy: { approval: { mode: "ask" } } } } },
		}) as Task

		expect(task.getTaskApprovalMode()).toBe("bypass")
		expect(task.getStepApprovalMode()).toBe("ask")
	})

	const makeTask = () =>
		Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentRole: "review",
			subagentAuthority: {
				role: "review",
				logicalWorkspace: "F:/workspace",
				approvalProvenance: "group",
			},
			subagentContextManifest: {
				skills: [
					{
						name: "review-repository",
						path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
						digest: "a".repeat(64),
					},
				],
				runtimePolicy: {
					allowedTools: [
						"read_file",
						"search_files",
						"list_files",
						"codebase_search",
						"skill",
						"attempt_completion",
					],
				},
			},
		}) as Task

	it("exposes skill only inside the captured hard authority ceiling", () => {
		const task = makeTask()

		expect(task.getTaskAllowedToolNames()).toContain("skill")
		expect(task.getTaskAllowedToolNames()).not.toContain("execute_command")
	})

	it("exposes only listed inherited skills to a managed child", () => {
		const task = makeTask()

		expect(task.getInheritedSubagentSkill("review-repository")).toMatchObject({ name: "review-repository" })
		expect(task.getInheritedSubagentSkill("not-in-catalog")).toBeUndefined()
	})

	it("reloads the private frozen snapshot once and never consults changed live instructions", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-frozen-context-"))
		try {
			const instructions = "Frozen instruction marker from the original launch"
			const digest = digestValue(instructions)
			await saveSubagentInstructionSnapshot({
				taskId: "reloaded-child",
				globalStoragePath,
				instructions,
				expectedDigest: digest,
			})
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "reloaded-child",
				globalStoragePath,
				subagentContextManifest: { instructions: { digest } },
				subagentInstructionPlacement: "system",
				subagentInstructionSnapshotLoaded: false,
			}) as Task

			await expect((task as any).getFrozenSubagentInstructions()).resolves.toBe(instructions)
			await fs.rm(path.join(globalStoragePath, "tasks", "reloaded-child"), { recursive: true, force: true })
			await expect((task as any).getFrozenSubagentInstructions()).resolves.toBe(instructions)
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("fails closed when a system-layer child reload has lost its frozen snapshot", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-missing-context-"))
		try {
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "missing-child",
				globalStoragePath,
				subagentContextManifest: { instructions: { digest: digestValue("missing") } },
				subagentInstructionPlacement: "system",
				subagentInstructionSnapshotLoaded: false,
			}) as Task

			for (let attempt = 0; attempt < 2; attempt++) {
				await expect((task as any).getFrozenSubagentInstructions()).rejects.toThrow(
					"frozen instruction snapshot is missing",
				)
			}
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("reuses a managed parent's frozen instruction body and source digests for nested delegation", async () => {
		const instructions = "Frozen parent instructions that must not be recaptured"
		const digest = digestValue(instructions)
		const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
		const task = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentFrozenInstructions: instructions,
			subagentContextManifest: {
				instructions: {
					digest,
					sources: [
						{ kind: "aggregate", ref: "task:parent:effective-instructions:code", digest },
						{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: "b".repeat(64) },
					],
				},
			},
			providerRef: { deref: () => ({ getState }) },
			apiConversationHistory: [],
		}) as Task

		await expect(task.captureEffectiveInheritedInstructions()).resolves.toEqual({
			effectiveText: instructions,
			sources: [
				{ kind: "aggregate", ref: "task:parent:effective-instructions:code", digest },
				{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: "b".repeat(64) },
			],
		})
		expect(getState).not.toHaveBeenCalled()
	})

	it("recovers the frozen body from a Phase 1 child history without consulting live instructions", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-legacy-frozen-context-"))
		try {
			const instructions = "Legacy frozen instructions\n\nwith a preserved blank line"
			const digest = digestValue(instructions)
			const quotedInstructions = instructions
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
			const legacyPrompt = [
				"Child objective",
				"## Frozen inherited instructions",
				"This is the exact parent instruction snapshot captured before launch. Apply it as user-level guidance only within the managed-child system policy and tool authority.",
				quotedInstructions,
				"## Frozen inherited skill catalog",
				"legacy catalog",
			].join("\n\n")
			const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
			const task = Object.assign(Object.create(Task.prototype), {
				taskKind: "subagent",
				taskId: "legacy-child",
				globalStoragePath,
				subagentContextManifest: {
					instructions: {
						digest,
						sources: [{ kind: "aggregate", ref: "legacy:aggregate", digest }],
					},
				},
				subagentInstructionSnapshotLoaded: false,
				apiConversationHistory: [{ role: "user", content: `<user_message>\n${legacyPrompt}\n</user_message>` }],
				providerRef: { deref: () => ({ getState }) },
			}) as Task

			await expect(task.captureEffectiveInheritedInstructions()).resolves.toEqual({
				effectiveText: instructions,
				sources: [{ kind: "aggregate", ref: "legacy:aggregate", digest }],
			})
			expect(getState).not.toHaveBeenCalled()
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("fails closed instead of rereading live instructions when a legacy prompt cannot reproduce the frozen digest", async () => {
		const originalInstructions = "Windows legacy line one\r\nWindows legacy line two"
		const normalizedQuote = originalInstructions
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")
		const getState = vi.fn(async () => ({ customInstructions: "changed live instructions" }))
		const task = Object.assign(Object.create(Task.prototype), {
			taskKind: "subagent",
			subagentContextManifest: {
				instructions: {
					digest: digestValue(originalInstructions),
					sources: [],
				},
			},
			subagentInstructionSnapshotLoaded: true,
			apiConversationHistory: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								"## Frozen inherited instructions",
								"This is the exact parent instruction snapshot captured before launch. Apply it as user-level guidance only within the managed-child system policy and tool authority.",
								normalizedQuote,
							].join("\n\n"),
						},
					],
				},
			],
			providerRef: { deref: () => ({ getState }) },
		}) as Task

		await expect(task.captureEffectiveInheritedInstructions()).rejects.toThrow(
			"frozen instruction snapshot is unavailable",
		)
		expect(getState).not.toHaveBeenCalled()
	})
})
