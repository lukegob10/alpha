import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { describe, expect, it, vi } from "vitest"

import type { ToolApprovalDecision, ToolApprovalRequest } from "@alpha-code/types"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

type CommandApproval = Awaited<ReturnType<NonNullable<ToolCallbacks["askCommandApproval"]>>>
type ApprovalObserver = (commandExecutionId: string) => void

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function fixture(useLegacyBoolean = false, prepareFallback = false) {
	const lifetime = new AbortController()
	const executionReturned = deferred<void>()
	const observations: CommandApproval[] = []
	const effects: string[] = []
	const host: ToolExecutionHost = {
		taskId: `command-presentation-${randomUUID()}`,
		cwd: path.join(os.tmpdir(), "alpha-command-presentation"),
		userMessageContent: [],
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const descriptor: ToolDescriptor = {
		name: "execute_command",
		aliases: [],
		schema: { type: "function", function: { name: "execute_command", parameters: { type: "object" } } },
		capabilities: {
			concurrency: "serial",
			sideEffects: "workspace",
			controlFlow: false,
			requiresApproval: true,
			...(prepareFallback ? { parallelCommandRead: true } : {}),
		},
		...(prepareFallback
			? {
					prepareParallelCommand: async ({
						callbacks,
					}: Parameters<NonNullable<ToolDescriptor["prepareParallelCommand"]>>[0]) => {
						const approval = callbacks.askCommandApproval
							? await callbacks.askCommandApproval("command", "git status")
							: { approved: await callbacks.askApproval("command", "git status") }
						return approval.approved ? { scope: host.cwd!, serialFallback: true as const } : undefined
					},
				}
			: {}),
		execute: async ({ call, callbacks }) => {
			try {
				const approval =
					!useLegacyBoolean && callbacks.askCommandApproval
						? await callbacks.askCommandApproval("command", "git status")
						: { approved: await callbacks.askApproval("command", "git status") }
				observations.push(approval)
				if (approval.approved) {
					effects.push(call.id!)
					callbacks.pushToolResult("inspected")
				}
			} finally {
				executionReturned.resolve()
			}
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register(descriptor)
	const run = (id = "same-provider-id") =>
		new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			...(prepareFallback
				? {
						executionMode: "selective-parallel" as const,
						policy: createToolPolicySnapshot({
							visibleTools: ["execute_command"],
							capabilities: { execute_command: descriptor.capabilities },
						}),
					}
				: {}),
			signal: lifetime.signal,
			validateCall: () => {},
		}).run([{ type: "tool_call", id, name: "execute_command", arguments: { command: "git status" } }])
	return { host, lifetime, observations, effects, run, executionReturned }
}

describe("command approval presentation receipts", () => {
	it("retains the typed request's owned command row after later feedback", async () => {
		const { host, observations, effects, run } = fixture()
		let mutableLatestRow = "old-command"
		host.requestToolApproval = vi.fn<NonNullable<ToolExecutionHost["requestToolApproval"]>>(
			async (_request, _message, onCommandApproval) => {
				onCommandApproval?.("101")
				mutableLatestRow = "later-feedback"
				return { decision: "approve_once" }
			},
		)
		const outcome = await run()
		expect(outcome.results[0]).toMatchObject({ status: "success", content: "inspected" })
		expect(mutableLatestRow).toBe("later-feedback")
		expect(observations).toEqual([{ approved: true, commandExecutionId: "101" }])
		expect(effects).toEqual(["same-provider-id"])
	})

	it("separates repeated provider call IDs by their approval request and row", async () => {
		const { host, observations, run } = fixture()
		const requests: ToolApprovalRequest[] = []
		host.requestToolApproval = async (request, _message, onCommandApproval) => {
			requests.push(request)
			onCommandApproval?.(String(200 + requests.length))
			return { decision: "approve_once" }
		}
		await run()
		await run()
		expect(requests).toHaveLength(2)
		expect(requests[0].callId).toBe(requests[1].callId)
		expect(requests[0].requestId).not.toBe(requests[1].requestId)
		expect(observations).toEqual([
			{ approved: true, commandExecutionId: "201" },
			{ approved: true, commandExecutionId: "202" },
		])
	})

	it("keeps reviewer approval without a row explicitly uncorrelated", async () => {
		const { host, observations, effects, run } = fixture()
		host.requestToolApproval = async () => ({ decision: "approve_once" })
		await run()
		expect(observations).toEqual([{ approved: true }])
		expect(effects).toEqual(["same-provider-id"])
	})

	it("does not reuse an earlier row when an exact command session grant bypasses the prompt", async () => {
		const { host, observations, run, lifetime } = fixture()
		const requestToolApproval = vi.fn(
			async (request: ToolApprovalRequest, _message?: string, onCommandApproval?: ApprovalObserver) => {
				onCommandApproval?.("301")
				return {
					decision: "approve_with_amendment" as const,
					amendment: request.proposedAmendment!,
				}
			},
		)
		host.requestToolApproval = requestToolApproval
		try {
			await run("grant-first")
			await run("grant-second")
			expect(requestToolApproval).toHaveBeenCalledOnce()
			expect(observations).toEqual([{ approved: true, commandExecutionId: "301" }, { approved: true }])
		} finally {
			lifetime.abort()
		}
	})

	it("accepts a receipt from the legacy host that owns its command row", async () => {
		const { host, observations, run } = fixture()
		host.askApproval = async () => ({ response: "yesButtonClicked", commandExecutionId: "401" })
		await run()
		expect(observations).toEqual([{ approved: true, commandExecutionId: "401" }])
	})

	it("replays the same owned row receipt from a preapproved serial fallback", async () => {
		const { host, observations, effects, run } = fixture(false, true)
		const requestToolApproval = vi.fn(
			async (_request: ToolApprovalRequest, _message?: string, onCommandApproval?: ApprovalObserver) => {
				onCommandApproval?.("451")
				return { decision: "approve_once" as const }
			},
		)
		host.requestToolApproval = requestToolApproval
		const outcome = await run()
		expect(outcome.results[0].status).toBe("success")
		expect(requestToolApproval).toHaveBeenCalledOnce()
		expect(observations).toEqual([{ approved: true, commandExecutionId: "451" }])
		expect(effects).toEqual(["same-provider-id"])
	})

	it("passes the observer through the Task.ask adapter without changing other positional fields", async () => {
		const { host, observations, run } = fixture()
		const ask = vi.fn<NonNullable<ToolExecutionHost["ask"]>>(
			async (_type, _message, _partial, _progress, _protected, _explicit, _request, onCommandApproval) => {
				onCommandApproval?.("501")
				return { response: "yesButtonClicked" }
			},
		)
		host.ask = ask
		await run()
		expect(observations).toEqual([{ approved: true, commandExecutionId: "501" }])
		expect(ask).toHaveBeenCalledWith(
			"command",
			"git status",
			false,
			undefined,
			false,
			undefined,
			undefined,
			expect.any(Function),
		)
	})

	it.each(["deny", "abort", "timeout"] as const)(
		"never exposes an observed row as approval after %s",
		async (decision) => {
			const { host, observations, effects, run, executionReturned } = fixture()
			host.requestToolApproval = async (_request, _message, onCommandApproval) => {
				onCommandApproval?.("601")
				return { decision }
			}
			const outcome = await run()
			await executionReturned.promise
			expect(outcome.results[0].status).toBe(decision === "deny" ? "denied" : "cancelled")
			expect(observations).toEqual([{ approved: false }])
			expect(effects).toEqual([])
		},
	)

	it("lets cancellation win over a late row receipt and approval", async () => {
		const { host, observations, effects, run, lifetime, executionReturned } = fixture()
		const entered = deferred<void>()
		const approved = deferred<ToolApprovalDecision>()
		let observe: ApprovalObserver | undefined
		host.requestToolApproval = async (_request, _message, onCommandApproval) => {
			observe = onCommandApproval
			entered.resolve()
			return approved.promise
		}
		const running = run()
		await entered.promise
		lifetime.abort()
		observe?.("701")
		approved.resolve({ decision: "approve_once" })
		const outcome = await running
		await executionReturned.promise
		expect(outcome.results[0].status).toBe("cancelled")
		expect(observations).toEqual([{ approved: false }])
		expect(effects).toEqual([])
	})

	it("retains the legacy boolean callback's typed approval path and argument shape", async () => {
		const { host, effects, run } = fixture(true)
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest, _message?: string) => ({
			decision: "approve_once" as const,
		}))
		host.requestToolApproval = requestToolApproval
		await run()
		expect(requestToolApproval.mock.calls[0]).toHaveLength(2)
		expect(effects).toEqual(["same-provider-id"])
	})
})
