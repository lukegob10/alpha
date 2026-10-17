import { describe, expect, it, vi } from "vitest"
import type { TaskGoal, ToolApprovalDecision, ToolApprovalRequest, ToolName } from "@alpha-code/types"

import { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import type { ToolUse } from "../../../shared/tools"
import { executeGoalTool, goalToolResponse } from "../GoalTools"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { ToolRegistry, type ToolExecutionContext } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { isToolAllowedForMode } from "../validateToolUse"
import { filterNativeToolsForMode } from "../../prompts/tools/filter-tools-for-mode"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { createAgentResponse } from "../../agent/AgentResponse"
import { checkAutoApproval } from "../../auto-approval"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalStateStore, TaskGoalEnvelope } from "../../task-persistence/TaskGoalStore"
import { buildInternalTaskEnvelope } from "../../agent/InternalTaskEnvelope"

const goal = (changes: Partial<TaskGoal> = {}): TaskGoal => ({
	goalId: "goal-one",
	taskId: "task-one",
	objective: "Verify and finish the requested cleanup",
	status: "active",
	tokensUsed: 12,
	timeUsedMs: 50,
	version: 1,
	controlVersion: 1,
	createdAt: 1,
	updatedAt: 1,
	maxContinuations: 20,
	continuationCount: 0,
	recoveryDeferred: false,
	...changes,
})

function fixture(initial?: TaskGoal) {
	const cancellation = new AbortController()
	const pushToolResult = vi.fn()
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(true),
		pushToolResult,
		setResultMetadata: vi.fn(),
		handleError: vi.fn(async (_action: string, error: Error) => {
			pushToolResult(JSON.stringify({ status: "error", message: error.message }))
		}),
	} satisfies ToolCallbacks
	const task = {
		taskKind: "primary" as "primary" | "subagent",
		parentTaskId: undefined as string | undefined,
		orchestrationParentTaskId: undefined as string | undefined,
		abort: false,
		getTaskLifetimeCancellationSignal: vi.fn(() => cancellation.signal),
		getGoal: vi.fn().mockResolvedValue(initial),
		createGoal: vi.fn().mockResolvedValue(goal()),
		updateGoalStatus: vi.fn().mockResolvedValue(goal({ status: "complete" })),
	}
	const execute = (name: ToolName, nativeArgs: unknown, signal?: AbortSignal) =>
		executeGoalTool({
			task: task as unknown as Task,
			callbacks,
			call: { type: "tool_use", name, id: "goal-call", nativeArgs, params: {}, partial: false } as ToolUse,
			signal,
		})
	const response = () => JSON.parse(pushToolResult.mock.calls.at(-1)![0])
	return { task, callbacks, cancellation, execute, response }
}

class TransactionalGoalStore implements GoalStateStore {
	private state: TaskGoalEnvelope = { schemaVersion: 1, taskId: "task-one", usageReceipts: [] }

	async read(): Promise<TaskGoalEnvelope> {
		return structuredClone(this.state)
	}

	async transact<T>(operation: (state: TaskGoalEnvelope) => T): Promise<T> {
		const next = structuredClone(this.state)
		const result = operation(next)
		this.state = next
		return structuredClone(result)
	}
}

function controllerFixture() {
	const test = fixture()
	let id = 0
	const controller = new GoalController({
		taskId: "task-one",
		store: new TransactionalGoalStore(),
		newId: () => `goal-${++id}`,
		now: () => 20,
	})
	test.task.getGoal.mockImplementation(() => controller.get())
	test.task.createGoal.mockImplementation((...args: Parameters<Task["createGoal"]>) => {
		const [input, authority, signal] = args
		return controller.create(
			input,
			authority.source === "user" ? "user" : "tool-approved",
			{ goalId: authority.expectedGoalId ?? null, version: authority.expectedVersion },
			() => !test.task.abort && !test.cancellation.signal.aborted && !signal?.aborted,
		)
	})
	test.task.updateGoalStatus.mockImplementation((...args: Parameters<Task["updateGoalStatus"]>) => {
		const [status, authority, signal] = args
		return controller.updateStatus(
			status,
			{
				goalId: authority.expectedGoalId!,
				version: authority.expectedVersion,
				controlVersion: authority.expectedControlVersion,
			},
			() => !test.task.abort && !test.cancellation.signal.aborted && !signal?.aborted,
		)
	})
	return { ...test, controller }
}

