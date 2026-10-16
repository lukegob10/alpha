import { customToolRegistry } from "@alpha-code/core"
import { parametersSchema as z, type ApprovalMode, type CustomToolDefinition } from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../../agent/ToolScheduler"
import { checkAutoApproval } from "../../auto-approval"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"

const registeredNames = new Set<string>()

afterEach(() => {
	for (const name of registeredNames) customToolRegistry.unregister(name)
	registeredNames.clear()
})

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function fixture(
	options: {
		name?: string
		mode?: string
		approvalMode?: ApprovalMode
		disabled?: boolean
		parameters?: CustomToolDefinition["parameters"]
	} = {},
) {
	const name = options.name ?? "astra_custom_policy_effect"
	const order: string[] = []
	const execute = vi.fn<CustomToolDefinition["execute"]>(async () => {
		order.push("execute")
		return "external effect completed"
	})
	customToolRegistry.register({
		name,
		description: "Custom external effect",
		parameters: options.parameters,
		execute,
	})
	registeredNames.add(name)
	const registry = new ToolRegistry({ includeBuiltIns: false, includeCustomTools: true })
	const mode = options.mode ?? "code"
	const surface = createTaskToolSurface({
		registry,
		mode,
		cwd: process.cwd(),
		approvalMode: options.approvalMode ?? "ask",
		disabledTools: options.disabled ? [name] : [],
	})
	const getTaskMode = vi.fn(async () => "code")
	const askApproval = vi.fn<NonNullable<ToolExecutionHost["askApproval"]>>(async () => {
		order.push("approval")
		return { response: "yesButtonClicked" }
	})
	const host: ToolExecutionHost = {
		taskId: "astra-custom-tool-policy-task",
		cwd: process.cwd(),
		taskFacade: { getTaskMode } as unknown as Task,
		userMessageContent: [],
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		askApproval,
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const onEffectStart = vi.fn<NonNullable<ToolSchedulerOptions["onEffectStart"]>>(async () => {
		order.push("effect-start")
	})
	const run = (argumentsValue: unknown = {}, overrides: Partial<ToolSchedulerOptions> = {}) =>
		new ToolScheduler({
			executionHost: host,
			registry,
			mode,
			policy: surface.policy,
			experiments: { customTools: true },
			preserveAbortedResults: true,
			onEffectStart,
			...overrides,
		}).run([{ type: "tool_call", id: "custom-effect-call", name, arguments: argumentsValue }])
	return { name, order, execute, host, askApproval, onEffectStart, getTaskMode, registry, surface, run }
}

describe("custom tool policy and effect admission", () => {
	it("returns one denied result without invoking or journaling a denied effect", async () => {
		const f = fixture()
		f.askApproval.mockResolvedValue({ response: "noButtonClicked" })

		const outcome = await f.run()

		expect(f.askApproval).toHaveBeenCalledOnce()
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({
			status: "denied",
			failure: { reason: "approval_denied", effectsStarted: "no" },
		})
		expect(f.host.userMessageContent).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "custom-effect-call", is_error: true }),
		])
	})

	it.each<ApprovalMode>(["ask", "auto", "bypass"])(
		"settles %s through the approval host before recording and executing the effect",
		async (approvalMode) => {
			const f = fixture({ approvalMode, parameters: z.object({ count: z.number().default(3) }) })

			const outcome = await f.run()

			expect(f.surface.policy.approval.mode).toBe(approvalMode)
			expect(f.order).toEqual(["approval", "effect-start", "execute"])
			expect(f.askApproval).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "custom_tool", name: f.name, arguments: { count: 3 } }),
				undefined,
				false,
			)
			expect(f.execute).toHaveBeenCalledWith(
				{ count: 3 },
				{ mode: "code", task: f.host.taskFacade, signal: expect.any(AbortSignal) },
			)
			expect(outcome.results).toEqual([
				expect.objectContaining({ status: "success", content: "external effect completed" }),
			])
			expect(f.host.userMessageContent).toHaveLength(1)
		},
	)

	it("does not let a custom name impersonate a built-in automatic approval", async () => {
		const f = fixture({ name: "finishTask" })
		f.askApproval.mockImplementation(async (ask, text) => {
			const decision = await checkAutoApproval({ state: { approvalMode: "ask" }, ask, text })
			expect(decision).toEqual({ decision: "ask" })
			return { response: "noButtonClicked" }
		})

		const outcome = await f.run()

		expect(f.askApproval).toHaveBeenCalledOnce()
		expect(f.execute).not.toHaveBeenCalled()
		expect(outcome.results[0].status).toBe("denied")
	})

	it("retains the captured mode when live task settings change during approval", async () => {
		const f = fixture()
		f.getTaskMode.mockResolvedValue("architect")
		f.askApproval.mockImplementation(async () => {
			f.getTaskMode.mockResolvedValue("architect")
			return { response: "yesButtonClicked" }
		})

		const outcome = await f.run()

		expect(outcome.results[0].status).toBe("success")
		expect(f.execute).toHaveBeenCalledWith(
			{},
			{ mode: "code", task: f.host.taskFacade, signal: expect.any(AbortSignal) },
		)
		expect(f.getTaskMode).not.toHaveBeenCalled()
	})

	it("fails closed for a direct custom adapter call without a captured mode", async () => {
		const f = fixture()
		const askApproval = vi.fn(async () => true)
		await expect(
			f.registry.resolve(f.name)!.execute({
				task: f.host.taskFacade!,
				call: {
					type: "tool_use",
					id: "direct",
					name: "custom_tool",
					params: {},
					partial: false,
					nativeArgs: {},
				},
				callbacks: { askApproval, handleError: vi.fn(), pushToolResult: vi.fn() },
			}),
		).rejects.toThrow()

		expect(askApproval).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.getTaskMode).not.toHaveBeenCalled()
	})

	it("does not execute until the approved effect is durably admitted", async () => {
		const f = fixture()
		const entered = deferred()
		const saved = deferred()
		f.onEffectStart.mockImplementation(async () => {
			entered.resolve()
			await saved.promise
			f.order.push("saved-effect")
		})
		const running = f.run()
		await entered.promise
		expect(f.execute).not.toHaveBeenCalled()
		saved.resolve()
		const outcome = await running

		expect(f.order).toEqual(["approval", "saved-effect", "execute"])
		expect(outcome.results[0].status).toBe("success")
	})

	it("fails the batch without invoking the callback when durable effect admission fails", async () => {
		const f = fixture()
		f.onEffectStart.mockRejectedValue(new Error("effect journal unavailable"))

		const outcome = await f.run()

		expect(f.execute).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({
			status: "failed",
			failure: { kind: "effect_fence", callId: "custom-effect-call" },
		})
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("error")
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("does not start the callback when Stop arrives during effect admission", async () => {
		const f = fixture()
		const controller = new AbortController()
		f.onEffectStart.mockImplementation(async () => {
			controller.abort()
		})

		const outcome = await f.run({}, { signal: controller.signal })

		expect(f.onEffectStart).toHaveBeenCalledOnce()
		expect(f.execute).not.toHaveBeenCalled()
		expect(outcome.results).toEqual([expect.objectContaining({ status: "cancelled" })])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("does not request approval or execute after the transcript fence rejects admission", async () => {
		const f = fixture()
		const outcome = await f.run(
			{},
			{
				beforeEffect: async () => {
					throw new Error("assistant transcript unavailable")
				},
			},
		)

		expect(f.askApproval).not.toHaveBeenCalled()
		expect(f.onEffectStart).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
		expect(outcome.status).toBe("failed")
		expect(outcome.results).toEqual([expect.objectContaining({ status: "error" })])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("forwards cancellation to an in-flight custom callback and waits for its cleanup", async () => {
		const f = fixture()
		const controller = new AbortController()
		const entered = deferred()
		const cleanup = vi.fn()
		f.execute.mockImplementation(async (_args, { signal }) => {
			expect(signal).toBeInstanceOf(AbortSignal)
			entered.resolve()
			try {
				await new Promise<void>((_resolve, reject) => {
					signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
				})
				return "unreachable"
			} finally {
				cleanup()
			}
		})
		const running = f.run({}, { signal: controller.signal })
		await entered.promise
		controller.abort()
		const outcome = await running

		expect(cleanup).toHaveBeenCalledOnce()
		expect(outcome.results).toEqual([expect.objectContaining({ status: "cancelled" })])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("keeps cancellation terminal when an approval resolves in the same turn", async () => {
		const f = fixture()
		const controller = new AbortController()
		f.askApproval.mockImplementation(async () => {
			controller.abort()
			return { response: "yesButtonClicked" }
		})

		const outcome = await f.run({}, { signal: controller.signal })

		expect(f.execute).not.toHaveBeenCalled()
		expect(f.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toEqual([expect.objectContaining({ status: "cancelled" })])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it.each(["abort", "timeout"] as const)("does not invoke a custom callback after typed %s", async (decision) => {
		const f = fixture()
		f.host.requestToolApproval = vi.fn(async () => ({ decision }))

		const outcome = await f.run()

		expect(f.execute).not.toHaveBeenCalled()
		expect(f.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toEqual([
			expect.objectContaining({ status: "cancelled", ...(decision === "timeout" ? { timedOut: true } : {}) }),
		])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("returns one uncertain error after an approved external callback throws", async () => {
		const f = fixture()
		f.execute.mockRejectedValue(new Error("external callback failed"))

		const outcome = await f.run()

		expect(f.onEffectStart).toHaveBeenCalledOnce()
		expect(f.execute).toHaveBeenCalledOnce()
		expect(outcome.results).toEqual([
			expect.objectContaining({
				status: "error",
				failure: expect.objectContaining({ effectsStarted: "unknown", outcome: "unknown" }),
			}),
		])
		expect(outcome.results[0].content).toContain("external callback failed")
		expect(outcome.results[0].content).toContain("Verify the current state before retrying")
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("keeps a late callback success cancelled after Stop", async () => {
		const f = fixture()
		const controller = new AbortController()
		f.execute.mockImplementation(async () => {
			controller.abort()
			return "late successful response"
		})

		const outcome = await f.run({}, { signal: controller.signal })

		expect(f.onEffectStart).toHaveBeenCalledOnce()
		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toEqual([expect.objectContaining({ status: "cancelled" })])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it("rejects malformed arguments before asking or admitting an effect", async () => {
		const f = fixture({ parameters: z.object({ count: z.number() }) })

		const outcome = await f.run({ count: "wrong" })

		expect(f.askApproval).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
		expect(f.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toEqual([
			expect.objectContaining({
				status: "error",
				failure: expect.objectContaining({ reason: "invalid_arguments", effectsStarted: "no" }),
			}),
		])
		expect(f.host.userMessageContent).toHaveLength(1)
	})

	it.each([{ disabled: true }, { mode: "architect" }, { mode: "retired-mode" }])(
		"keeps a custom effect outside the captured authority: %j",
		async (options) => {
			const f = fixture(options)

			const outcome = await f.run()

			expect(f.askApproval).not.toHaveBeenCalled()
			expect(f.execute).not.toHaveBeenCalled()
			expect(f.onEffectStart).not.toHaveBeenCalled()
			expect(outcome.results[0].status).toBe("denied")
			expect(outcome.results[0].failure).toMatchObject({ reason: "policy_denied", effectsStarted: "no" })
			expect(f.host.userMessageContent).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: "custom-effect-call", is_error: true }),
			])
		},
	)
})
