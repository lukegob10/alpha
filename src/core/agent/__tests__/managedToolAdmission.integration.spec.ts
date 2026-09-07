import type { Anthropic } from "@anthropic-ai/sdk"
import type { ClineAskResponse } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { buildInternalTaskEnvelope } from "../InternalTaskEnvelope"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { ToolScheduler, type ToolSchedulerResult } from "../ToolScheduler"

type AdmissionTool = "delegate_task" | "spawn_agent"

function fixture(name: AdmissionTool) {
	const draft = { objective: "Inspect the workspace", fork_turns: "none", agent_kind: "explore" }
	const policy = {
		read: true,
		execute: false,
		mutate: false,
		delegate: false,
		network: false,
		externalSideEffects: false,
		requireApproval: false,
	}
	const envelope = buildInternalTaskEnvelope({
		id: "child-1",
		parentTaskId: "parent",
		objective: draft.objective,
		agentKind: "explore",
		parentPolicy: policy,
		requestedPolicy: policy,
		workspaceRoots: [process.cwd()],
	})
	const agent = {
		taskId: envelope.id,
		nickname: "Maple",
		role: "explore",
		objective: draft.objective,
		status: "pending",
		usage: { durationMs: 0 },
	}
	const prepared = {
		group: { groupId: "group-1", parentTaskId: "parent", status: "pending", createdAt: 1, agents: [agent] },
		envelopes: [envelope],
	}
	const provider = {
		prepareSubagentGroup: vi.fn(async () => prepared),
		runSubagentGroup: vi.fn(async () => ({ groupId: "group-1", status: "completed", agents: [agent] })),
		launchPreparedSubagentGroup: vi.fn(async () => ({ taskId: "child-1", nickname: "Maple", status: "running" })),
		cancelPreparedSubagentGroup: vi.fn(async () => {}),
	}
	const userMessageContent: Anthropic.ToolResultBlockParam[] = []
	const signal = new AbortController().signal
	const task = {
		taskId: "parent",
		abort: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		providerRef: { deref: vi.fn<() => typeof provider | undefined>(() => provider) },
		getTaskCancellationSignal: () => signal,
		getTaskLifetimeCancellationSignal: () => signal,
		ask: vi.fn(async (): Promise<{ response: ClineAskResponse }> => ({ response: "yesButtonClicked" })),
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		pushToolResultToUserContent(result: Anthropic.ToolResultBlockParam) {
			userMessageContent.push(result)
			return true
		},
	}
	const events: AgentTurnEvent[] = []
	const run = async (args: Record<string, unknown> = draft) => {
		const call = {
			type: "tool_call" as const,
			id: "admission-call",
			name,
			arguments: name === "delegate_task" ? { tasks: [args] } : args,
		}
		return new ToolScheduler({
			task: task as unknown as Task,
			registry: new ToolRegistry(),
			mode: "code",
			preserveAbortedResults: true,
			policy: createToolPolicySnapshot({ visibleTools: [name] }),
			onEvent: (event) => {
				events.push(event)
			},
		}).run({ items: [call], toolCalls: [call], text: "", reasoning: "" })
	}
	const expectReceipt = (result: ToolSchedulerResult, status: ToolSchedulerResult["status"]) => {
		expect(result).toMatchObject({ callId: "admission-call", name, status })
		expect(userMessageContent).toEqual([
			{
				type: "tool_result",
				tool_use_id: "admission-call",
				content: result.content,
				is_error: status !== "success",
			},
		])
		expect(events.filter((event) => event.type === "tool_result")).toEqual([
			expect.objectContaining({ callId: "admission-call", name, status, output: result.content }),
		])
	}
	return { draft, prepared, provider, task, run, expectReceipt }
}

