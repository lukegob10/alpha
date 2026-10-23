import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { Task } from "../../task/Task"
import type { ToolApprovalResponse } from "../../tools/BaseTool"
import { ToolRegistry } from "../../tools/ToolRegistry"
import type { AgentToolCall } from "../AgentResponse"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../lifecycle/AgentLifecycleJournal"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

const lifecycleNames = ["send_message", "followup_task", "interrupt_agent"] as const
type LifecycleName = (typeof lifecycleNames)[number]

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function createFixture(
	name: LifecycleName,
	options: { requiresApproval?: boolean; approved?: boolean; failIntent?: boolean } = {},
) {
	const timeline: string[] = []
	const operation = vi.fn(async () => {
		timeline.push("effect")
		return { taskId: "child", status: "running" }
	})
	const provider = {
		sendMessageToAgent: operation,
		followupAgentTask: operation,
		interruptAgent: operation,
		requiresExplicitAgentFollowupApproval: vi.fn(async () => options.requiresApproval === true),
	}
	const task = {
		taskId: "lifecycle-effects",
		providerRef: new WeakRef(provider),
		say: vi.fn(async () => {}),
		recordToolError: vi.fn(),
	} as unknown as Task
	const host: ToolExecutionHost = {
		taskId: task.taskId,
		taskFacade: task,
		userMessageContent: [],
		ask: vi.fn(async (): Promise<ToolApprovalResponse> => {
			timeline.push("approval")
			return { response: options.approved === false ? "noButtonClicked" : "yesButtonClicked" }
		}),
		say: task.say,
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const call: AgentToolCall = {
		type: "tool_call",
		id: `call-${name}`,
		name,
		arguments: {
			target: "/root/review",
			...(name !== "interrupt_agent" ? { message: "Continue the review." } : {}),
		},
	}
	const onEffectStart = vi.fn(async () => {
		timeline.push("intent")
		if (options.failIntent) throw new Error("Intent persistence failed")
	})
	const registry = new ToolRegistry()
	const scheduler = new ToolScheduler({ executionHost: host, registry, mode: "code", onEffectStart })
	return { call, host, onEffectStart, operation, provider, registry, scheduler, timeline }
}

describe("registered agent lifecycle effect boundaries", () => {
	it.each(lifecycleNames)("records intent before %s without adding an approval", async (name) => {
		const fixture = createFixture(name)
		const outcome = await fixture.scheduler.run([fixture.call])

		expect(outcome.results[0]).toMatchObject({ status: "success" })
		expect(fixture.timeline).toEqual(["intent", "effect"])
		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect(fixture.operation).toHaveBeenCalledOnce()
		expect(fixture.host.ask).not.toHaveBeenCalled()
	})

	it.each(lifecycleNames)("blocks %s when intent persistence fails", async (name) => {
		const fixture = createFixture(name, { failIntent: true })
		const outcome = await fixture.scheduler.run([fixture.call])

		expect(outcome).toMatchObject({ status: "failed", failure: { kind: "effect_fence" } })
		expect(fixture.timeline).toEqual(["intent"])
		expect(fixture.operation).not.toHaveBeenCalled()
		expect(fixture.host.userMessageContent).toHaveLength(1)
	})

	it("records conditional followup intent only after migration approval", async () => {
		const fixture = createFixture("followup_task", { requiresApproval: true })
		const outcome = await fixture.scheduler.run([fixture.call])

		expect(outcome.results[0]).toMatchObject({ status: "success" })
		expect(fixture.timeline).toEqual(["approval", "intent", "effect"])
		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
	})

	it("leaves a denied migration followup unstarted", async () => {
		const fixture = createFixture("followup_task", { requiresApproval: true, approved: false })
		const outcome = await fixture.scheduler.run([fixture.call])

		expect(outcome.results[0]).toMatchObject({ status: "denied" })
		expect(fixture.timeline).toEqual(["approval"])
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
		expect(fixture.operation).not.toHaveBeenCalled()
	})

	it("blocks an approved migration followup when its intent cannot be saved", async () => {
		const fixture = createFixture("followup_task", { requiresApproval: true, failIntent: true })
		const outcome = await fixture.scheduler.run([fixture.call])

		expect(outcome).toMatchObject({ status: "failed", failure: { kind: "effect_fence" } })
		expect(fixture.timeline).toEqual(["approval", "intent"])
		expect(fixture.operation).not.toHaveBeenCalled()
	})

	it("does not start a followup cancelled during its approval eligibility check", async () => {
		const fixture = createFixture("followup_task")
		const controller = new AbortController()
		const checked = deferred<void>()
		const eligibility = deferred<boolean>()
		fixture.provider.requiresExplicitAgentFollowupApproval.mockImplementationOnce(async () => {
			checked.resolve()
			return eligibility.promise
		})
		const scheduler = new ToolScheduler({
			executionHost: fixture.host,
			registry: fixture.registry,
			mode: "code",
			signal: controller.signal,
			onEffectStart: fixture.onEffectStart,
		})
		const running = scheduler.run([fixture.call])
		await checked.promise
		controller.abort()
		eligibility.resolve(false)
		const outcome = await running

		expect(outcome.status).toBe("aborted")
		expect(outcome.results[0]).toMatchObject({ status: "cancelled" })
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
		expect(fixture.operation).not.toHaveBeenCalled()
	})

	it("does not dispatch an approved followup cancelled during its final effect fence", async () => {
		const fixture = createFixture("followup_task", { requiresApproval: true })
		const controller = new AbortController()
		const entered = deferred<void>()
		const release = deferred<void>()
		const scheduler = new ToolScheduler({
			executionHost: fixture.host,
			registry: fixture.registry,
			mode: "code",
			signal: controller.signal,
			preserveAbortedResults: true,
			onEffectStart: fixture.onEffectStart,
			beforeEffect: async () => {
				if (fixture.onEffectStart.mock.calls.length === 0) return
				entered.resolve()
				await release.promise
			},
		})
		const running = scheduler.run([fixture.call])
		await entered.promise
		controller.abort()
		release.resolve()
		const outcome = await running

		expect(outcome.status).toBe("aborted")
		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect(fixture.operation).not.toHaveBeenCalled()
		expect(fixture.host.userMessageContent).toHaveLength(1)
	})

	it.each(lifecycleNames)("recovers an unreceipted %s effect as indeterminate after restart", async (name) => {
		const fixture = createFixture(name)
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-effect-recovery-"))
		const identity = {
			version: 1 as const,
			taskId: fixture.host.taskId,
			runId: "run",
			turnId: "turn",
			occurredAt: 1,
		}
		const stepId = "step"
		const journal = new AgentLifecycleJournal(identity.taskId, storage)
		let restarted: AgentLifecycleJournal | undefined
		try {
			await journal.append({
				...identity,
				eventId: "started",
				type: "turn_started",
				payload: { phase: "working", effectTrackingVersion: 1 },
			})
			await journal.append({
				...identity,
				eventId: "step",
				stepId,
				type: "step_started",
				payload: { phase: "working" },
			})
			await journal.append({
				...identity,
				eventId: "accepted",
				stepId,
				type: "tool_call_accepted",
				payload: {
					item: {
						itemId: "accepted",
						stepId,
						type: "tool_call",
						toolCallId: fixture.call.id,
						name: fixture.call.name,
						arguments: fixture.call.arguments,
						status: "accepted",
					},
				},
			})
			const scheduler = new ToolScheduler({
				executionHost: fixture.host,
				registry: fixture.registry,
				mode: "code",
				onEffectStart: async () => {
					await journal.append(
						{
							...identity,
							eventId: "effect",
							stepId,
							type: "tool_effect_started",
							payload: { toolCallId: fixture.call.id },
						},
						{ durable: true },
					)
				},
			})
			await scheduler.run([fixture.call])
			expect(fixture.operation).toHaveBeenCalledOnce()
			// The child effect committed, but the parent process stopped before its terminal receipt was saved.
			await journal.close()
			restarted = await AgentLifecycleJournal.open(identity.taskId, storage)
			const provider = {
				getAgentLifecycleSnapshot: () => restarted!.getSnapshot(),
				replayAgentLifecycle: async () => restarted!.replay(),
				publishAgentLifecycleEvent: async (event: AgentLifecycleEventInput) => {
					const receipt = await restarted!.append(event)
					return { accepted: true, event: receipt.event, snapshot: receipt.snapshot }
				},
			}
			const recovered = Object.assign(Object.create(Task.prototype), {
				taskId: identity.taskId,
				agentRunId: identity.runId,
				agentTurnId: identity.turnId,
				providerRef: new WeakRef(provider),
				canonicalLifecycleQueue: Promise.resolve(),
				apiConversationHistory: [] as unknown[],
			}) as {
				apiConversationHistory: unknown[]
				recoverIncompleteCanonicalToolCallsForResume(): Promise<void>
				overwriteApiConversationHistory(history: unknown[]): Promise<boolean>
			}
			recovered.overwriteApiConversationHistory = async (history) => {
				recovered.apiConversationHistory = history
				return true
			}
			await recovered.recoverIncompleteCanonicalToolCallsForResume()

			expect(restarted.getSnapshot()?.items.find((item) => item.type === "tool_result")).toMatchObject({
				toolCallId: fixture.call.id,
				status: "indeterminate",
				output: expect.stringContaining("verify the current state before retrying"),
			})
			expect(recovered.apiConversationHistory.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: fixture.call.id, is_error: true }],
			})
		} finally {
			await restarted?.close()
			await journal.close()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
})
