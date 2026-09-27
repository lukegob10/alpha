import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { createAgentResponse } from "../../agent/AgentResponse"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { Task } from "../Task"

describe("completed provider tool-call receipts", () => {
	it("waits for the explicit completion marker and publishes one durable acceptance before EOF", async () => {
		const fixture = await createFixture()
		try {
			const completedCalls: string[] = []
			const accumulator = new AgentResponseAccumulator()
			const onCompleted = async (call: { id: string; name: string; arguments: unknown }) => {
				completedCalls.push(call.id)
				await (fixture.task as any).publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
			}
			const call = { type: "tool_call" as const, id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }

			await accumulator.add(call, undefined, undefined, onCompleted)
			expect(completedCalls).toEqual([])
			expect(fixture.journal.getSnapshot()?.acceptedToolCallIds).toEqual([])

			await accumulator.add({ type: "tool_call_end", id: call.id }, undefined, undefined, onCompleted)
			expect(completedCalls).toEqual([call.id])
			expect(fixture.journal.getSnapshot()?.items.find((item) => item.type === "tool_call")).toMatchObject({
				toolCallId: call.id,
				name: call.name,
				arguments: { path: "a.ts" },
			})
			expect(fixture.journal.getSnapshot()?.effectStartedToolCallIds).toEqual([])
			expect(fixture.journal.getSnapshot()?.terminalToolCallIds).toEqual([])
			expect(fixture.publishOptions).toContainEqual({ durable: true })

			// Payload fragments after the provider's end marker must not replace the
			// accepted arguments or create another receipt.
			await accumulator.add(
				{ type: "tool_call_delta", id: call.id, delta: '{"path":"changed.ts"}' },
				undefined,
				undefined,
				onCompleted,
			)
			await (fixture.task as any).publishCanonicalLifecycleResponseItems(
				createAgentResponse([{ type: "tool_call", id: call.id, name: call.name, arguments: { path: "a.ts" } }]),
				{ stepId: fixture.stepId },
			)

			const snapshot = await fixture.journal.replay()
			expect(snapshot?.acceptedToolCallIds).toEqual([call.id])
			expect(snapshot?.items.filter((item) => item.type === "tool_call")).toHaveLength(1)
			expect(snapshot?.items.find((item) => item.type === "tool_call")).toMatchObject({
				arguments: { path: "a.ts" },
			})
		} finally {
			await fixture.close()
		}
	})

	it("waits for an end marker after later argument deltas complete a partial payload", async () => {
		const accumulator = new AgentResponseAccumulator()
		const completed: Array<{ id: string; arguments: unknown }> = []
		const onCompleted = (call: { id: string; arguments: unknown }) => {
			completed.push(call)
		}

		await accumulator.add(
			{ type: "tool_call_partial", index: 0, id: "partial-call", name: "read_file", arguments: '{"path":"' },
			undefined,
			undefined,
			onCompleted,
		)
		await accumulator.add(
			{ type: "tool_call_partial", index: 0, id: "partial-call", arguments: 'a.ts"}' },
			undefined,
			undefined,
			onCompleted,
		)
		expect(completed).toEqual([])

		// A later complete payload can replace the streamed partial before the
		// provider signals that this output item is done.
		await accumulator.add(
			{ type: "tool_call", id: "partial-call", name: "read_file", arguments: '{"path":"final.ts"}' },
			undefined,
			undefined,
			onCompleted,
		)
		expect(completed).toEqual([])
		await accumulator.add({ type: "tool_call_end", id: "partial-call" }, undefined, undefined, onCompleted)

		expect(completed).toEqual([
			{ type: "tool_call", id: "partial-call", name: "read_file", arguments: { path: "final.ts" } },
		])
	})

	it("pairs an accepted call into provider history after a crash before EOF without executing it", async () => {
		const fixture = await createFixture()
		try {
			const call = { id: "crash-call", name: "write_to_file", arguments: { path: "state.txt", content: "x" } }
			await (fixture.task as any).publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
			fixture.task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "write state.txt" }], ts: 1 },
			]
			const overwrite = vi.fn(async (history: unknown[]) => {
				fixture.task.apiConversationHistory = history
				return true
			})
			fixture.task.overwriteApiConversationHistory = overwrite

			await (fixture.task as any).recoverIncompleteCanonicalToolCallsForResume()

			expect(overwrite).toHaveBeenCalledOnce()
			expect(fixture.task.apiConversationHistory).toHaveLength(3)
			expect(fixture.task.apiConversationHistory[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }],
			})
			expect(fixture.task.apiConversationHistory[2]).toMatchObject({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: call.id,
						is_error: true,
						content: expect.stringContaining("not executed"),
					},
				],
			})
			expect(fixture.journal.getSnapshot()).toMatchObject({
				status: "interrupted",
				acceptedToolCallIds: [call.id],
				terminalToolCallIds: [call.id],
			})

			await (fixture.task as any).recoverIncompleteCanonicalToolCallsForResume()
			expect(overwrite).toHaveBeenCalledOnce()
			expect(fixture.task.apiConversationHistory).toHaveLength(3)
		} finally {
			await fixture.close()
		}
	})

	it("retries provider-history pairing after a terminal receipt was persisted before the crash", async () => {
		const fixture = await createFixture()
		try {
			const call = { id: "receipt-before-transcript", name: "write_to_file", arguments: { path: "state.txt" } }
			await (fixture.task as any).publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
			await (fixture.task as any).enqueueCanonicalLifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId: `${fixture.stepId}:tool-result-${call.id}`,
						stepId: fixture.stepId,
						type: "tool_result",
						toolCallId: call.id,
						status: "cancelled",
						output: "Tool call was not executed because the task stopped before its effect began.",
					},
				},
				fixture.stepId,
				undefined,
				{ durable: true, required: true },
			)
			fixture.task.apiConversationHistory = [
				{ role: "user", content: [{ type: "text", text: "write state.txt" }], ts: 1 },
			]
			const overwrite = vi.fn(async (history: unknown[]) => {
				fixture.task.apiConversationHistory = history
				return true
			})
			fixture.task.overwriteApiConversationHistory = overwrite

			await (fixture.task as any).recoverIncompleteCanonicalToolCallsForResume()

			expect(overwrite).toHaveBeenCalledOnce()
			expect(fixture.task.apiConversationHistory[1]).toMatchObject({
				role: "assistant",
				content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }],
			})
			expect(fixture.task.apiConversationHistory[2]).toMatchObject({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: call.id,
						is_error: true,
						content: expect.stringContaining("not executed"),
					},
				],
			})
		} finally {
			await fixture.close()
		}
	})
})