describe.each<AdmissionTool>(["delegate_task", "spawn_agent"])("%s admission receipts", (name) => {
	it.each(["unavailable provider", "invalid draft", "preparation exception"] as const)(
		"commits an error receipt for %s",
		async (failure) => {
			const { draft, provider, task, run, expectReceipt } = fixture(name)
			if (failure === "unavailable provider") task.providerRef.deref.mockReturnValue(undefined)
			if (failure === "preparation exception") {
				provider.prepareSubagentGroup.mockRejectedValue(new Error("Task capacity exhausted"))
			}
			const outcome = await run(failure === "invalid draft" ? { ...draft, objective: "" } : draft)

			expect(task.recordToolUsage).toHaveBeenCalledWith(name)
			expect(task.recordToolError).toHaveBeenCalledWith(name, expect.any(String))
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.ask).not.toHaveBeenCalled()
			expect(provider.runSubagentGroup).not.toHaveBeenCalled()
			expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalled()
			expect(provider.prepareSubagentGroup).toHaveBeenCalledTimes(failure === "preparation exception" ? 1 : 0)
			expect(outcome.results[0].content).toMatch(/^Error: /)
			expectReceipt(outcome.results[0], "error")
		},
	)

	it("preserves cancellation when preparation rejects after the task aborts", async () => {
		const { provider, task, run, expectReceipt } = fixture(name)
		provider.prepareSubagentGroup.mockImplementation(async () => {
			task.abort = true
			throw new Error("Preparation interrupted")
		})
		const outcome = await run()
		expect(outcome.status).toBe("aborted")
		expect(task.recordToolError).toHaveBeenCalledWith(name, "Preparation interrupted")
		expect(task.ask).not.toHaveBeenCalled()
		expect(provider.runSubagentGroup).not.toHaveBeenCalled()
		expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalled()
		expectReceipt(outcome.results[0], "cancelled")
	})

	it("preserves a successful invocation", async () => {
		const { task, run, expectReceipt } = fixture(name)
		const outcome = await run()
		expect(task.ask).toHaveBeenCalledOnce()
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expectReceipt(outcome.results[0], "success")
	})

	it.each([
		["noButtonClicked", "denied"],
		["messageResponse", "cancelled"],
	] as const)("preserves %s approval as %s", async (response, status) => {
		const { provider, task, run, expectReceipt } = fixture(name)
		task.ask.mockResolvedValue({ response })
		const outcome = await run()
		expect(provider.cancelPreparedSubagentGroup).toHaveBeenCalledOnce()
		expect(provider.runSubagentGroup).not.toHaveBeenCalled()
		expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expectReceipt(outcome.results[0], status)
	})

	it.each(["approval", "execution"])("keeps %s exceptions as error receipts", async (stage) => {
		const { provider, task, run, expectReceipt } = fixture(name)
		const error = new Error("Host operation failed")
		if (stage === "approval") task.ask.mockRejectedValue(error)
		else {
			provider.runSubagentGroup.mockRejectedValue(error)
			provider.launchPreparedSubagentGroup.mockRejectedValue(error)
		}
		const outcome = await run()
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expectReceipt(outcome.results[0], "error")
	})
})

it("commits an error receipt when spawn preparation returns more than one child", async () => {
	const { prepared, provider, task, run, expectReceipt } = fixture("spawn_agent")
	provider.prepareSubagentGroup.mockResolvedValue({
		group: { ...prepared.group, agents: [...prepared.group.agents, ...prepared.group.agents] },
		envelopes: [...prepared.envelopes, ...prepared.envelopes],
	})
	const outcome = await run()
	expect(task.ask).not.toHaveBeenCalled()
	expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalled()
	expect(task.didToolFailInCurrentTurn).toBe(true)
	expect(outcome.results[0].content).toBe("Error: spawn_agent must prepare exactly one child")
	expectReceipt(outcome.results[0], "error")
})

it("preserves a delegated group's valid cancelled outcome", async () => {
	const { provider, task, run, expectReceipt } = fixture("delegate_task")
	provider.runSubagentGroup.mockResolvedValue({ groupId: "group-1", status: "cancelled", agents: [] })
	const outcome = await run()
	expect(task.didToolFailInCurrentTurn).toBe(false)
	expect(task.recordToolError).not.toHaveBeenCalled()
	expectReceipt(outcome.results[0], "cancelled")
})
