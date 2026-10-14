import path from "path"
import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import type { AgentToolCall } from "../../agent/AgentResponse"
import { getToolBatchIsolationError, ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"

const barriers = ["new_task", "delegate_task", "attempt_completion", "ask_followup_question", "wait_agent"]
const terminalBarriers = barriers.filter((name) => name !== "wait_agent")
const workspace = path.resolve("scheduler-fence-fixture")

function toolCall(id: string, name: string, args: unknown = {}): AgentToolCall {
	return { type: "tool_call", id, name, arguments: args }
}

function executionCallId(call: { id?: string }): string {
	if (!call.id) throw new Error("Synthetic scheduler execution requires a call ID.")
	return call.id
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function descriptor(
	name: string,
	options: {
		concurrency: "parallel" | "barrier"
		execute?: ToolDescriptor["execute"]
		aliases?: readonly string[]
	},
): ToolDescriptor {
	const isBarrier = options.concurrency === "barrier"
	return {
		name,
		aliases: options.aliases ?? [],
		schema: {
			type: "function",
			function: { name, description: `Synthetic ${name}`, parameters: { type: "object", properties: {} } },
		},
		capabilities: {
			concurrency: options.concurrency,
			sideEffects: isBarrier ? "task" : "none",
			controlFlow: isBarrier,
			requiresApproval: false,
		},
		...(options.concurrency === "parallel"
			? { getConcurrencyScope: (call, cwd) => path.resolve(cwd, executionCallId(call)) }
			: {}),
		execute: options.execute ?? (async () => {}),
	}
}

function createRegistry(executors: Readonly<Record<string, ToolDescriptor["execute"]>> = {}): ToolRegistry {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	for (const name of ["list_agents", "search_files", "list_files"]) {
		registry.register(descriptor(name, { concurrency: "parallel", execute: executors[name] }))
	}
	for (const name of barriers) {
		registry.register(
			descriptor(name, {
				concurrency: "barrier",
				aliases: name === "attempt_completion" ? ["finish_session"] : [],
				execute: executors[name],
			}),
		)
	}
	return registry
}

function createHost() {
	const results: Anthropic.ToolResultBlockParam[] = []
	const host: ToolExecutionHost = {
		taskId: "scheduler-fence",
		cwd: workspace,
		userMessageContent: results,
		say: vi.fn().mockResolvedValue(undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent: (result) => {
			if (results.some((existing) => existing.tool_use_id === result.tool_use_id)) return false
			results.push(result)
			return true
		},
	}
	return { host, results }
}

function receiptIds(results: readonly Anthropic.ToolResultBlockParam[]): string[] {
	return results.map((result) => result.tool_use_id)
}

describe("tool batch isolation and scheduler fences", () => {
	it("preserves the legacy Task helper contract for terminal barriers and aliases", () => {
		const registry = createRegistry()
		expect(getToolBatchIsolationError(registry, [])).toBeUndefined()
		expect(getToolBatchIsolationError(registry, ["attempt_completion"])).toBeUndefined()
		expect(getToolBatchIsolationError(registry, ["list_agents", "search_files"])).toBeUndefined()

		for (const barrier of terminalBarriers) {
			expect(getToolBatchIsolationError(registry, [barrier, "list_agents"])).toContain(
				`${barrier} must be called by itself`,
			)
			expect(getToolBatchIsolationError(registry, ["list_agents", barrier])).toContain(
				`${barrier} must be called by itself`,
			)
		}
		expect(getToolBatchIsolationError(registry, ["wait_agent", "list_agents"])).toBeUndefined()
		expect(getToolBatchIsolationError(registry, ["list_agents", "finish_session"])).toContain(
			"finish_session must be called by itself",
		)
	})

	it("runs calls on both sides of an aliased barrier as exclusive ordered fences", async () => {
		const beforeOneStarted = deferred()
		const beforeTwoStarted = deferred()
		const beforeOneFinished = deferred()
		const beforeTwoFinished = deferred()
		const barrierStarted = deferred()
		const barrierRelease = deferred()
		const afterStarted = deferred()
		const afterRelease = deferred()
		const beforeOneRelease = deferred()
		const beforeTwoRelease = deferred()
		const startOrder: string[] = []
		const finishOrder: string[] = []

		const executeRead =
			(
				started: ReturnType<typeof deferred>,
				release: ReturnType<typeof deferred>,
				finished: ReturnType<typeof deferred>,
			): ToolDescriptor["execute"] =>
			async ({ call, callbacks }) => {
				const callId = executionCallId(call)
				startOrder.push(callId)
				started.resolve()
				await release.promise
				callbacks.pushToolResult(`result:${callId}`)
				finishOrder.push(callId)
				finished.resolve()
			}
		const registry = createRegistry({
			list_agents: executeRead(beforeOneStarted, beforeOneRelease, beforeOneFinished),
			search_files: executeRead(beforeTwoStarted, beforeTwoRelease, beforeTwoFinished),
			attempt_completion: async ({ call, callbacks }) => {
				const callId = executionCallId(call)
				startOrder.push(callId)
				barrierStarted.resolve()
				await barrierRelease.promise
				callbacks.pushToolResult(`result:${callId}`)
				finishOrder.push(callId)
			},
			list_files: async ({ call, callbacks }) => {
				const callId = executionCallId(call)
				startOrder.push(callId)
				afterStarted.resolve()
				await afterRelease.promise
				callbacks.pushToolResult(`result:${callId}`)
				finishOrder.push(callId)
			},
		})
		const { host, results: receipts } = createHost()
		const calls = [
			toolCall("before-1", "list_agents"),
			toolCall("before-2", "search_files"),
			toolCall("fence", "finish_session"),
			toolCall("after", "list_files"),
		]
		const run = new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 2,
			validateCall: () => {},
		}).run(calls)

		await Promise.all([beforeOneStarted.promise, beforeTwoStarted.promise])
		expect(startOrder).toEqual(["before-1", "before-2"])

		// Complete the second model call first. The barrier still waits for the
		// entire preceding read window before it may start.
		beforeTwoRelease.resolve()
		await beforeTwoFinished.promise
		expect(startOrder).toEqual(["before-1", "before-2"])
		beforeOneRelease.resolve()
		await Promise.all([beforeOneFinished.promise, barrierStarted.promise])
		expect(startOrder).toEqual(["before-1", "before-2", "fence"])
		expect(finishOrder).toEqual(["before-2", "before-1"])

		barrierRelease.resolve()
		await afterStarted.promise
		expect(startOrder).toEqual(["before-1", "before-2", "fence", "after"])
		afterRelease.resolve()

		const outcome = await run
		expect(outcome.status).toBe("completed")
		expect(outcome.results.map((result) => result.callId)).toEqual(calls.map((call) => call.id))
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "success", "success", "success"])
		expect(outcome.completedToolResultCount).toBe(calls.length)
		expect(receiptIds(receipts)).toEqual(calls.map((call) => call.id))
		expect(new Set(receiptIds(receipts)).size).toBe(calls.length)
		expect(finishOrder).toEqual(["before-2", "before-1", "fence", "after"])
	})

	it.each([
		{ label: "disabled", options: { disabledTools: ["attempt_completion"] }, arguments: {} },
		{ label: "malformed", options: {}, arguments: null },
	])("keeps neighboring calls runnable when a barrier is $label", async ({ options, arguments: args }) => {
		const executed: string[] = []
		const executeRead: ToolDescriptor["execute"] = async ({ call, callbacks }) => {
			const callId = executionCallId(call)
			executed.push(callId)
			callbacks.pushToolResult(`result:${callId}`)
		}
		const executeBarrier = vi.fn<ToolDescriptor["execute"]>(async ({ call, callbacks }) => {
			const callId = executionCallId(call)
			executed.push(callId)
			callbacks.pushToolResult(`result:${callId}`)
		})
		const registry = createRegistry({
			list_agents: executeRead,
			search_files: executeRead,
			attempt_completion: executeBarrier,
		})
		const { host, results: receipts } = createHost()
		const calls = [
			toolCall("before", "list_agents"),
			toolCall("barrier", "attempt_completion", args),
			toolCall("after", "search_files"),
		]
		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 2,
			...options,
		}).run(calls)

		expect(executeBarrier).not.toHaveBeenCalled()
		expect(executed).toEqual(["before", "after"])
		expect(outcome.results.map((result) => result.callId)).toEqual(calls.map((call) => call.id))
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "success"])
		expect(receiptIds(receipts)).toEqual(calls.map((call) => call.id))
		expect(new Set(receiptIds(receipts)).size).toBe(calls.length)
	})

	it("returns one ordered cancellation receipt per call without admitting the barrier suffix", async () => {
		const controller = new AbortController()
		const bothReadsStarted = deferred()
		let readStarts = 0
		const started: string[] = []
		const executeCancelableRead: ToolDescriptor["execute"] = async ({ call, signal }) => {
			started.push(executionCallId(call))
			readStarts += 1
			if (readStarts === 2) bothReadsStarted.resolve()
			await new Promise<void>((resolve) => {
				if (signal?.aborted) {
					resolve()
				} else {
					signal?.addEventListener("abort", () => resolve(), { once: true })
				}
			})
		}
		const barrierExecute = vi.fn<ToolDescriptor["execute"]>(async ({ call }) => {
			started.push(executionCallId(call))
		})
		const registry = createRegistry({
			list_agents: executeCancelableRead,
			search_files: executeCancelableRead,
			attempt_completion: barrierExecute,
			list_files: async ({ call }) => {
				started.push(executionCallId(call))
			},
		})
		const { host, results: receipts } = createHost()
		const calls = [
			toolCall("read-1", "list_agents"),
			toolCall("read-2", "search_files"),
			toolCall("fence", "attempt_completion"),
			toolCall("after", "list_files"),
		]
		const run = new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			signal: controller.signal,
			preserveAbortedResults: true,
			executionMode: "selective-parallel",
			maxConcurrency: 2,
		}).run(calls)

		await bothReadsStarted.promise
		controller.abort()
		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.callId)).toEqual(calls.map((call) => call.id))
		expect(outcome.results.map((result) => result.status)).toEqual([
			"cancelled",
			"cancelled",
			"cancelled",
			"cancelled",
		])
		expect(started).toEqual(["read-1", "read-2"])
		expect(barrierExecute).not.toHaveBeenCalled()
		expect(receiptIds(receipts)).toEqual(calls.map((call) => call.id))
		expect(new Set(receiptIds(receipts)).size).toBe(calls.length)
	})
})
