import type { Anthropic } from "@anthropic-ai/sdk"
import os from "os"
import path from "path"
import { describe, expect, it, vi } from "vitest"

import { ToolRegistry, type PreparedCommandRead, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

type ReadCallbacks = Parameters<NonNullable<PreparedCommandRead["run"]>>[0]

const text = (value: string): Anthropic.TextBlockParam => ({ type: "text", text: value })
const image = (data: string): Anthropic.ImageBlockParam => ({
	type: "image",
	source: { type: "base64", media_type: "image/png", data },
})
const media = (caption: string, images: readonly [string, string]) => [
	text(`${caption} first`),
	image(images[0]),
	text(`${caption} second`),
	image(images[1]),
]
const call = (id: string) => ({
	type: "tool_call" as const,
	id,
	name: "exec_command",
	arguments: { cmd: "git status", yield_time_ms: 10_000 },
})

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

function fixture(run: (callId: string, callbacks: ReadCallbacks) => Promise<void>) {
	const cwd = path.resolve(os.tmpdir(), "scheduler-deferred-media-fixture")
	const history: ToolExecutionHost["userMessageContent"] = []
	const events: AgentTurnEvent[] = []
	const host: ToolExecutionHost = {
		taskId: "deferred-command-read-media",
		cwd,
		abort: false,
		userMessageContent: history,
		userMessageContentReady: false,
		pushToolResultToUserContent: vi.fn((result: Anthropic.ToolResultBlockParam) => {
			if (history.some((part) => part.type === "tool_result" && part.tool_use_id === result.tool_use_id))
				return false
			history.push(result)
			return true
		}),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
	}
	const finalized: string[] = []
	const runRead = vi.fn(run)
	const execute = vi.fn<ToolDescriptor["execute"]>(async () => {
		throw new Error("Deferred media fixture must use its captured isolated command read.")
	})
	// Use the same captured command-read contract as ToolScheduler.command-batching.spec.ts.
	// Only the isolated executor is stubbed; the real scheduler owns collection and commit.
	const descriptor: ToolDescriptor = {
		name: "exec_command",
		aliases: [],
		schema: { type: "function", function: { name: "exec_command", parameters: { type: "object" } } },
		statusSource: "handler",
		capabilities: {
			concurrency: "serial",
			sideEffects: "workspace",
			controlFlow: false,
			requiresApproval: true,
			parallelCommandRead: true,
		},
		prepareParallelCommand: vi.fn<NonNullable<ToolDescriptor["prepareParallelCommand"]>>(async (context) => {
			if (!(await context.callbacks.askApproval("command", "git status"))) return undefined
			return {
				scope: cwd,
				run: async (callbacks: ReadCallbacks) => {
					await runRead(context.call.id!, callbacks)
					return async () => {
						finalized.push(context.call.id!)
					}
				},
			}
		}),
		execute,
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register(descriptor)
	const policy = createToolPolicySnapshot({
		visibleTools: ["exec_command"],
		allowedTools: ["exec_command"],
		capabilities: { exec_command: descriptor.capabilities },
		execution: { workspaceRoots: [cwd] },
	})
	const controller = new AbortController()
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry,
		mode: "code",
		policy,
		validateCall: () => {},
		executionMode: "selective-parallel",
		maxConcurrency: 2,
		requirePreparedCommandRead: true,
		deferResultCommit: true,
		preserveAbortedResults: true,
		signal: controller.signal,
		onEvent: (event) => {
			events.push(event)
		},
	})
	return { host, history, events, finalized, runRead, execute, descriptor, policy, scheduler, controller }
}

function terminalEvents(events: AgentTurnEvent[]) {
	return events.filter((event) => event.type === "tool_result" || event.type === "tool_batch_finished")
}

