import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
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

	for (const boundary of ["canonical repair", "legacy resume"] as const) {
		it.each([
			{ label: "typed clipping receipt", output: "Diagnostic fragment", outputTruncated: true, incomplete: true },
			{ label: "legacy clipping marker", output: "Diagnostic fragment\n[truncated]", incomplete: true },
			{
				label: "joined output beyond the recovery limit",
				output: Array.from({ length: 3 }, () => ({ type: "text", text: "x".repeat(6_100) })),
				incomplete: true,
			},
			{
				label: "mixed text and non-text output",
				output: [
					{ type: "text", text: "Screenshot captured." },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image" } },
				],
				incomplete: true,
			},
			{
				label: "non-text-only output",
				output: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "fixture-image" } }],
				incomplete: true,
			},
			{ label: "intact small output", output: "File was updated.", incomplete: false },
		])(`keeps $label explicit at ${boundary} without replaying a mutation`, async (scenario) => {
			const fixture = await createFixture()
			const effects = vi.spyOn(ToolScheduler.prototype, "run")
			try {
				const call = await recordJournalMutationResult(
					fixture,
					scenario.output,
					"outputTruncated" in scenario ? scenario.outputTruncated : undefined,
				)
				let recovered: Anthropic.Messages.ToolResultBlockParam | undefined
				if (boundary === "canonical repair") {
					const overwrite = vi.fn(async (history: typeof fixture.task.apiConversationHistory) => {
						fixture.task.apiConversationHistory = history
						return true
					})
					fixture.task.overwriteApiConversationHistory = overwrite
					await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
					recovered = fixture.task.apiConversationHistory.at(-1)?.content[0]
					await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
					expect(overwrite).toHaveBeenCalledOnce()
				} else {
					const initiate = prepareLegacyResume(fixture)
					await fixture.task.resumeTaskFromHistory("Resume safely", undefined, undefined, {
						reuseRetainedHistory: true,
					})
					recovered = initiate.mock.calls[0]?.[0].find((block) => block.type === "tool_result")
				}
				expect(recovered).toMatchObject({
					type: "tool_result",
					tool_use_id: call.id,
					is_error: scenario.incomplete,
				})
				if (scenario.incomplete) {
					expect(recovered?.content).toEqual(expect.stringMatching(/incomplete|unavailable|truncated/i))
					expect(recovered?.content).toEqual(expect.stringMatching(/verify|inspect|check/i))
				} else expect(recovered?.content).toBe(scenario.output)
				expect(effects).not.toHaveBeenCalled()
				expect(fixture.journal.getSnapshot()).toMatchObject({
					acceptedToolCallIds: [call.id],
					effectStartedToolCallIds: [call.id],
					terminalToolCallIds: [call.id],
				})
			} finally {
				effects.mockRestore()
				await fixture.close()
			}
		})

		it(`prefers the full canonical receipt over its journal preview at ${boundary}`, async () => {
			const fixture = await createFixture()
			try {
				const call = await recordJournalMutationResult(fixture, "Diagnostic fragment", true)
				const fullOutput = `Full retained output ${"x".repeat(30_000)}`
				const receipt: Anthropic.Messages.ToolResultBlockParam = {
					type: "tool_result",
					tool_use_id: call.id,
					content: fullOutput,
					is_error: false,
				}
				fixture.task.apiConversationHistory.push({ role: "user", content: [receipt] })
				const originalHistory = structuredClone(fixture.task.apiConversationHistory)
				const overwrite = vi.fn()
				fixture.task.overwriteApiConversationHistory = overwrite
				if (boundary === "canonical repair") await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
				else {
					const initiate = prepareLegacyResume(fixture)
					await fixture.task.resumeTaskFromHistory("Resume safely", undefined, undefined, {
						reuseRetainedHistory: true,
					})
					expect(initiate.mock.calls[0]?.[0].filter((block) => block.type === "tool_result")).toEqual([])
				}
				expect(fixture.task.apiConversationHistory).toEqual(originalHistory)
				expect(fixture.task.apiConversationHistory.at(-1)?.content[0]).toEqual(receipt)
				expect(overwrite).not.toHaveBeenCalled()
			} finally {
				await fixture.close()
			}
		})
	}
	it.each([
		{ legacyCall: false, failed: false },
		{ legacyCall: false, failed: true },
		{ legacyCall: true, failed: false },
		{ legacyCall: true, failed: true },
	])("recovers an accepted historical alias without replacing its result: %o", async ({ legacyCall, failed }) => {
		const fixture = await createFixture()
		try {
			const call = { id: "retained-call", name: "write_to_file", arguments: { path: "state.txt" } }
			await fixture.task.publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
			await fixture.task.enqueueCanonicalLifecycleEvent(
				"tool_effect_started",
				{ toolCallId: call.id },
				fixture.stepId,
				undefined,
				{ durable: true, required: true },
			)
			fixture.task.apiConversationHistory = [
				{
					role: "assistant",
					content: [
						legacyCall
							? { type: "tool_call", tool_call_id: call.id, name: call.name, arguments: call.arguments }
							: { type: "tool_use", id: call.id, name: call.name, input: call.arguments },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_call_id: call.id, content: "retained output", is_error: failed },
					],
				},
			]
			const original = structuredClone(fixture.task.apiConversationHistory)
			const overwrite = vi.fn()
			fixture.task.overwriteApiConversationHistory = overwrite
			await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
			await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
			expect(overwrite).not.toHaveBeenCalled()
			expect(fixture.task.apiConversationHistory).toEqual(original)
			expect(fixture.journal.getSnapshot()?.items.filter((item) => item.type === "tool_result")).toEqual([
				expect.objectContaining({
					toolCallId: call.id,
					status: failed ? "error" : "success",
					output: "retained output",
				}),
			])
		} finally {
			await fixture.close()
		}
	})
	it("never pairs an older occurrence's receipt with a reused current call ID", async () => {
		const fixture = await createFixture()
		try {
			const call = { id: "reused-call", name: "read_file", arguments: { path: "new.txt" } }
			await fixture.task.publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
			fixture.task.apiConversationHistory = [
				{ role: "assistant", content: [{ type: "tool_use", id: call.id, name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_call_id: call.id, content: "old result" }] },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }],
				},
			]
			fixture.task.overwriteApiConversationHistory = vi.fn(async (history: unknown[]) => {
				fixture.task.apiConversationHistory = history
				return true
			})
			await fixture.task.recoverIncompleteCanonicalToolCallsForResume()
			expect(fixture.task.apiConversationHistory).toHaveLength(4)
			expect(fixture.task.apiConversationHistory[1].content[0]).toMatchObject({ content: "old result" })
			expect(fixture.task.apiConversationHistory[3].content[0]).toMatchObject({
				tool_use_id: call.id,
				is_error: true,
				content: expect.stringContaining("not executed"),
			})
		} finally {
			await fixture.close()
		}
	})
	it("persists a reused call ID's new scheduler output after flushing its earlier occurrence", async () => {
		const fixture = await createFixture()
		try {
			const firstCall = { id: "reused-through-flush", name: "read_file", arguments: { path: "first.txt" } }
			const firstResult = {
				type: "tool_result" as const,
				tool_use_id: firstCall.id,
				content: "first exact output",
				is_error: false,
			}
			const saveHistory = vi.fn(async () => true).mockResolvedValueOnce(false)
			Object.assign(fixture.task, {
				abort: false,
				assistantMessageSavedToHistory: true,
				userMessageContent: [],
				persistedToolResultIds: new Set<string>(),
				pendingWaitAgentResultClaims: new Map(),
				stagedWaitAgentNotifications: new Map(),
				pendingWaitAgentNotificationBlocks: new Set(),
				canonicalLifecycleStartedSteps: new Set<string>(),
				saveApiConversationHistory: saveHistory,
			})
			fixture.task.apiConversationHistory.push({
				role: "assistant",
				content: [{ type: "tool_use", id: firstCall.id, name: firstCall.name, input: firstCall.arguments }],
			})
			await fixture.task.publishCompletedCanonicalToolCall(firstCall, { stepId: fixture.stepId })
			expect(fixture.task.pushToolResultToUserContent(firstResult)).toBe(true)
			expect(fixture.task.pushToolResultToUserContent(firstResult)).toBe(false)
			await fixture.task.publishCanonicalLifecycleToolResult(
				{ callId: firstCall.id, status: "success", content: firstResult.content },
				{ stepId: fixture.stepId },
			)

			// A rejected save retains the actual receipt for retry, without accepting
			// another result for this same occurrence.
			expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(false)
			expect(fixture.task.apiConversationHistory).toHaveLength(1)
			expect(fixture.task.userMessageContent).toEqual([firstResult])
			expect(fixture.task.pushToolResultToUserContent(firstResult)).toBe(false)
			expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
			expect(fixture.task.apiConversationHistory[1]).toMatchObject({ role: "user", content: [firstResult] })
			expect(fixture.task.userMessageContent).toEqual([])
			const firstRunId = fixture.task.agentRunId
			const firstTurnId = fixture.task.agentTurnId
			await fixture.task.beginCanonicalLifecycleTurn()
			expect(fixture.task.agentRunId).toBe(firstRunId)
			expect(fixture.task.agentTurnId).toBe(firstTurnId)
			expect(fixture.task.hasToolResultForCall(firstCall.id)).toBe(true)
			expect(fixture.task.pushToolResultToUserContent(firstResult)).toBe(false)
			await fixture.task.enqueueCanonicalLifecycleEvent("turn_completed", {})

			// Exercise the real fresh-turn boundary instead of clearing the receipt
			// cache or replacing the Task facade in the fixture.
			await fixture.task.beginCanonicalLifecycleTurn()
			expect(fixture.task.agentTurnId).not.toBe(firstTurnId)
			const secondStep = {
				turnId: fixture.task.agentTurnId,
				stepId: `${fixture.task.agentTurnId}:step-1`,
			}
			await fixture.task.ensureCanonicalLifecycleStepStarted(secondStep)
			const secondCall = { ...firstCall, arguments: { path: "second.txt" } }
			fixture.task.apiConversationHistory.push({
				role: "assistant",
				content: [{ type: "tool_use", id: secondCall.id, name: secondCall.name, input: secondCall.arguments }],
			})
			await fixture.task.publishCompletedCanonicalToolCall(secondCall, secondStep)
			expect(fixture.journal.getSnapshot()?.items.find((item) => item.type === "tool_call")).toMatchObject({
				toolCallId: secondCall.id,
				stepId: secondStep.stepId,
				arguments: secondCall.arguments,
			})

			const secondOutput = "second exact output"
			const execute = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
				callbacks.pushToolResult(secondOutput)
			})
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register({
				name: secondCall.name,
				aliases: [],
				schema: {
					type: "function",
					function: {
						name: secondCall.name,
						description: "Read fixture output",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
				capabilities: {
					concurrency: "serial",
					sideEffects: "none",
					controlFlow: false,
					requiresApproval: false,
				},
				execute,
			})
			const scheduler = new ToolScheduler({
				executionHost: {
					taskId: fixture.task.taskId,
					get userMessageContent() {
						return fixture.task.userMessageContent
					},
					say: async () => {},
					recordToolUsage: vi.fn(),
					pushToolResultToUserContent: fixture.task.pushToolResultToUserContent.bind(fixture.task),
					hasToolResultForCall: fixture.task.hasToolResultForCall.bind(fixture.task),
				},
				registry,
				mode: "code",
				validateCall: () => {},
				onEvent: async (event) => {
					if (event.type === "tool_result") {
						await fixture.task.publishCanonicalLifecycleToolResult(
							{ callId: event.callId, status: event.status, content: event.output },
							secondStep,
						)
					}
				},
			})
			const outcome = await scheduler.run(createAgentResponse([{ type: "tool_call", ...secondCall }]))
			expect(outcome).toMatchObject({
				status: "completed",
				results: [{ callId: secondCall.id, status: "success", content: secondOutput }],
			})
			expect(execute).toHaveBeenCalledOnce()
			expect(fixture.journal.getSnapshot()?.items.find((item) => item.type === "tool_result")).toMatchObject({
				toolCallId: secondCall.id,
				status: "success",
				output: secondOutput,
			})
			expect(await fixture.task.flushPendingToolResultsToHistory()).toBe(true)
			const secondResult = { ...firstResult, content: secondOutput }
			expect(fixture.task.apiConversationHistory.at(-1)).toMatchObject({ role: "user", content: [secondResult] })
			expect(fixture.task.apiConversationHistory[1]).toMatchObject({ role: "user", content: [firstResult] })
			expect(fixture.task.apiConversationHistory).toHaveLength(4)
			expect(fixture.task.pushToolResultToUserContent(secondResult)).toBe(false)
			expect(fixture.task.userMessageContent).toEqual([])
			expect(saveHistory).toHaveBeenCalledTimes(3)
		} finally {
			await fixture.close()
		}
	})
})

