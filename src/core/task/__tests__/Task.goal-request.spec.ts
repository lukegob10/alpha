import type { ModelInfo, ProviderSettings } from "@alpha-code/types"
import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder } from "../../agent/AgentStepContextBuilder"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalStepAccounting } from "../../agent/GoalStepAccounting"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"
import { manageContext, willManageContext } from "../../context-management"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../build-tools", async (original) => ({
	...(await original<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))
vi.mock("../../context-management", async (original) => ({
	...(await original<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(() => false),
}))

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

async function harness() {
	let state: TaskGoalEnvelope = { schemaVersion: 1, taskId: "root", usageReceipts: [] }
	const store: GoalStateStore = {
		read: async () => structuredClone(state),
		transact: async (update) => {
			const working = structuredClone(state)
			const result = update(working)
			state = working
			return structuredClone(result)
		},
	}
	const controller = new GoalController({ taskId: "root", store, newId: () => "goal-a" })
	const goal = await controller.create({ objective: "Finish.", tokenBudget: 10 }, "user")
	const activeGoalStep: GoalStepAccounting = {
		controller,
		goalId: goal.goalId,
		goalTaskId: "root",
		controlVersion: goal.controlVersion,
		requestGeneration: controller.getRequestGeneration(),
		eventId: "request-step",
		startedAt: Date.now(),
		accountElapsed: true,
	}
	const api = {
		getModel: () => ({ id: "goal-model", info: { contextWindow: 128_000, maxTokens: 4096 } as ModelInfo }),
		countTokens: vi.fn(async () => 10),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "Response." }
		}),
	} satisfies ApiHandler
	const apiConfiguration: ProviderSettings = { apiProvider: "vertex", apiModelId: "goal-model" }
	const surface = createTaskToolSurface({
		registry: new ToolRegistry({ includeBuiltIns: false }),
		applyProfile: false,
		approvalMode: "ask",
	})
	const prompt = vi.fn(async () => "Goal prompt")
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "root",
		instanceId: "request-instance",
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
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: prompt,
		getCurrentProfileId: vi.fn(async () => "profile"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => undefined),
		publishCanonicalLifecyclePhase: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
	}) as Task
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({ tools: [], surface })
	vi.mocked(manageContext).mockImplementation(async ({ messages }) => ({
		messages,
		summary: "",
		cost: 0,
		prevContextTokens: 0,
	}))
	return { task, controller, goal, api, prompt }
}

describe("goal spending at the actual provider boundary", () => {
	it.each(["pause", "budget", "complete", "replacement"] as const)(
		"does not call the provider when %s wins asynchronous request preparation",
		async (action) => {
			const { task, controller, goal, api, prompt } = await harness()
			const entered = barrier(),
				release = barrier()
			prompt.mockImplementation(async () => {
				entered.resolve()
				await release.promise
				return "Goal prompt"
			})
			const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
			await entered.promise
			if (action === "pause") await controller.pause()
			if (action === "budget") await controller.recordUsage("child-spend", 10, 0, goal.goalId)
			if (action === "complete") await controller.updateStatus("complete")
			if (action === "replacement") {
				await controller.updateStatus("complete")
				await controller.create({ objective: "New goal." }, "user")
			}
			release.resolve()
			expect(await request).toMatchObject({ done: false, value: { type: "outcome", status: "incomplete" } })
			expect(api.createMessage).not.toHaveBeenCalled()
		},
	)

	it("permits under-budget descendant billing while preparation awaits", async () => {
		const { task, controller, goal, api, prompt } = await harness()
		const entered = barrier(),
			release = barrier()
		prompt.mockImplementation(async () => {
			entered.resolve()
			await release.promise
			return "Goal prompt"
		})
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next()
		await entered.promise
		await controller.recordUsage("child-spend", 5, 0, goal.goalId)
		release.resolve()
		expect(await request).toMatchObject({ done: false, value: { type: "text", text: "Response." } })
		expect(api.createMessage).toHaveBeenCalledOnce()
	})
})