describe("native goal tool contract", () => {
	it("reads absence without authorizing or creating a goal", async () => {
		const test = fixture()
		await test.execute("get_goal", {})
		expect(test.response()).toEqual({ goal: null, remainingTokens: null, completionBudgetReport: null })
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
		expect(test.task.createGoal).not.toHaveBeenCalled()
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it("requires concrete human approval for creation and preserves the requested budget", async () => {
		const test = fixture()
		const created = goal({ objective: "Finish the cleanup", tokenBudget: 500 })
		test.task.createGoal.mockResolvedValue(created)
		await test.execute("create_goal", { objective: "  Finish the cleanup  ", token_budget: 500 })
		expect(test.callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
			"tool",
			JSON.stringify({
				tool: "goal",
				goalActivity: { operation: "create", objective: "Finish the cleanup", tokenBudget: 500 },
			}),
			undefined,
			true,
			true,
		)
		expect(test.task.createGoal).toHaveBeenCalledExactlyOnceWith(
			{ objective: "Finish the cleanup", tokenBudget: 500 },
			{ source: "tool", approved: true, expectedGoalId: null },
			undefined,
		)
		expect(test.response()).toEqual({ goal: created, remainingTokens: 488, completionBudgetReport: null })
		expect(test.callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "success" })
	})

	it("omits a token budget when the user did not request one", async () => {
		const test = fixture()
		await test.execute("create_goal", { objective: "Finish cleanup" })
		expect(test.task.createGoal).toHaveBeenCalledWith(
			{ objective: "Finish cleanup" },
			{ source: "tool", approved: true, expectedGoalId: null },
			undefined,
		)
		expect(test.response().remainingTokens).toBeNull()
	})

	it.each(["active", "paused", "blocked", "budget_limited", "usage_limited"] as const)(
		"does not ask to replace an unfinished %s goal",
		async (status) => {
			const test = fixture(goal({ status }))
			await test.execute("create_goal", { objective: "New objective" })
			expect(test.callbacks.askApproval).not.toHaveBeenCalled()
			expect(test.task.createGoal).not.toHaveBeenCalled()
			expect(test.response()).toMatchObject({ status: "error", message: "This task has an unfinished goal." })
			expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
		},
	)

	it("allows explicit creation after completion", async () => {
		const before = goal({ status: "complete", version: 3 })
		const test = fixture(before)
		await test.execute("create_goal", { objective: "The next objective" })
		expect(test.task.createGoal).toHaveBeenCalledExactlyOnceWith(
			{ objective: "The next objective" },
			{ source: "tool", approved: true, expectedGoalId: before.goalId, expectedVersion: before.version },
			undefined,
		)
	})

	it.each([
		{ objective: " " },
		{ objective: "x".repeat(4001) },
		{ objective: "Clean up", token_budget: 0 },
		{ objective: "Clean up", token_budget: -1 },
		{ objective: "Clean up", token_budget: 1.5 },
		{ objective: "Clean up", token_budget: Number.MAX_SAFE_INTEGER + 1 },
		{ objective: "Clean up", maxContinuations: 1000 },
	])("rejects invalid creation before approval: %o", async (args) => {
		const test = fixture()
		await test.execute("create_goal", args)
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
		expect(test.task.createGoal).not.toHaveBeenCalled()
		expect(test.response().status).toBe("error")
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it("accepts the upstream objective limit as Unicode characters", async () => {
		const test = fixture()
		await test.execute("create_goal", { objective: "😀".repeat(4000) })
		expect(test.task.createGoal).toHaveBeenCalledOnce()
	})

	it.each(["active", "budget_limited", "usage_limited", "cancelled", "clear"])(
		"does not permit the model to set %s",
		async (status) => {
			const test = fixture(goal())
			await test.execute("update_goal", { status })
			expect(test.task.updateGoalStatus).not.toHaveBeenCalled()
			expect(test.callbacks.askApproval).not.toHaveBeenCalled()
			expect(test.response().status).toBe("error")
		},
	)

	it.each(["complete", "blocked"] as const)("records %s without conferring resume authority", async (status) => {
		const before = goal({ tokenBudget: 500 })
		const after = goal({ status, tokensUsed: 18, tokenBudget: 500, version: 2 })
		const test = fixture(before)
		test.task.updateGoalStatus.mockResolvedValue(after)
		await test.execute("update_goal", { status })
		expect(test.task.updateGoalStatus).toHaveBeenCalledExactlyOnceWith(
			status,
			{ source: "tool", expectedGoalId: before.goalId, expectedControlVersion: before.controlVersion },
			undefined,
		)
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
		expect(test.response()).toEqual(goalToolResponse(after, status === "complete"))
		expect(test.response().completionBudgetReport).toBe(
			status === "complete" ? "Goal completed. Final token usage: 18 of 500." : null,
		)
	})

	it("binds pause consent to the reviewed goal identity and control version", async () => {
		const before = goal({ tokenBudget: 500, version: 4, controlVersion: 2 })
		const test = fixture(before)
		test.task.updateGoalStatus.mockResolvedValue(goal({ status: "paused", tokenBudget: 500, version: 5 }))
		await test.execute("update_goal", { status: "paused" })
		expect(test.callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
			"tool",
			JSON.stringify({
				tool: "goal",
				goalActivity: { operation: "pause", objective: before.objective, tokenBudget: 500 },
			}),
			undefined,
			true,
			true,
		)
		expect(test.task.updateGoalStatus).toHaveBeenCalledExactlyOnceWith(
			"paused",
			{ source: "tool", approved: true, expectedGoalId: before.goalId, expectedControlVersion: 2 },
			undefined,
		)
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it("returns the budget limit that outranks a requested pause", async () => {
		const test = fixture(goal({ tokenBudget: 10 }))
		test.task.updateGoalStatus.mockResolvedValue(goal({ status: "budget_limited", tokenBudget: 10 }))
		await test.execute("update_goal", { status: "paused" })
		expect(test.response().goal.status).toBe("budget_limited")
		expect(test.response().remainingTokens).toBe(0)
	})

	it("preserves a stale approval rejection as an error with one terminal result", async () => {
		const test = fixture(goal())
		test.task.updateGoalStatus.mockRejectedValue(new Error("The goal changed while approval was pending."))
		await test.execute("update_goal", { status: "paused" })
		expect(test.response()).toEqual({ status: "error", message: "The goal changed while approval was pending." })
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it.each(["create_goal", "update_goal"] as const)("keeps a declined %s nonmutating", async (name) => {
		const test = fixture(name === "update_goal" ? goal() : undefined)
		test.callbacks.askApproval.mockResolvedValue(false)
		await test.execute(name, name === "create_goal" ? { objective: "Cleanup" } : { status: "paused" })
		expect(test.task.createGoal).not.toHaveBeenCalled()
		expect(test.task.updateGoalStatus).not.toHaveBeenCalled()
		expect(test.response().status).toBe("denied")
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it.each(["task", "signal", "lifetime"] as const)(
		"cancels late creation approval on %s cancellation",
		async (source) => {
			const test = fixture()
			const signal = new AbortController()
			let finishApproval!: (approved: boolean) => void
			let notifyStarted!: () => void
			const started = new Promise<void>((resolve) => (notifyStarted = resolve))
			test.callbacks.askApproval.mockImplementation(() => {
				notifyStarted()
				return new Promise((resolve) => (finishApproval = resolve))
			})
			const execution = test.execute("create_goal", { objective: "Cleanup" }, signal.signal)
			await started
			if (source === "task") test.task.abort = true
			if (source === "signal") signal.abort()
			if (source === "lifetime") test.cancellation.abort()
			finishApproval(true)
			await execution
			expect(test.task.createGoal).not.toHaveBeenCalled()
			expect(test.response().status).toBe("cancelled")
			expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
		},
	)

	it.each(["subagent", "delegated", "orchestration"] as const)(
		"denies goal reads and writes to a %s child",
		async (kind) => {
			const test = fixture(goal())
			if (kind === "subagent") test.task.taskKind = "subagent"
			if (kind === "delegated") test.task.parentTaskId = "parent-task"
			if (kind === "orchestration") test.task.orchestrationParentTaskId = "orchestration-parent"
			await test.execute("get_goal", {})
			await test.execute("create_goal", { objective: "A child goal" })
			await test.execute("update_goal", { status: "complete" })
			expect(test.callbacks.pushToolResult).toHaveBeenCalledTimes(3)
			expect(
				test.callbacks.pushToolResult.mock.calls.every(([value]) => JSON.parse(value).status === "denied"),
			).toBe(true)
			expect(test.task.getGoal).not.toHaveBeenCalled()
			expect(test.task.createGoal).not.toHaveBeenCalled()
			expect(test.task.updateGoalStatus).not.toHaveBeenCalled()
		},
	)

	it("keeps partially streamed calls side-effect free", async () => {
		const test = fixture()
		await executeGoalTool({
			task: test.task,
			callbacks: test.callbacks,
			call: { name: "create_goal", nativeArgs: { objective: "Part" }, partial: true },
		} as unknown as ToolExecutionContext)
		expect(test.task.getGoal).not.toHaveBeenCalled()
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
		expect(test.callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("treats an unbudgeted completion as a completion without inventing a budget report", () => {
		expect(goalToolResponse(goal({ status: "complete" }), true).completionBudgetReport).toBeNull()
	})
})

describe("goal approval against the serialized controller", () => {
	it.each([
		{ tokens: 3, status: "paused", remaining: 7 },
		{ tokens: 12, status: "budget_limited", remaining: 0 },
	])(
		"preserves $status after descendant billing while pause approval is open",
		async ({ tokens, status, remaining }) => {
			const test = controllerFixture()
			const before = await test.controller.create({ objective: "Finish cleanup", tokenBudget: 10 }, "user")
			test.callbacks.askApproval.mockImplementation(async () => {
				await test.controller.recordUsage("descendant-drain", tokens, 0, before.goalId)
				return true
			})
			await test.execute("update_goal", { status: "paused" })
			expect(test.callbacks.handleError).not.toHaveBeenCalled()
			expect(test.response()).toMatchObject({
				goal: { goalId: before.goalId, status, tokensUsed: tokens, tokenBudget: 10 },
				remainingTokens: remaining,
				completionBudgetReport: null,
			})
			expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(await test.controller.get()).toMatchObject({ status, tokensUsed: tokens })
		},
	)

	it.each([undefined, 30])("revokes pending pause consent after host resume with budget %s", async (tokenBudget) => {
		const test = controllerFixture()
		const before = await test.controller.create({ objective: "Finish cleanup", tokenBudget: 10 }, "user")
		test.callbacks.askApproval.mockImplementation(async () => {
			await test.controller.resume(tokenBudget === undefined ? {} : { tokenBudget })
			return true
		})
		await test.execute("update_goal", { status: "paused" })
		expect(test.response()).toMatchObject({ status: "error", message: expect.stringContaining("Goal changed") })
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(await test.controller.get()).toMatchObject({
			goalId: before.goalId,
			status: "active",
			tokenBudget: tokenBudget ?? 10,
			controlVersion: before.controlVersion + 1,
		})
	})

	it.each(["absent", "complete"] as const)(
		"rejects creation after the reviewed %s goal was replaced",
		async (initial) => {
			const test = controllerFixture()
			if (initial === "complete") {
				await test.controller.create({ objective: "Previous cleanup" }, "user")
				await test.controller.updateStatus("complete")
			}
			let replacement!: TaskGoal
			test.callbacks.askApproval.mockImplementation(async () => {
				await test.controller.clear()
				replacement = await test.controller.create({ objective: "User's newer objective" }, "user")
				await test.controller.updateStatus("complete")
				return true
			})
			await test.execute("create_goal", { objective: "Reviewed tool objective" })
			expect(test.response()).toMatchObject({ status: "error", message: expect.stringContaining("Goal changed") })
			expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(await test.controller.get()).toMatchObject({
				goalId: replacement.goalId,
				objective: "User's newer objective",
				status: "complete",
			})
		},
	)
})

describe("canonical goal tool availability", () => {
	const names = (tools: ReturnType<typeof getNativeTools>) =>
		tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))
	const goals = ["create_goal", "get_goal", "update_goal"]

	it.each([
		{ name: "create_goal" as const, args: { objective: "Finish cleanup", token_budget: 200 } },
		{ name: "get_goal" as const, args: {} },
		{ name: "update_goal" as const, args: { status: "complete" } },
	])("dispatches parsed $name arguments through the same canonical registry", async ({ name, args }) => {
		const test = fixture(name === "create_goal" ? undefined : goal())
		const call = NativeToolCallParser.parseToolCall({ id: name, name, arguments: JSON.stringify(args) })
		if (!call || call.type !== "tool_use") throw new Error("Expected a parsed native goal tool")
		expect(call.nativeArgs).toEqual(args)
		const registry = new ToolRegistry()
		const descriptor = registry.resolve(name)
		expect(descriptor?.statusSource).toBe("handler")
		await descriptor!.execute({ task: test.task as unknown as Task, callbacks: test.callbacks, call })
		expect(test.callbacks.handleError).not.toHaveBeenCalled()
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(test.response().goal).toBeDefined()
	})

	it("preserves unsupported parsed fields so strict validation cannot silently accept them", async () => {
		const test = fixture(goal())
		const args = { status: "complete", token_budget: 1000 }
		const call = NativeToolCallParser.parseToolCall({
			id: "unsupported-goal-budget-change",
			name: "update_goal",
			arguments: JSON.stringify(args),
		})
		if (!call || call.type !== "tool_use") throw new Error("Expected a parsed native goal tool")
		expect(call.nativeArgs).toEqual(args)
		await new ToolRegistry()
			.resolve("update_goal")!
			.execute({ task: test.task as unknown as Task, callbacks: test.callbacks, call })
		expect(test.response().status).toBe("error")
		expect(test.task.updateGoalStatus).not.toHaveBeenCalled()
	})

	it("captures root Code schemas and executable task effects together", () => {
		const schemas = filterNativeToolsForMode(getNativeTools(), "code", [], {})
		const surface = createTaskToolSurface({ schemas, mode: "code" })
		expect(names(schemas)).toEqual(expect.arrayContaining(goals))
		for (const name of goals) expect(surface.isCallable(name)).toBe(true)
		expect(surface.resolve("create_goal")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "task",
			requiresApproval: true,
		})
		expect(surface.resolve("update_goal")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "task",
			requiresApproval: true,
		})
		expect(surface.resolve("get_goal")?.capabilities).toMatchObject({
			concurrency: "serial",
			sideEffects: "none",
			requiresApproval: false,
		})
	})

	it("keeps explicit independent-task creation alongside goals without reviving legacy delegation", () => {
		const schemas = getNativeTools({ crossTaskRole: "root", includeCreateTaskSchema: true })
		const surface = createTaskToolSurface({ schemas, mode: "code" })
		expect(names(schemas)).toContain("create_thread")
		expect(surface.isCallable("create_thread")).toBe(true)
		for (const name of goals) expect(surface.isCallable(name)).toBe(true)
		expect(names(schemas)).not.toContain("new_task")
		expect(surface.resolve("new_task")).toBeUndefined()
	})

	it.each(["architect", "retired-saved-mode"])("retains only inspection for %s", (mode) => {
		const schemas = filterNativeToolsForMode(getNativeTools(), mode, [], {})
		const surface = createTaskToolSurface({ schemas, mode: "architect" })
		expect(names(schemas)).toContain("get_goal")
		expect(surface.isCallable("get_goal")).toBe(true)
		for (const name of ["create_goal", "update_goal"]) {
			expect(names(schemas)).not.toContain(name)
			expect(surface.isCallable(name)).toBe(false)
			expect(isToolAllowedForMode(name, "architect", [])).toBe(false)
		}
	})

	it.each([{ taskKind: "subagent" as const }, { crossTaskRole: "child" as const }, { diagnosticSession: true }])(
		"keeps goal schemas out of restricted task catalogs: %o",
		(options) => {
			const schemas = getNativeTools(options)
			const registry = new ToolRegistry({ nativeTools: schemas })
			for (const name of goals) {
				expect(names(schemas)).not.toContain(name)
				expect(registry.resolve(name)).toBeUndefined()
			}
		},
	)

	it("honors disabled goal inspection in the schema and executable policy", () => {
		const schemas = filterNativeToolsForMode(getNativeTools({ planMode: true }), "architect", [], {}, undefined, {
			disabledTools: ["get_goal"],
		})
		const surface = createTaskToolSurface({ schemas, mode: "architect", disabledTools: ["get_goal"] })
		expect(names(schemas)).not.toContain("get_goal")
		expect(surface.isCallable("get_goal")).toBe(false)
		expect(isToolAllowedForMode("get_goal", "architect", [], { get_goal: false })).toBe(false)
	})
})

describe("goal approval through the shared scheduler", () => {
	function schedulerFixture(
		name: "create_goal" | "get_goal" | "update_goal",
		mode: "ask" | "auto" | "bypass",
		decision: ToolApprovalDecision,
	) {
		const test = fixture(name === "create_goal" ? undefined : goal())
		const schemas = getNativeTools()
		const surface = createTaskToolSurface({ schemas, mode: "code", approvalMode: mode, autoApprovalEnabled: true })
		const content: ToolExecutionHost["userMessageContent"] = []
		const requestToolApproval = vi.fn(async (request: ToolApprovalRequest, reviewMessage?: string) => {
			const automatic = await checkAutoApproval({
				state: { approvalMode: mode },
				ask: request.askType,
				text: reviewMessage,
				isProtected: request.forceApproval,
				requiresExplicitApproval: request.requiresExplicitApproval,
			})
			expect(automatic.decision).toBe("ask")
			return decision
		})
		const host: ToolExecutionHost = {
			taskId: "goal-approval-task",
			taskKind: "primary",
			userMessageContent: content,
			taskFacade: test.task as unknown as Task,
			requestToolApproval,
			say: vi.fn(),
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent(result) {
				if (content.some((item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id))
					return false
				content.push(result)
				return true
			},
		}
		const run = (signal?: AbortSignal) =>
			new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				signal,
				preserveAbortedResults: true,
			}).run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "explicit-goal-change",
						name,
						arguments:
							name === "create_goal"
								? { objective: "Finish cleanup" }
								: name === "get_goal"
									? {}
									: { status: "paused" },
					},
				]),
			)
		return { ...test, content, requestToolApproval, run }
	}

	it("preserves valid goal JSON when the objective requires maximal string escaping", async () => {
		const test = schedulerFixture("get_goal", "auto", { decision: "approve_once" })
		const objective = "\u0000".repeat(4000)
		test.task.getGoal.mockResolvedValue(goal({ objective }))
		const outcome = await test.run()
		expect(outcome.results).toMatchObject([{ status: "success", truncated: false }])
		const content = outcome.results[0]?.content
		expect(typeof content).toBe("string")
		expect(JSON.parse(content as string).goal.objective).toBe(objective)
		expect(test.requestToolApproval).not.toHaveBeenCalled()
	})

	it.each(["ask", "auto", "bypass"] as const)(
		"requires a human once decision for create and pause in %s",
		async (mode) => {
			for (const name of ["create_goal", "update_goal"] as const) {
				const test = schedulerFixture(name, mode, { decision: "approve_once" })
				const outcome = await test.run()
				expect(test.requestToolApproval).toHaveBeenCalledOnce()
				expect(test.requestToolApproval.mock.calls[0][0]).toMatchObject({
					toolName: name,
					forceApproval: true,
					requiresExplicitApproval: true,
					availableDecisions: ["approve_once", "deny", "abort"],
				})
				expect(outcome.results).toMatchObject([{ callId: "explicit-goal-change", status: "success" }])
				expect(test.content).toHaveLength(1)
				expect(
					name === "create_goal" ? test.task.createGoal : test.task.updateGoalStatus,
				).toHaveBeenCalledOnce()
			}
		},
	)

	it.each(["deny", "approve_session"] as const)(
		"does not mutate from an unavailable %s decision",
		async (decision) => {
			const test = schedulerFixture("create_goal", "auto", { decision })
			const outcome = await test.run()
			expect(test.task.createGoal).not.toHaveBeenCalled()
			expect(outcome.results).toMatchObject([{ status: decision === "deny" ? "denied" : "error" }])
			expect(test.content).toHaveLength(1)
		},
	)

	it("finalizes cancellation once while a human goal approval is pending", async () => {
		const test = schedulerFixture("create_goal", "auto", { decision: "approve_once" })
		const cancellation = new AbortController()
		let notifyStarted!: () => void
		const started = new Promise<void>((resolve) => (notifyStarted = resolve))
		let finishApproval!: (value: ToolApprovalDecision) => void
		test.requestToolApproval.mockImplementation(() => {
			notifyStarted()
			return new Promise((resolve) => (finishApproval = resolve))
		})
		const execution = test.run(cancellation.signal)
		await started
		cancellation.abort()
		const outcome = await execution
		finishApproval({ decision: "approve_once" })
		expect(test.task.createGoal).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "cancelled" }])
		expect(test.content).toHaveLength(1)
	})

	it("settles an accepted spawn once when the host rejects its stopped goal owner", async () => {
		const test = controllerFixture()
		const owner = await test.controller.create({ objective: "Finish cleanup", tokenBudget: 10 }, "user")
		await test.controller.recordUsage("parent-response", 10, 0, owner.goalId)
		const policy = {
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: false,
		}
		const child = buildInternalTaskEnvelope({
			id: "limited-child",
			parentTaskId: owner.taskId,
			objective: "Inspect cleanup",
			agentKind: "explore",
			parentPolicy: policy,
			requestedPolicy: policy,
			workspaceRoots: ["F:/workspace"],
		})
		const provider = {
			prepareSubagentGroup: vi.fn(async () => ({
				group: {
					groupId: "limited-group",
					agents: [{ nickname: "Reviewer", role: "explore", objective: "Inspect cleanup" }],
				},
				envelopes: [child],
			})),
			launchPreparedSubagentGroup: vi.fn(async () => {
				const current = await test.controller.get()
				if (current?.goalId !== owner.goalId || current.status !== "active") {
					throw new Error("The owning goal stopped before child admission.")
				}
				throw new Error("This fixture must never start a provider request.")
			}),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = Object.assign(test.task, { providerRef: { deref: () => provider }, recordToolError: vi.fn() })
		const surface = createTaskToolSurface({ schemas: getNativeTools(), mode: "code" })
		const content: ToolExecutionHost["userMessageContent"] = []
		const outcome = await new ToolScheduler({
			executionHost: {
				taskId: owner.taskId,
				taskKind: "primary",
				taskFacade: task as unknown as Task,
				userMessageContent: content,
				requestToolApproval: vi.fn(async () => ({ decision: "approve_once" as const })),
				say: vi.fn(),
				recordToolUsage: vi.fn(),
				pushToolResultToUserContent(result) {
					if (content.some((item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id))
						return false
					content.push(result)
					return true
				},
			},
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
		}).run(
			createAgentResponse([
				{
					type: "tool_call",
					id: "limited-spawn",
					name: "spawn_agent",
					arguments: { task_name: "cleanup_review", message: "Inspect cleanup", agent_type: "explorer" },
				},
			]),
		)
		expect(outcome.results).toMatchObject([{ callId: "limited-spawn", status: "error" }])
		expect(content).toHaveLength(1)
		expect(provider.launchPreparedSubagentGroup).toHaveBeenCalledOnce()
		expect(provider.cancelPreparedSubagentGroup).toHaveBeenCalledOnce()
		expect(await test.controller.get()).toMatchObject({
			goalId: owner.goalId,
			status: "budget_limited",
			tokensUsed: 10,
		})
	})
})

describe("goal approval through the actual Task authority boundary", () => {
	it("leaves a freshly resumed goal admission intact when an older pause approval becomes stale", async () => {
		const test = controllerFixture()
		await test.controller.create({ objective: "Finish cleanup" }, "user")
		const actualTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-one",
			taskKind: "primary",
			abort: false,
			abandoned: false,
			isPaused: false,
			_taskMode: "code",
			taskModeReady: Promise.resolve(),
			taskCancellationController: new AbortController(),
			goalController: test.controller,
			goalSteeringGeneration: 0,
			messageQueueService: { hasUnconsumedInput: () => false },
			hasPendingAgentMessages: () => false,
			wakeGoalFromHost: vi.fn(async () => undefined),
		}) as Task
		let started!: () => void
		const asking = new Promise<void>((resolve) => (started = resolve))
		let approve!: (approved: boolean) => void
		test.callbacks.askApproval.mockImplementation(() => {
			started()
			return new Promise((resolve) => (approve = resolve))
		})
		const execution = executeGoalTool({
			task: actualTask,
			callbacks: test.callbacks,
			call: {
				type: "tool_use",
				id: "stale-pause-approval",
				name: "update_goal",
				nativeArgs: { status: "paused" },
				params: {},
				partial: false,
			},
		})
		await asking
		const resumed = await actualTask.resumeGoal()
		const admission = actualTask["goalInputAdmission"](resumed)
		expect(await admission.canWake()).toBe(true)
		approve(true)
		await execution
		expect(test.response()).toMatchObject({ status: "error", message: expect.stringContaining("Goal changed") })
		expect(await actualTask.getGoal()).toMatchObject({ status: "active", controlVersion: resumed.controlVersion })
		expect(await admission.canWake()).toBe(true)
		expect(test.callbacks.pushToolResult).toHaveBeenCalledOnce()
	})
})
