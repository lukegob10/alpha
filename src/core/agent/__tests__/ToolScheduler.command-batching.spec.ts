import path from "path"
import os from "os"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ToolScheduler, type ToolExecutionHost, type ToolExecutionMode } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"

function fixture(
	mode: ToolExecutionMode,
	count = 12,
	preparation: "read" | "fallback" | "mutation" = "read",
	durationForCall: (id: string) => number = () => 100,
) {
	let active = 0
	let peak = 0
	const trace: string[] = []
	const cwd = path.resolve(os.tmpdir(), "command-batch-fixture")
	const host: ToolExecutionHost = {
		taskId: "batch",
		cwd,
		userMessageContent: [],
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
		say: async () => {},
		recordToolUsage: vi.fn(),
		askApproval: vi.fn(async () => {
			expect(active).toBe(0)
			trace.push("approval")
			return { response: "yesButtonClicked" as const }
		}),
	}
	const run: ToolDescriptor["execute"] = async ({ call, callbacks }) => {
		active++
		peak = Math.max(peak, active)
		trace.push(`start:${call.id}`)
		await new Promise<void>((resolve) => setTimeout(resolve, durationForCall(call.id!)))
		active--
		trace.push(`end:${call.id}`)
		callbacks.setResultMetadata?.({ status: "success", exitCode: 0 })
		callbacks.pushToolResult(call.id!)
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
			parallelCommandRead: true,
		},
		prepareParallelCommand: async (context) => {
			if (preparation === "mutation" && context.call.id === "command-4") return undefined
			if (!(await context.callbacks.askApproval("command", "git status"))) return undefined
			if (preparation === "fallback") return { scope: cwd, serialFallback: true }
			return {
				scope: cwd,
				run: async (callbacks) => {
					await run({ ...context, callbacks: { ...context.callbacks, ...callbacks } })
					return async () => {
						trace.push(`publish:${context.call.id}`)
					}
				},
			}
		},
		execute: async (context) => {
			if (await context.callbacks.askApproval("command", "git status")) await run(context)
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register(descriptor)
	const controller = new AbortController()
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry,
		mode: "code",
		executionMode: mode,
		policy: createToolPolicySnapshot({
			visibleTools: ["execute_command"],
			capabilities: { execute_command: descriptor.capabilities },
		}),
		signal: controller.signal,
		preserveAbortedResults: true,
	})
	const calls = Array.from({ length: count }, (_, index) => ({
		type: "tool_call" as const,
		id: `command-${index}`,
		name: "execute_command",
		arguments: { command: "git status" },
	}))
	return { scheduler, calls, host, trace, controller, registry, descriptor, peak: () => peak, active: () => active }
}

describe("approved command batches", () => {
	afterEach(() => vi.useRealTimers())

	it.each(["serial", "selective-parallel"] as const)("measures the same 12 inspections in %s mode", async (mode) => {
		vi.useFakeTimers()
		const test = fixture(mode)
		const started = Date.now()
		const pending = test.scheduler.run(test.calls)
		await vi.runAllTimersAsync()
		const outcome = await pending
		const elapsed = Date.now() - started
		console.info(JSON.stringify({ mode, commands: 12, elapsedMs: elapsed, peakProcesses: test.peak() }))
		expect(outcome.results.map((result) => result.callId)).toEqual(test.calls.map((call) => call.id))
		expect(outcome.results.every((result) => result.status === "success" && result.exitCode === 0)).toBe(true)
		expect(test.host.askApproval).toHaveBeenCalledTimes(12)
		expect(test.host.recordToolUsage).toHaveBeenCalledTimes(12)
		expect(test.active()).toBe(0)
		expect(elapsed).toBe(mode === "serial" ? 1_200 : 300)
		expect(test.peak()).toBe(mode === "serial" ? 1 : 4)
	})

	it("joins out-of-order processes before publishing their outputs in model-call order", async () => {
		vi.useFakeTimers()
		const test = fixture("selective-parallel", 4, "read", (id) => 40 - Number(id.split("-")[1]) * 10)
		const pending = test.scheduler.run(test.calls)
		await vi.runAllTimersAsync()
		const outcome = await pending
		expect(test.trace.filter((entry) => entry.startsWith("end:"))).toEqual([
			"end:command-3",
			"end:command-2",
			"end:command-1",
			"end:command-0",
		])
		expect(test.trace.slice(-4)).toEqual(test.calls.map(({ id }) => `publish:${id}`))
		expect(outcome.results.map(({ callId }) => callId)).toEqual(test.calls.map(({ id }) => id))
	})

	it("joins active processes on cancellation and closes queued calls without starting them", async () => {
		vi.useFakeTimers()
		const test = fixture("selective-parallel")
		const pending = test.scheduler.run(test.calls)
		await vi.advanceTimersByTimeAsync(0)
		expect(test.active()).toBe(4)
		test.controller.abort()
		await vi.runAllTimersAsync()
		const outcome = await pending
		expect(test.active()).toBe(0)
		expect(test.trace.filter((entry) => entry.startsWith("start:"))).toHaveLength(4)
		expect(outcome.results).toHaveLength(12)
		expect(outcome.results.every((result) => result.status === "cancelled")).toBe(true)
		expect(test.host.userMessageContent).toHaveLength(12)
	})

	it("does not execute or re-ask a denied prepared command", async () => {
		vi.useFakeTimers()
		const test = fixture("selective-parallel", 2)
		vi.mocked(test.host.askApproval!).mockResolvedValueOnce({ response: "noButtonClicked" })
		const pending = test.scheduler.run(test.calls)
		await vi.runAllTimersAsync()
		const outcome = await pending
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "success"])
		expect(test.host.askApproval).toHaveBeenCalledTimes(2)
		expect(test.trace).not.toContain("start:command-0")
	})

	it("reuses the exact approval for a serial compatibility fallback", async () => {
		vi.useFakeTimers()
		const test = fixture("selective-parallel", 2, "fallback")
		const pending = test.scheduler.run(test.calls)
		await vi.runAllTimersAsync()
		const outcome = await pending
		expect(test.peak()).toBe(1)
		expect(test.host.askApproval).toHaveBeenCalledTimes(2)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
	})

	it("joins read batches before a mutating command and then resumes batching", async () => {
		vi.useFakeTimers()
		const test = fixture("selective-parallel", 9, "mutation")
		const pending = test.scheduler.run(test.calls)
		await vi.runAllTimersAsync()
		await pending
		const start = test.trace.indexOf("start:command-4")
		expect(test.trace.indexOf("end:command-3")).toBeLessThan(start)
		expect(test.trace.indexOf("start:command-5")).toBeGreaterThan(test.trace.indexOf("end:command-4"))
		expect(test.peak()).toBe(4)
	})
})
