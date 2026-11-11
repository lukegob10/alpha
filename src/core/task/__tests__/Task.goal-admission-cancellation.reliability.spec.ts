import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalStepAccounting } from "../../agent/GoalStepAccounting"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../build-tools", async (original) => ({
	...(await original<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

async function fixture() {
	const entered = deferred<void>()
	const read = deferred<TaskGoalEnvelope>()
	const taskId = "goal-admission-cancellation"
	let state: TaskGoalEnvelope = { schemaVersion: 1, taskId, usageReceipts: [] }
	const store: GoalStateStore = {
		read: () => {
			entered.resolve()
			return read.promise
		},
		transact: async (update) => {
			const working = structuredClone(state)
			const result = update(working)
			state = working
			return structuredClone(result)
		},
	}
	const controller = new GoalController({ taskId, store })
	const goal = await controller.create({ objective: "Finish.", tokenBudget: 10 }, "user")
	const activeGoalStep: GoalStepAccounting = {
		controller,
		goalId: goal.goalId,
		goalTaskId: taskId,
		controlVersion: goal.controlVersion,
		requestGeneration: controller.getRequestGeneration(),
		eventId: "goal-admission",
		startedAt: Date.now(),
		accountElapsed: true,
	}
	const api = {
		getModel: () => ({ id: "goal-model", info: { contextWindow: 128_000, maxTokens: 4096 } as ModelInfo }),
		countTokens: vi.fn(async () => 10),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "Provider dispatched." }
		}),
	} satisfies ApiHandler
	const apiConfiguration: ProviderSettings = { apiProvider: "vertex", apiModelId: "goal-model" }
	const surface = createTaskToolSurface({
		registry: new ToolRegistry({ includeBuiltIns: false }),
		applyProfile: false,
		approvalMode: "ask",
	})
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({ tools: [], surface })
	const task = Object.assign(Object.create(Task.prototype), {
		taskId,
		instanceId: "goal-admission-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		taskApprovalMode: "ask",
		taskCancellationController: new AbortController(),
		api,
		apiConfiguration,
		effectiveApiConfiguration: { ...apiConfiguration },
		activeGoalStep,
		reasoningPreference: { kind: "default" },
		reasoningState: {
			requested: { kind: "default" },
			effective: { kind: "default" },
			capabilities: { kind: "unavailable", canDisable: false },
		},
		reasoningByHandler: new WeakMap(),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => ({ getState: async () => ({ autoCondenseContext: false }) }) },
		apiConversationHistory: [{ role: "user", content: "Goal request" }],
		alphaMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		getTaskMode: async () => "code",
		getSystemPrompt: async () => "Goal prompt",
		getCurrentProfileId: async () => "profile",
		getTokenUsage: () => ({ contextTokens: 0 }),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: async () => ({ shouldProceed: true }) },
		ensureCanonicalLifecycleStepStarted: async () => undefined,
		publishCanonicalLifecyclePhase: async () => undefined,
		appendAgentTurnEvent: async () => undefined,
	}) as Task
	return { task, api, entered, read, state }
}

describe("final goal admission", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it.each(["cancellation", "deadline"] as const)("releases a held goal read on %s", async (cause) => {
		const { task, api, entered, read, state } = await fixture()
		const interruption = new AbortController()
		const cancellation = new Error("Request cancelled by user")
		const request = task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			interruptionSignal: interruption.signal,
			retryDeadline: Date.now() + 1_000,
		})
		let settlement: { error: unknown } | { result: IteratorResult<unknown> } | undefined
		const pending = request.next().then(
			(result) => (settlement = { result }),
			(error: unknown) => (settlement = { error }),
		)
		try {
			await Promise.race([
				entered.promise,
				pending.then((result) => {
					throw new Error("Request settled before its goal read", { cause: result })
				}),
			])
			if (cause === "cancellation") interruption.abort(cancellation)
			await vi.advanceTimersByTimeAsync(cause === "deadline" ? 1_000 : 0)

			expect(settlement).toEqual({
				error:
					cause === "cancellation"
						? cancellation
						: expect.objectContaining({ name: "ApiStreamDeadlineError", timeoutScope: "retry_deadline" }),
			})
			expect(task.getTaskCancellationSignal()).toBe(task.getTaskLifetimeCancellationSignal())

			if (cause === "cancellation") read.reject(new Error("Late goal read failed"))
			else read.resolve(state)
			await vi.advanceTimersByTimeAsync(0)
			expect(api.createMessage).not.toHaveBeenCalled()
		} finally {
			read.resolve(state)
			await pending
			await request.return?.(undefined)
		}
	})
})