describe("ToolScheduler deferred media through captured command reads", () => {
	it("commits ordered mixed media and paired success/error receipts once after reverse read completion", async () => {
		const releaseFirst = barrier()
		const secondFinished = barrier()
		const completionOrder: string[] = []
		const firstContent = media("First call", ["Zmlyc3Q=", "c2Vjb25k"])
		const secondContent = media("Second call", ["dGhpcmQ=", "Zm91cnRo"])
		const execution = fixture(async (callId, callbacks) => {
			if (callId === "media-read-first") await releaseFirst.promise
			callbacks.setResultMetadata?.({ status: callId === "media-read-first" ? "success" : "error" })
			callbacks.pushToolResult(callId === "media-read-first" ? firstContent : secondContent)
			completionOrder.push(callId)
			if (callId === "media-read-second") secondFinished.resolve()
		})
		const calls = [call("media-read-first"), call("media-read-second")]
		const running = execution.scheduler.run(calls)
		const settled = running.then(
			() => true,
			() => true,
		)
		try {
			expect(await Promise.race([secondFinished.promise.then(() => true), settled.then(() => false)])).toBe(true)
			expect(completionOrder).toEqual(["media-read-second"])
			releaseFirst.resolve()
			const outcome = await running

			expect(completionOrder).toEqual(["media-read-second", "media-read-first"])
			expect(execution.policy.capabilities.exec_command.parallelCommandRead).toBe(true)
			expect(execution.descriptor.prepareParallelCommand).toHaveBeenCalledTimes(2)
			expect(execution.host.askApproval).toHaveBeenCalledTimes(2)
			expect(execution.runRead).toHaveBeenCalledTimes(2)
			expect(execution.execute).not.toHaveBeenCalled()
			expect(outcome.results).toMatchObject([
				{ callId: calls[0].id, name: "exec_command", status: "success", content: firstContent },
				{ callId: calls[1].id, name: "exec_command", status: "error", content: secondContent },
			])
			expect(outcome.results).toHaveLength(2)
			expect(execution.history).toEqual([])
			expect(execution.host.userMessageContentReady).toBe(false)
			expect(terminalEvents(execution.events)).toEqual([])
			expect(execution.finalized).toEqual([])

			await execution.scheduler.commitDeferredResults()
			await execution.scheduler.commitDeferredResults()

			expect(execution.finalized).toEqual(calls.map((item) => item.id))
			expect(execution.history).toEqual([
				{ type: "tool_result", tool_use_id: calls[0].id, is_error: false, content: firstContent },
				{ type: "tool_result", tool_use_id: calls[1].id, is_error: true, content: secondContent },
			])
			expect(execution.host.pushToolResultToUserContent).toHaveBeenCalledTimes(2)
			expect(execution.host.userMessageContentReady).toBe(true)
			expect(terminalEvents(execution.events)).toEqual([
				expect.objectContaining({
					type: "tool_result",
					callId: calls[0].id,
					status: "success",
					output: firstContent,
				}),
				expect.objectContaining({
					type: "tool_result",
					callId: calls[1].id,
					status: "error",
					output: secondContent,
				}),
				expect.objectContaining({ type: "tool_batch_finished", status: "completed", batchSize: 2 }),
			])
		} finally {
			releaseFirst.resolve()
			await settled
		}
	})

	it("commits one cancelled deferred read receipt and rejects late mixed media", async () => {
		const started = barrier()
		const release = barrier()
		const execution = fixture(async (_callId, callbacks) => {
			started.resolve()
			await release.promise
			callbacks.setResultMetadata?.({ status: "success" })
			callbacks.pushToolResult([text("Late caption"), image("bGF0ZQ==")])
		})
		const pendingCall = call("media-read-cancelled")
		const running = execution.scheduler.run([pendingCall])
		const settled = running.then(
			() => true,
			() => true,
		)
		try {
			expect(await Promise.race([started.promise.then(() => true), settled.then(() => false)])).toBe(true)
			execution.controller.abort(new Error("cancelled during isolated media read"))
			release.resolve()
			const outcome = await running

			expect(outcome.status).toBe("aborted")
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0]).toMatchObject({ callId: pendingCall.id, status: "cancelled" })
			expect(execution.history).toEqual([])
			expect(terminalEvents(execution.events)).toEqual([])
			await execution.scheduler.commitDeferredResults()
			await execution.scheduler.commitDeferredResults()

			expect(execution.history).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: pendingCall.id, is_error: true }),
			])
			expect(execution.host.pushToolResultToUserContent).toHaveBeenCalledOnce()
			expect(JSON.stringify(execution.history)).not.toContain("Late caption")
			expect(JSON.stringify(execution.history)).not.toContain('"type":"image"')
			expect(execution.finalized).toEqual([])
			expect(execution.runRead).toHaveBeenCalledOnce()
			expect(execution.execute).not.toHaveBeenCalled()
			expect(terminalEvents(execution.events)).toEqual([
				expect.objectContaining({ type: "tool_result", callId: pendingCall.id, status: "cancelled" }),
				expect.objectContaining({ type: "tool_batch_finished", status: "aborted", batchSize: 1 }),
			])
		} finally {
			release.resolve()
			await settled
		}
	})
})