async function createFixture() {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-completed-call-"))
	const taskId = `task-${randomUUID()}`
	const runId = "run"
	const turnId = "turn"
	const stepId = "turn:step-1"
	const journal = new AgentLifecycleJournal(taskId, storage)
	const identity = { version: 1 as const, taskId, runId, turnId, occurredAt: 1 }
	await journal.append({
		...identity,
		eventId: "turn-started",
		type: "turn_started",
		payload: { phase: "starting", effectTrackingVersion: 1 },
	})
	await journal.append({
		...identity,
		eventId: "step-started",
		stepId,
		type: "step_started",
		payload: { phase: "working" },
	})
	const publishOptions: unknown[] = []
	const provider = {
		getAgentLifecycleSnapshot: () => journal.getSnapshot(),
		replayAgentLifecycle: async () => journal.replay(),
		publishAgentLifecycleEvent: async (event: AgentLifecycleEventInput, options?: { durable?: boolean }) => {
			publishOptions.push(options)
			const receipt = await journal.append(event, options)
			return { accepted: true, event: receipt.event, snapshot: receipt.snapshot }
		},
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId,
		agentRunId: runId,
		agentTurnId: turnId,
		providerRef: new WeakRef(provider),
		canonicalLifecycleQueue: Promise.resolve(),
		apiConversationHistory: [],
	}) as any
	return {
		task,
		journal,
		stepId,
		publishOptions,
		close: async () => {
			await journal.close()
			await fs.rm(storage, { recursive: true, force: true })
		},
	}
}
