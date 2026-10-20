import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import type { ToolApprovalDecision } from "@alpha-code/types"
import { ToolRegistry } from "../../tools/ToolRegistry"
import type { AgentToolCall } from "../AgentResponse"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

function fixture(options: Partial<ToolSchedulerOptions> = {}, catchToolErrors = false) {
	const { onEvent, ...schedulerOptions } = options
	const events: AgentTurnEvent[] = []
	const content: Anthropic.ToolResultBlockParam[] = []
	const effect = vi.fn()
	const host: ToolExecutionHost = {
		taskId: "approval-failure",
		taskKind: "primary",
		cwd: process.cwd(),
		userMessageContent: content,
		requestToolApproval: vi.fn(async () => ({ decision: "approve_once" as const })),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			if (content.some((item) => item.tool_use_id === result.tool_use_id)) return false
			content.push(result)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "execute_command",
		aliases: [],
		schema: { type: "function", function: { name: "execute_command", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
		execute: async ({ callbacks }) => {
			try {
				if (await callbacks.askApproval("command", "git status --short")) {
					effect()
					callbacks.pushToolResult("Command completed")
				}
			} catch (error) {
				if (!catchToolErrors) throw error
				await callbacks.handleError("executing command", error as Error)
			}
		},
	})
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry,
		mode: "code",
		policy: createToolPolicySnapshot({
			visibleTools: ["execute_command"],
			execution: { workspaceRoots: [process.cwd()] },
		}),
		validateCall: () => undefined,
		onEvent: async (event) => {
			events.push(event)
			await onEvent?.(event)
		},
		...schedulerOptions,
	})
	const call: AgentToolCall = {
		type: "tool_call",
		id: "approval-call",
		name: "execute_command",
		arguments: { command: "git status --short" },
	}
	return { scheduler, host, effect, events, call }
}