async function recordJournalMutationResult(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	output: unknown,
	outputTruncated?: boolean,
) {
	const call = { id: "journal-mutation", name: "write_to_file", arguments: { path: "state.txt", content: "updated" } }
	await fixture.task.publishCompletedCanonicalToolCall(call, { stepId: fixture.stepId })
	await fixture.task.enqueueCanonicalLifecycleEvent(
		"tool_effect_started",
		{ toolCallId: call.id },
		fixture.stepId,
		undefined,
		{ durable: true, required: true },
	)
	await fixture.task.enqueueCanonicalLifecycleEvent(
		"tool_result_recorded",
		{
			item: {
				itemId: `${fixture.stepId}:tool-result-${call.id}`,
				stepId: fixture.stepId,
				type: "tool_result",
				toolCallId: call.id,
				status: "success",
				output,
				...(outputTruncated === undefined ? {} : { outputTruncated }),
			},
		},
		fixture.stepId,
		undefined,
		{ durable: true, required: true },
	)
	fixture.task.apiConversationHistory = [
		{ role: "user", content: [{ type: "text", text: "Update state.txt" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.arguments }] },
	]
	return call
}

function prepareLegacyResume(fixture: Awaited<ReturnType<typeof createFixture>>) {
	const initiate = vi.fn(async (_content: Anthropic.Messages.ContentBlockParam[]) => {})
	Object.assign(fixture.task, {
		taskKind: "primary",
		alphaMessages: [],
		backgroundUsageDrainEpoch: 0,
		flushApiConversationHistoryPersistence: async () => {},
		recoverConversationRewind: async () => {},
		reconcileGoalUsageFromHistory: async () => {},
		// Isolate the legacy tail repair, which is still required for histories
		// outside the accepted-call ledger handled by the earlier repair pass.
		recoverIncompleteCanonicalToolCallsForResume: async () => {},
		sayOpeningInput: async () => 2,
		initiateTaskLoop: initiate,
	})
	return initiate
}

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
