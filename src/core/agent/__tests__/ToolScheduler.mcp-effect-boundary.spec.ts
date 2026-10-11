import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { describe, expect, it, vi } from "vitest"

import { Task } from "../../task/Task"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AgentToolCall } from "../AgentResponse"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../lifecycle/AgentLifecycleJournal"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

interface LifecycleTaskBoundary {
	enqueueCanonicalLifecycleEvent(
		type: AgentLifecycleEventInput["type"],
		payload: Record<string, unknown>,
		stepId: string,
		guard: undefined,
		options: { durable: boolean; required: boolean },
	): Promise<void>
	publishCanonicalLifecycleSchedulerEvent(event: AgentTurnEvent): Promise<void>
}

async function createLifecycleFixture(taskId: string, names: string[]) {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-audit-mcp-preflight-"))
	const journal = new AgentLifecycleJournal(taskId, storage)
	const identity = { version: 1 as const, taskId, runId: "audit-run", turnId: "audit-turn", occurredAt: 1 }
	await journal.append({
		...identity,
		eventId: "turn",
		type: "turn_started",
		payload: { phase: "starting", effectTrackingVersion: 1 },
	})
	await journal.append({
		...identity,
		eventId: "step",
		stepId: "audit-step",
		type: "step_started",
		payload: { phase: "working" },
	})
	for (const [index, name] of names.entries()) {
		await journal.append({
			...identity,
			eventId: `accepted-${index}`,
			stepId: "audit-step",
			type: "tool_call_accepted",
			payload: {
				item: {
					itemId: `call-${index}`,
					stepId: "audit-step",
					type: "tool_call",
					toolCallId: `read-${index}`,
					name,
					arguments: {},
					status: "accepted",
				},
			},
		})
	}
	const provider = {
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		publishAgentLifecycleEvent: async (event: AgentLifecycleEventInput, options: { durable: boolean }) => {
			await journal.append(event, options)
			return { accepted: true }
		},
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId,
		agentRunId: identity.runId,
		agentTurnId: identity.turnId,
		currentAgentStep: { stepId: "audit-step" },
		providerRef: new WeakRef(provider),
		canonicalLifecycleQueue: Promise.resolve(),
	}) as LifecycleTaskBoundary
	return {
		task,
		provider,
		journal,
		async close() {
			await journal.close()
			await fs.rm(storage, { recursive: true, force: true })
		},
	}
}

async function createMcpReadFixture(
	names: string[],
	signal: AbortSignal,
	askApproval: NonNullable<ToolExecutionHost["askApproval"]>,
) {
	const host: ToolExecutionHost = {
		taskId: "mcp-effect-boundary",
		cwd: path.resolve(os.tmpdir()),
		userMessageContent: [],
		askApproval,
		say: async () => {},
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const actualDispatch = vi.fn(async (_callId: string) => "read completed")
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const capabilities: ToolDescriptor["capabilities"] = {
		concurrency: "serial",
		sideEffects: "external",
		controlFlow: false,
		requiresApproval: true,
		parallelMcpRead: true,
	}
	for (const name of names) {
		registry.register({
			name,
			aliases: [],
			schema: { type: "function", function: { name, parameters: { type: "object" } } },
			capabilities,
			execute: async ({ call, callbacks }) => {
				if (!(await callbacks.askApproval("use_mcp_server", name))) return
				callbacks.pushToolResult(await actualDispatch(String(call.id)))
			},
		})
	}
	const lifecycle = await createLifecycleFixture(host.taskId, names)
	const onEffectStart = vi.fn(async (call: AgentToolCall) => {
		await lifecycle.task.enqueueCanonicalLifecycleEvent(
			"tool_effect_started",
			{ toolCallId: call.id },
			"audit-step",
			undefined,
			{ durable: true, required: true },
		)
	})
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry,
		mode: "code",
		policy: createToolPolicySnapshot({
			visibleTools: names,
			capabilities: Object.fromEntries(names.map((name) => [name, capabilities])),
		}),
		executionMode: "selective-parallel",
		preserveAbortedResults: true,
		signal,
		validateCall: () => {},
		onEffectStart,
		onEvent: async (event) => {
			if (event.type === "tool_result") {
				await lifecycle.task.publishCanonicalLifecycleSchedulerEvent(event)
			}
		},
	})
	const calls: AgentToolCall[] = names.map((name, index) => ({
		type: "tool_call",
		id: `read-${index}`,
		name,
		arguments: {},
	}))
	return { host, actualDispatch, lifecycle, onEffectStart, scheduler, calls }
}