describe("ToolScheduler approval failure settlement", () => {
	it.each(["host rejection", "invalid decision", "unavailable decision", "persistent save rejection"] as const)(
		"closes a requested approval after %s without admitting an effect",
		async (failure) => {
			const { scheduler, host, effect, events, call } = fixture()
			if (failure === "host rejection") {
				host.requestToolApproval = async () => {
					throw new Error("Approval transport disconnected")
				}
			} else if (failure === "invalid decision") {
				host.requestToolApproval = async () => ({ decision: "unknown" }) as unknown as ToolApprovalDecision
			} else if (failure === "unavailable decision") {
				host.requestToolApproval = async () => ({ decision: "approve_session" })
			} else {
				host.persistCommandApprovalPrefix = async () => {
					throw new Error("Settings persistence failed")
				}
				host.requestToolApproval = async (request) => ({
					decision: "approve_persistently",
					amendment: request.proposedPersistentAmendment!,
				})
			}

			const outcome = await scheduler.run([call])
			const request = events.find((event) => event.type === "approval_request")
			expect(request).toBeDefined()
			expect(events.filter((event) => event.type === "approval_result")).toEqual([
				{
					type: "approval_result",
					requestId: request!.requestId,
					decision: "cancelled",
					reason: expect.any(String),
				},
			])
			expect(effect).not.toHaveBeenCalled()
			expect(outcome.results).toMatchObject([
				{
					callId: call.id,
					status: "error",
					failure: { reason: "pre_launch_rejected", effectsStarted: "no", outcome: "known" },
				},
			])
			expect(outcome.approvalCancelledCount).toBe(1)
			expect(host.userMessageContent).toHaveLength(1)
			expect(host.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: call.id,
				is_error: true,
			})
		},
	)

	it("closes native approval failure before a legacy tool handles the error", async () => {
		const { scheduler, host, effect, events, call } = fixture({}, true)
		host.requestToolApproval = async () => {
			throw new Error("Approval transport disconnected")
		}
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "cancelled" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "error" }])
	})

	it("does not publish a resolution without a request when cancellation wins approval admission", async () => {
		const { scheduler, host, effect, events, call } = fixture({ preserveAbortedResults: true })
		host.recordToolUsage = () => {
			host.abort = true
		}
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_request" || event.type === "approval_result")).toEqual(
			[],
		)
		expect(host.requestToolApproval).not.toHaveBeenCalled()
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "aborted", approvalRequestCount: 0, approvalCancelledCount: 0 })
		expect(outcome.results).toMatchObject([{ callId: call.id, status: "cancelled" }])
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("closes a request when its observer records admission and then rejects", async () => {
		const { scheduler, host, effect, events, call } = fixture({
			onEvent: async (event) => {
				if (event.type === "approval_request") throw new Error("Approval projection failed after recording")
			},
		})
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "cancelled" }])
		expect(host.requestToolApproval).not.toHaveBeenCalled()
		expect(effect).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "error" }])
	})

	it("does not publish cancellation after an approved decision observer rejects", async () => {
		const { scheduler, host, effect, events, call } = fixture(
			{
				onEvent: async (event) => {
					if (event.type === "approval_result") throw new Error("Approval resolution projection failed")
				},
			},
			true,
		)
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "approved" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "failed", failure: { kind: "effect_fence", callId: call.id } })
		expect(outcome.results).toMatchObject([{ status: "error" }])
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("unwinds a cancelled approval when its lifecycle observer loses ownership during publication", async () => {
		const controller = new AbortController()
		let ownsLifecyclePublication = true
		const { scheduler, host, effect, events, call } = fixture(
			{
				signal: controller.signal,
				onEvent: async (event) => {
					if (event.type !== "approval_result") return
					const error = new Error("Approval lifecycle owner was superseded")
					error.name = "AbortError"
					ownsLifecyclePublication = false
					controller.abort(error)
					throw error
				},
			},
			true,
		)
		host.ownsLifecyclePublication = () => ownsLifecyclePublication
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "approved" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "aborted", results: [{ callId: call.id, status: "cancelled" }] })
		expect(outcome.failure).toBeUndefined()
		expect(host.userMessageContent).toEqual([])
	})

	it("retains lifecycle storage failure when cancellation races approval publication", async () => {
		const controller = new AbortController()
		let ownsLifecyclePublication = true
		const { scheduler, host, effect, events, call } = fixture(
			{
				signal: controller.signal,
				preserveAbortedResults: true,
				onEvent: async (event) => {
					if (event.type !== "approval_result") return
					ownsLifecyclePublication = false
					controller.abort(new Error("User stopped the task"))
					throw new Error("Approval lifecycle storage unavailable")
				},
			},
			true,
		)
		host.ownsLifecyclePublication = () => ownsLifecyclePublication
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "approved" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({
			status: "failed",
			failure: { kind: "effect_fence", message: "Approval lifecycle storage unavailable" },
		})
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("retains an AbortError publication failure when a stopped scheduler still owns its lifecycle", async () => {
		const controller = new AbortController()
		const { scheduler, host, effect, events, call } = fixture(
			{
				signal: controller.signal,
				preserveAbortedResults: true,
				onEvent: async (event) => {
					if (event.type !== "approval_result") return
					controller.abort(new Error("User stopped the task"))
					const error = new Error("Approval lifecycle storage operation aborted")
					error.name = "AbortError"
					throw error
				},
			},
			true,
		)
		host.ownsLifecyclePublication = () => true
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "approved" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({
			status: "failed",
			failure: { kind: "effect_fence", message: "Approval lifecycle storage operation aborted" },
		})
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("fails the batch when failure settlement cannot be recorded without losing the tool receipt", async () => {
		const { scheduler, host, effect, events, call } = fixture(
			{
				onEvent: async (event) => {
					if (event.type === "approval_result") throw new Error("Approval lifecycle storage unavailable")
				},
			},
			true,
		)
		host.requestToolApproval = async () => {
			throw new Error("Original native approval failure")
		}
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "cancelled" }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({
			status: "failed",
			failure: { kind: "effect_fence", message: "Approval failure could not be recorded in the task lifecycle." },
		})
		expect(outcome.results).toMatchObject([{ callId: call.id, status: "error" }])
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("does not replace a completed approval with cancellation when the approved handler fails", async () => {
		const { scheduler, effect, events, call } = fixture()
		effect.mockImplementation(() => {
			throw new Error("Command process creation failed")
		})
		const outcome = await scheduler.run([call])
		expect(events.filter((event) => event.type === "approval_result")).toMatchObject([{ decision: "approved" }])
		expect(outcome.approvalCancelledCount).toBe(0)
		expect(outcome.results).toMatchObject([{ callId: call.id, status: "error" }])
	})
})
