import type Anthropic from "@anthropic-ai/sdk"
import * as path from "path"
import { tmpdir } from "os"
import { beforeAll, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AgentToolCall } from "../AgentResponse"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../ToolScheduler"
import type { ToolApprovalDecision } from "@alpha-code/types"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { clearTaskSessionApprovalGrants } from "../../auto-approval/taskSessionApprovalGrants"

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

function fixture(
	options: Partial<ToolSchedulerOptions> = {},
	execute: ToolDescriptor["execute"] = async ({ callbacks }) => {
		callbacks.pushToolResult("Completed")
	},
	readOnly = false,
) {
	const cwd = process.cwd()
	const name = readOnly ? "fixture_read" : "write_to_file"
	const content: Anthropic.ToolResultBlockParam[] = []
	const state = {
		cwd,
		taskId: "lifecycle-scheduler",
		taskKind: "primary",
		abort: false,
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		userMessageContent: content,
		userMessageContentReady: false,
		ask: vi.fn<Task["ask"]>(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		recordToolCallForStopping: vi.fn(),
		pushToolResultToUserContent: (result: Anthropic.ToolResultBlockParam) => {
			if (content.some((item) => item.tool_use_id === result.tool_use_id)) return false
			content.push(result)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const effect = vi.fn<ToolDescriptor["execute"]>(execute)
	registry.register({
		name,
		aliases: [],
		schema: {
			type: "function",
			function: { name, description: name, parameters: { type: "object", properties: {} } },
		},
		capabilities: {
			concurrency: readOnly ? "parallel" : "serial",
			sideEffects: readOnly ? "none" : "workspace",
			controlFlow: false,
			requiresApproval: false,
		},
		getConcurrencyScope: (call) => path.join(cwd, call.id ?? name),
		execute: effect,
	})
	const scheduler = new ToolScheduler({
		task: state as unknown as Task,
		registry,
		mode: "code",
		policy: createToolPolicySnapshot({ visibleTools: [name], execution: { workspaceRoots: [cwd] } }),
		validateCall: () => undefined,
		...options,
	})
	const call = (id = "call-1", extra: Record<string, unknown> = {}): AgentToolCall => ({
		type: "tool_call",
		id,
		name,
		arguments: readOnly ? extra : { path: path.join(cwd, "file.ts"), content: "Original content", ...extra },
	})
	return { scheduler, state, effect, call, cwd }
}

function commandFixture(options: Partial<ToolSchedulerOptions> = {}) {
	type CommandApproval = Awaited<ReturnType<NonNullable<ToolCallbacks["askCommandApproval"]>>>
	const approvals: CommandApproval[] = []
	const effect = vi.fn<(argumentsValue: unknown) => void>()
	const host: ToolExecutionHost = {
		taskId: "lifecycle-command-receipts",
		cwd: process.cwd(),
		userMessageContent: [],
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "execute_command",
		aliases: [],
		schema: { type: "function", function: { name: "execute_command", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
		execute: async ({ call, callbacks }) => {
			if (!callbacks.askCommandApproval) throw new Error("Missing native command approval callback")
			const command = call.nativeArgs && "command" in call.nativeArgs ? call.nativeArgs.command : undefined
			if (typeof command !== "string") throw new Error("Missing native command arguments")
			const approval = await callbacks.askCommandApproval("command", command)
			approvals.push(approval)
			if (approval.approved) {
				effect(call.nativeArgs)
				callbacks.pushToolResult("Command completed")
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
		...options,
	})
	const call: AgentToolCall = {
		type: "tool_call",
		id: "command-call",
		name: "execute_command",
		arguments: { command: "git status --short" },
	}
	return { scheduler, host, approvals, effect, call }
}

describe("lifecycle hooks retain native command approval receipts", () => {
	it.each(["denied", "cancelled"] as const)(
		"runs PermissionRequest before reusing an exact-command grant when the next hook is %s",
		async (decision) => {
			let enterHook!: () => void
			let releaseHook!: () => void
			const hookEntered = new Promise<void>((resolve) => {
				enterHook = resolve
			})
			const hookReleased = new Promise<void>((resolve) => {
				releaseHook = resolve
			})
			const controller = new AbortController()
			const onEffectStart = vi.fn(async () => undefined)
			const permissionRequest = vi.fn<NonNullable<ToolSchedulerOptions["permissionRequest"]>>()
			permissionRequest.mockResolvedValueOnce({}).mockImplementationOnce(async () => {
				if (decision === "cancelled") {
					enterHook()
					await hookReleased
					return {}
				}
				return { denied: "The installed hook revoked this command" }
			})
			const { scheduler, host, effect, call } = commandFixture({
				permissionRequest,
				onEffectStart,
				signal: controller.signal,
				preserveAbortedResults: true,
			})
			host.taskId = `lifecycle-cached-hook-${decision}`
			const requestToolApproval = vi.fn<NonNullable<ToolExecutionHost["requestToolApproval"]>>(
				async (request) => {
					if (!request.proposedAmendment) throw new Error("Expected an exact-command session amendment")
					return { decision: "approve_with_amendment", amendment: request.proposedAmendment }
				},
			)
			host.requestToolApproval = requestToolApproval
			try {
				const first = await scheduler.run([{ ...call, id: "approved-command" }])
				expect(first.results[0].status).toBe("success")
				const pending = scheduler.run([{ ...call, id: "cached-command" }])
				if (decision === "cancelled") {
					await Promise.race([
						hookEntered,
						pending.then(() => {
							throw new Error("Cached approval bypassed permission revalidation")
						}),
					])
					controller.abort(new Error("Stopped during permission revalidation"))
					releaseHook()
				}
				const second = await pending

				expect(permissionRequest).toHaveBeenCalledTimes(2)
				expect(requestToolApproval).toHaveBeenCalledOnce()
				expect(effect).toHaveBeenCalledOnce()
				expect(onEffectStart).toHaveBeenCalledOnce()
				expect(second.results).toEqual([
					expect.objectContaining({ callId: "cached-command", status: decision }),
				])
				expect(host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "approved-command", is_error: false }),
					expect.objectContaining({ tool_use_id: "cached-command", is_error: true }),
				])
			} finally {
				releaseHook()
				controller.abort()
				clearTaskSessionApprovalGrants(host.taskId)
			}
		},
	)

	it("retains the host-owned row ID through a permitted rewritten command", async () => {
		const rewritten = "git diff --stat"
		const permissionRequest = vi.fn<NonNullable<ToolSchedulerOptions["permissionRequest"]>>(async () => ({}))
		const { scheduler, host, approvals, effect, call } = commandFixture({
			preToolUse: async () => ({ updatedInput: { command: rewritten } }),
			permissionRequest,
		})
		const nativeApproval = vi.fn<NonNullable<ToolExecutionHost["requestToolApproval"]>>(
			async (_request, _message, onCommandApproval) => {
				onCommandApproval?.("701")
				return { decision: "approve_once" }
			},
		)
		host.requestToolApproval = nativeApproval
		const outcome = await scheduler.run([call])

		expect(nativeApproval).toHaveBeenCalledOnce()
		expect(nativeApproval.mock.calls[0][1]).toBe(rewritten)
		expect(permissionRequest.mock.calls[0][0]).toMatchObject({ arguments: { command: rewritten } })
		expect(approvals).toEqual([{ approved: true, commandExecutionId: "701" }])
		expect(effect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: rewritten }))
		expect(call.arguments).toEqual({ command: "git status --short" })
		expect(outcome.results[0]).toMatchObject({ callId: "command-call", status: "success" })
	})

	it("denies a command in PermissionRequest before native approval can publish a row receipt", async () => {
		const { scheduler, host, approvals, effect, call } = commandFixture({
			permissionRequest: async () => ({ denied: "Installed hook denied this command" }),
		})
		const nativeApproval = vi.fn<NonNullable<ToolExecutionHost["requestToolApproval"]>>(
			async (_request, _message, onCommandApproval) => {
				onCommandApproval?.("702")
				return { decision: "approve_once" }
			},
		)
		host.requestToolApproval = nativeApproval
		const outcome = await scheduler.run([call])

		expect(nativeApproval).not.toHaveBeenCalled()
		expect(approvals).toEqual([{ approved: false }])
		expect(effect).not.toHaveBeenCalled()
		expect(outcome.results[0]).toMatchObject({ status: "denied", failure: { effectsStarted: "no" } })
	})

	it("discards a late command row receipt when cancellation wins native approval", async () => {
		const controller = new AbortController()
		let entered!: () => void
		let finishApproval!: (decision: ToolApprovalDecision) => void
		const rowPublished = new Promise<void>((resolve) => {
			entered = resolve
		})
		const decision = new Promise<ToolApprovalDecision>((resolve) => {
			finishApproval = resolve
		})
		const { scheduler, host, approvals, effect, call } = commandFixture({
			signal: controller.signal,
			preserveAbortedResults: true,
			permissionRequest: async () => ({}),
		})
		host.requestToolApproval = async (_request, _message, onCommandApproval) => {
			onCommandApproval?.("703")
			entered()
			return decision
		}
		const pending = scheduler.run([call])
		try {
			await rowPublished
			controller.abort(new Error("Cancelled after command row publication"))
			finishApproval({ decision: "approve_once" })
			const outcome = await pending

			expect(outcome.status).toBe("aborted")
			expect(outcome.results[0].status).toBe("cancelled")
			expect(approvals).toEqual([{ approved: false }])
			expect(effect).not.toHaveBeenCalled()
			expect(host.userMessageContent).toHaveLength(1)
		} finally {
			finishApproval({ decision: "approve_once" })
			await pending
		}
	})
})

describe("scheduler lifecycle hooks preserve policy and completed effects", () => {
	it("rejects an originally out-of-scope call before launching a pre-tool hook", async () => {
		const preToolUse = vi.fn(async () => ({ updatedInput: { path: path.join(process.cwd(), "safe.ts") } }))
		const { scheduler, effect, call } = fixture({ preToolUse })
		const outcome = await scheduler.run([call("call-1", { path: path.join(tmpdir(), "outside-alpha", "file.ts") })])

		expect(outcome.results[0].status).not.toBe("success")
		expect(outcome.results[0].failure?.reason).toBe("policy_denied")
		expect(preToolUse).not.toHaveBeenCalled()
		expect(effect).not.toHaveBeenCalled()
	})

	it("rechecks rewritten input against captured workspace policy before any effect or approval", async () => {
		const { scheduler, state, effect, call } = fixture({
			preToolUse: async () => ({
				updatedInput: { path: path.join(tmpdir(), "outside-alpha", "file.ts"), content: "Hook content" },
			}),
		})
		const outcome = await scheduler.run([call()])

		expect(outcome.results[0].status).not.toBe("success")
		expect(outcome.results[0].failure?.reason).toBe("policy_denied")
		expect(effect).not.toHaveBeenCalled()
		expect(state.ask).not.toHaveBeenCalled()
	})

	it("runs a valid rewrite through native validation and approval while retaining the accepted provider call", async () => {
		const validated = vi.fn()
		const target = path.join(process.cwd(), "rewritten.ts")
		const updatedInput = { path: target, content: "Hook content" }
		const { scheduler, state, effect, call } = fixture(
			{
				validateCall: validated,
				preToolUse: async () => ({ updatedInput }),
			},
			async ({ call, callbacks }) => {
				if (await callbacks.askApproval("tool", JSON.stringify(call.nativeArgs)))
					callbacks.pushToolResult("Written")
			},
		)
		const original = Object.freeze(call())
		const originalArguments = structuredClone(original.arguments)
		const outcome = await scheduler.run([original])

		expect(validated).toHaveBeenCalledTimes(2)
		expect(effect.mock.calls[0][0].call.nativeArgs).toMatchObject(updatedInput)
		expect(JSON.parse(state.ask.mock.calls[0][1] as string)).toMatchObject(updatedInput)
		expect(original.arguments).toEqual(originalArguments)
		expect(outcome.results[0]).toMatchObject({ callId: original.id, status: "success" })
		expect(state.userMessageContent).toHaveLength(1)
		expect(state.userMessageContent[0].tool_use_id).toBe(original.id)
		expect(state.recordToolCallForStopping.mock.calls[0][1]).toMatchObject(updatedInput)
	})

	it("denies once on hook feedback without executing a rewritten call", async () => {
		const preToolUse = vi.fn(async () => ({ denied: "Installed hook rejected this call" }))
		const { scheduler, effect, call } = fixture({ preToolUse })
		const outcome = await scheduler.run([call()])

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ status: "denied", callId: "call-1" })
		expect(preToolUse).toHaveBeenCalledOnce()
		expect(effect).not.toHaveBeenCalled()
	})

	it("retains the first completed effect when cancellation rejects a later pre-tool hook", async () => {
		const controller = new AbortController()
		let entered!: () => void
		let rejectHook!: (reason: Error) => void
		const secondHookStarted = new Promise<void>((resolve) => {
			entered = resolve
		})
		const events = vi.fn<NonNullable<ToolSchedulerOptions["onEvent"]>>()
		const { scheduler, state, effect, call } = fixture(
			{
				signal: controller.signal,
				preserveAbortedResults: true,
				onEvent: events,
				preToolUse: async (call) => {
					if (call.id !== "second") return {}
					entered()
					return new Promise<{ denied?: string }>((_resolve, reject) => {
						rejectHook = reject
					})
				},
			},
			async ({ call, callbacks }) => {
				callbacks.setResultMetadata?.({ executionStatus: "success", exitCode: 0 })
				callbacks.pushToolResult(`Completed ${call.id}`)
			},
		)
		const pending = scheduler.run([call("first"), call("second"), call("third")])
		await secondHookStarted
		controller.abort(new Error("Cancelled during second pre-tool hook"))
		rejectHook(new Error("Cancelled transcript lookup"))
		const outcome = await pending

		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toHaveLength(3)
		expect(outcome.results[0]).toMatchObject({
			callId: "first",
			status: "success",
			executionStatus: "success",
			exitCode: 0,
			content: "Completed first",
		})
		expect(outcome.results.slice(1).map((result) => [result.callId, result.status])).toEqual([
			["second", "cancelled"],
			["third", "cancelled"],
		])
		expect(effect).toHaveBeenCalledOnce()
		expect(state.userMessageContent.map((receipt) => [receipt.tool_use_id, receipt.is_error ?? false])).toEqual([
			["first", false],
			["second", true],
			["third", true],
		])
		expect(events.mock.calls.flatMap(([event]) => (event.type === "tool_result" ? [event.callId] : []))).toEqual([
			"first",
			"second",
			"third",
		])
	})

	it("contains an ordinary pre-tool callback failure to its current call after an earlier effect", async () => {
		const { scheduler, state, effect, call } = fixture(
			{
				preToolUse: async (call) => {
					if (call.id === "second") throw new Error("Hook transcript unavailable")
					return {}
				},
			},
			async ({ callbacks }) => {
				callbacks.pushToolResult("Earlier effect completed")
			},
		)
		const outcome = await scheduler.run([call("first"), call("second")])

		expect(outcome.results).toHaveLength(2)
		expect(outcome.results[0]).toMatchObject({
			callId: "first",
			status: "success",
			content: "Earlier effect completed",
		})
		expect(outcome.results[1]).toMatchObject({ callId: "second", status: "error" })
		expect(outcome.results[1].failure).toMatchObject({ effectsStarted: "no", outcome: "known" })
		expect(effect).toHaveBeenCalledOnce()
		expect(state.userMessageContent.map((receipt) => receipt.tool_use_id)).toEqual(["first", "second"])
	})

	it("retains successful execution metadata while post-tool feedback replaces untrusted model output", async () => {
		const postToolUse = vi.fn(async () => ({ feedback: "Inspect the completed write" }))
		const { scheduler, call } = fixture({ postToolUse }, async ({ callbacks }) => {
			callbacks.setResultMetadata?.({
				executionStatus: "success",
				exitCode: 0,
				trustedProgress: { kind: "mutation", scope: process.cwd(), stateFingerprint: "written-v1" },
			})
			callbacks.pushToolResult("Original successful output")
		})
		const outcome = await scheduler.run([call()])

		expect(outcome.results[0]).toMatchObject({
			status: "success",
			executionStatus: "success",
			exitCode: 0,
			content: "Inspect the completed write",
		})
		expect(outcome.results[0]).not.toHaveProperty("trustedProgress")
		expect(postToolUse).toHaveBeenCalledOnce()
	})

	it("distinguishes a rejected post-tool result from a tool that never executed", async () => {
		const { scheduler, call } = fixture(
			{ postToolUse: async () => ({ blocked: "Review rejected this output" }) },
			async ({ callbacks }) => {
				callbacks.setResultMetadata?.({ executionStatus: "success", exitCode: 0 })
				callbacks.pushToolResult("Mutation completed")
			},
		)
		const outcome = await scheduler.run([call()])

		expect(outcome.results[0]).toMatchObject({ status: "error", executionStatus: "success", exitCode: 0 })
		expect(outcome.results[0].content).toEqual(expect.stringContaining("The tool completed"))
		expect(outcome.results[0].failure?.effectsStarted).toBe("yes")
	})

	it("preserves prior receipts and known successful effects when a post-tool hook rejects", async () => {
		const postToolUse = vi.fn<NonNullable<ToolSchedulerOptions["postToolUse"]>>(async (call) => {
			if (call.id === "second") throw new Error("Post-tool transcript lookup failed")
			return {}
		})
		const { scheduler, state, effect, call } = fixture({ postToolUse }, async ({ call, callbacks }) => {
			callbacks.setResultMetadata?.({
				executionStatus: "success",
				exitCode: 0,
				trustedProgress: { kind: "mutation", scope: process.cwd(), stateFingerprint: `written-${call.id}` },
			})
			callbacks.pushToolResult(`Mutation completed ${call.id}`)
		})
		const outcome = await scheduler.run([call("first"), call("second")])

		expect(outcome.results).toHaveLength(2)
		expect(outcome.results[0]).toMatchObject({
			callId: "first",
			status: "success",
			executionStatus: "success",
			exitCode: 0,
			content: "Mutation completed first",
		})
		expect(outcome.results[1]).toMatchObject({
			callId: "second",
			status: "error",
			executionStatus: "success",
			exitCode: 0,
		})
		expect(outcome.results[1].failure).toMatchObject({ effectsStarted: "yes", outcome: "known" })
		expect(outcome.results[1].content).toEqual(expect.stringMatching(/completed/i))
		expect(outcome.results[1].content).toEqual(expect.stringMatching(/inspect[\s\S]*before[\s\S]*(repeat|retry)/i))
		expect(outcome.results[1]).not.toHaveProperty("trustedProgress")
		expect(effect).toHaveBeenCalledTimes(2)
		expect(postToolUse).toHaveBeenCalledTimes(2)
		expect(state.userMessageContent.map((receipt) => [receipt.tool_use_id, receipt.is_error ?? false])).toEqual([
			["first", false],
			["second", true],
		])
	})

	it("keeps a known completed effect when cancellation rejects its post-tool callback", async () => {
		const controller = new AbortController()
		let entered!: () => void
		let rejectHook!: (reason: Error) => void
		const secondPostHookStarted = new Promise<void>((resolve) => {
			entered = resolve
		})
		const { scheduler, state, effect, call } = fixture(
			{
				signal: controller.signal,
				preserveAbortedResults: true,
				postToolUse: async (call) => {
					if (call.id !== "second") return {}
					entered()
					return new Promise<{ blocked?: string }>((_resolve, reject) => {
						rejectHook = reject
					})
				},
			},
			async ({ call, callbacks }) => {
				callbacks.setResultMetadata?.({ executionStatus: "success", exitCode: 0 })
				callbacks.pushToolResult(`Completed ${call.id}`)
			},
		)
		const pending = scheduler.run([call("first"), call("second"), call("third")])
		await secondPostHookStarted
		controller.abort(new Error("Cancelled after completed second effect"))
		rejectHook(new Error("Cancelled post-tool transcript lookup"))
		const outcome = await pending

		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toHaveLength(3)
		for (const [index, callId] of ["first", "second"].entries()) {
			expect(outcome.results[index]).toMatchObject({
				callId,
				status: "success",
				executionStatus: "success",
				exitCode: 0,
				content: `Completed ${callId}`,
			})
		}
		expect(outcome.results[2]).toMatchObject({ callId: "third", status: "cancelled" })
		expect(effect).toHaveBeenCalledTimes(2)
		expect(state.userMessageContent.map((receipt) => [receipt.tool_use_id, receipt.is_error ?? false])).toEqual([
			["first", false],
			["second", false],
			["third", true],
		])
	})

	it.each(["error", "denied", "cancelled"] as const)(
		"does not run PostToolUse for a %s tool result",
		async (status) => {
			const postToolUse = vi.fn(async () => ({}))
			const { scheduler, call } = fixture({ postToolUse }, async ({ callbacks }) => {
				callbacks.setResultMetadata?.({ status, executionStatus: status })
				callbacks.pushToolResult("Terminal failure")
			})
			await scheduler.run([call()])
			expect(postToolUse).not.toHaveBeenCalled()
		},
	)

	it("serializes hook and tool boundaries even when read concurrency was requested", async () => {
		const order: string[] = []
		const { scheduler, call } = fixture(
			{
				executionMode: "selective-parallel",
				maxConcurrency: 2,
				preToolUse: async (call) => {
					order.push(`pre:${call.id}`)
					return {}
				},
				postToolUse: async (call) => {
					order.push(`post:${call.id}`)
					return {}
				},
			},
			async ({ call, callbacks }) => {
				order.push(`execute:${call.id}`)
				callbacks.pushToolResult("Read")
			},
			true,
		)
		await scheduler.run([call("first"), call("second")])

		expect(order).toEqual([
			"pre:first",
			"execute:first",
			"post:first",
			"pre:second",
			"execute:second",
			"post:second",
		])
	})

	it("does not start configured hooks before the assistant transcript boundary is committed", async () => {
		const preToolUse = vi.fn(async () => ({}))
		const { scheduler, effect, call } = fixture({ deferResultCommit: true, preToolUse })
		await expect(scheduler.run([call()])).rejects.toThrow("committed assistant boundary")
		expect(preToolUse).not.toHaveBeenCalled()
		expect(effect).not.toHaveBeenCalled()
	})

	it("lets a PermissionRequest denial narrow approval without starting the mutation or opening native approval", async () => {
		const mutate = vi.fn()
		const permissionRequest = vi.fn(async () => ({ denied: "Permission denied by installed user hook" }))
		const { scheduler, state, call } = fixture({ permissionRequest }, async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "Write file")) {
				mutate()
				callbacks.pushToolResult("Written")
			}
		})
		const outcome = await scheduler.run([call()])

		expect(permissionRequest).toHaveBeenCalledOnce()
		expect(state.ask).not.toHaveBeenCalled()
		expect(mutate).not.toHaveBeenCalled()
		expect(outcome.results[0].status).toBe("denied")
		expect(outcome.results[0].failure?.effectsStarted).toBe("no")
	})

	it("keeps native denial authoritative after an advisory PermissionRequest allow", async () => {
		const mutate = vi.fn()
		const { scheduler, state, call } = fixture({ permissionRequest: async () => ({}) }, async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "Write file")) {
				mutate()
				callbacks.pushToolResult("Written")
			}
		})
		state.ask.mockResolvedValue({ response: "noButtonClicked" })
		const outcome = await scheduler.run([call()])

		expect(state.ask).toHaveBeenCalledOnce()
		expect(mutate).not.toHaveBeenCalled()
		expect(outcome.results[0].status).toBe("denied")
	})

	it("settles cancellation during PermissionRequest without opening approval or repeating the call", async () => {
		let entered!: () => void
		let finish!: (value: { denied?: string }) => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const controller = new AbortController()
		const mutate = vi.fn()
		const { scheduler, state, call } = fixture(
			{
				signal: controller.signal,
				preserveAbortedResults: true,
				permissionRequest: async () => {
					entered()
					return new Promise<{ denied?: string }>((resolve) => {
						finish = resolve
					})
				},
			},
			async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "Write file")) {
					mutate()
					callbacks.pushToolResult("Written")
				}
			},
		)
		const pending = scheduler.run([call()])
		await started
		controller.abort()
		finish({})
		const outcome = await pending

		expect(mutate).not.toHaveBeenCalled()
		expect(state.ask).not.toHaveBeenCalled()
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(state.userMessageContent).toHaveLength(1)
	})
})