describe("MCP approval preflight effect ownership", () => {
	it("keeps approved but undispatched reads unstarted when Stop arrives during the next approval", async () => {
		const controller = new AbortController()
		const secondApprovalEntered = deferred()
		const releaseSecondApproval = deferred()
		let approvals = 0
		const fixture = await createMcpReadFixture(
			["mcp--fixture--first", "mcp--fixture--second"],
			controller.signal,
			async () => {
				approvals++
				if (approvals === 2) {
					secondApprovalEntered.resolve()
					await releaseSecondApproval.promise
				}
				return { response: "yesButtonClicked" }
			},
		)
		const { scheduler, calls, actualDispatch, onEffectStart, host, lifecycle } = fixture
		try {
			const running = scheduler.run(calls)

			await secondApprovalEntered.promise
			controller.abort(new Error("Stop before any MCP dispatch"))
			releaseSecondApproval.resolve()
			const outcome = await running
			const replayed = await lifecycle.journal.replay()

			expect(actualDispatch).not.toHaveBeenCalled()
			expect(outcome.status).toBe("aborted")
			expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
			expect(host.userMessageContent).toHaveLength(2)
			expect.soft(onEffectStart).not.toHaveBeenCalled()
			expect.soft(String(outcome.results[0].content)).toContain("cancelled before it started")
			expect.soft(replayed?.effectStartedToolCallIds).toEqual([])
			expect
				.soft(replayed?.items.filter((item) => item.type === "tool_result").map((item) => item.status))
				.toEqual(["cancelled", "cancelled"])
		} finally {
			controller.abort()
			releaseSecondApproval.resolve()
			await lifecycle.close()
		}
	})

	it("starts each approved effect durably immediately before dispatch, after the serial approval preflight", async () => {
		const controller = new AbortController()
		const approve = vi.fn(async () => ({ response: "yesButtonClicked" as const }))
		const fixture = await createMcpReadFixture(
			["mcp--fixture--first", "mcp--fixture--second"],
			controller.signal,
			approve,
		)
		fixture.actualDispatch.mockImplementation(async (callId) => {
			expect(approve).toHaveBeenCalledTimes(2)
			expect(fixture.lifecycle.journal.getSnapshot()?.effectStartedToolCallIds).toContain(callId)
			return `completed-${callId}`
		})
		try {
			const outcome = await fixture.scheduler.run(fixture.calls)
			const replayed = await fixture.lifecycle.journal.replay()

			expect(outcome.status).toBe("completed")
			expect(outcome.results.map((result) => result.status)).toEqual(["success", "success"])
			expect(fixture.onEffectStart.mock.calls.map(([call]) => call.id)).toEqual(["read-0", "read-1"])
			expect(fixture.actualDispatch.mock.calls.map(([id]) => id)).toEqual(["read-0", "read-1"])
			expect(fixture.host.userMessageContent).toHaveLength(2)
			expect(replayed?.effectStartedToolCallIds).toEqual(["read-0", "read-1"])
			expect(replayed?.items.filter((item) => item.type === "tool_result").map((item) => item.status)).toEqual([
				"success",
				"success",
			])
		} finally {
			controller.abort()
			await fixture.lifecycle.close()
		}
	})

	it("keeps denial known and publishes one result without starting an MCP effect", async () => {
		const controller = new AbortController()
		const approve = vi.fn(async () => ({ response: "noButtonClicked" as const }))
		const fixture = await createMcpReadFixture(["mcp--fixture--denied"], controller.signal, approve)
		try {
			const outcome = await fixture.scheduler.run(fixture.calls)
			const replayed = await fixture.lifecycle.journal.replay()

			expect(outcome.results.map((result) => result.status)).toEqual(["denied"])
			expect(approve).toHaveBeenCalledOnce()
			expect(fixture.onEffectStart).not.toHaveBeenCalled()
			expect(fixture.actualDispatch).not.toHaveBeenCalled()
			expect(fixture.host.userMessageContent).toHaveLength(1)
			expect(replayed?.effectStartedToolCallIds).toEqual([])
			expect(replayed?.items.filter((item) => item.type === "tool_result").map((item) => item.status)).toEqual([
				"denied",
			])
		} finally {
			controller.abort()
			await fixture.lifecycle.close()
		}
	})

	it("keeps an approval preflight failure known when no MCP effect dispatched", async () => {
		const controller = new AbortController()
		const fixture = await createMcpReadFixture(["mcp--fixture--approval-error"], controller.signal, async () => {
			throw new Error("Approval transport failed before dispatch")
		})
		try {
			const outcome = await fixture.scheduler.run(fixture.calls)
			const replayed = await fixture.lifecycle.journal.replay()

			expect(outcome.results[0]).toMatchObject({
				status: "error",
				failure: { effectsStarted: "no", outcome: "known" },
			})
			expect(fixture.onEffectStart).not.toHaveBeenCalled()
			expect(fixture.actualDispatch).not.toHaveBeenCalled()
			expect(replayed?.effectStartedToolCallIds).toEqual([])
			expect(replayed?.items.filter((item) => item.type === "tool_result").map((item) => item.status)).toEqual([
				"error",
			])
		} finally {
			controller.abort()
			await fixture.lifecycle.close()
		}
	})

	it("preserves an unknown outcome when Stop follows actual MCP dispatch", async () => {
		const controller = new AbortController()
		const dispatched = deferred()
		const releaseDispatch = deferred()
		const fixture = await createMcpReadFixture(["mcp--fixture--active"], controller.signal, async () => ({
			response: "yesButtonClicked",
		}))
		fixture.actualDispatch.mockImplementation(async () => {
			dispatched.resolve()
			await releaseDispatch.promise
			return "late read response"
		})
		try {
			const running = fixture.scheduler.run(fixture.calls)
			await dispatched.promise
			controller.abort(new Error("Stop after MCP dispatch"))
			releaseDispatch.resolve()
			const outcome = await running
			const replayed = await fixture.lifecycle.journal.replay()

			expect(outcome.status).toBe("aborted")
			expect(outcome.results[0].status).toBe("cancelled")
			expect(String(outcome.results[0].content)).toContain("outcome is unknown")
			expect(fixture.onEffectStart).toHaveBeenCalledOnce()
			expect(fixture.actualDispatch).toHaveBeenCalledOnce()
			expect(fixture.host.userMessageContent).toHaveLength(1)
			expect(replayed?.effectStartedToolCallIds).toEqual(["read-0"])
			expect(replayed?.items.filter((item) => item.type === "tool_result").map((item) => item.status)).toEqual([
				"indeterminate",
			])
		} finally {
			controller.abort()
			releaseDispatch.resolve()
			await fixture.lifecycle.close()
		}
	})
})
