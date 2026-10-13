import type { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import { convertToOpenAiMessages } from "../../../api/transform/openai-format"
import { executeCommandTool } from "../../tools/ExecuteCommandTool"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { createAgentResponse } from "../AgentResponse"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler, type ToolExecutionHost, type ToolExecutionMode } from "../ToolScheduler"

const CALL_ID = "approval-mode-1"
const COMMAND = "rm --help"
const DENIAL_MESSAGE = "This command is denied by the current execution policy."

function createFixture(executionMode: ToolExecutionMode = "serial", deferResultCommit = false, command = COMMAND) {
	const cwd = process.cwd()
	const surface = createTaskToolSurface({
		mode: "code",
		cwd,
		taskKind: "primary",
		approvalMode: "bypass",
		autoApprovalEnabled: true,
		execution: {
			workspaceRoots: [cwd],
			outsideWorkspace: "approval",
			command: { allowedPrefixes: ["*", command], deniedPrefixes: [command === "git status" ? "git" : "rm"] },
		},
	})
	const userMessageContent: ToolExecutionHost["userMessageContent"] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		workspacePath: cwd,
		abort: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		commandExecutionEvidence: new Map<string, CommandExecutionEvidence>(),
		toolRepetitionDetector: new ToolRepetitionDetector(3),
		userMessageContent,
		providerRef: { deref: () => undefined },
	}) as Task
	const observe = vi.fn(task.recordToolCallForStopping.bind(task))
	const beginCommandExecution = vi.spyOn(task, "beginCommandExecution")
	const admitCommandExecution = vi.spyOn(task, "admitCommandExecution")
	const executionHost: ToolExecutionHost = {
		taskId: "native-command-denial-contract",
		taskKind: "primary",
		cwd,
		abort: false,
		taskFacade: task,
		userMessageContent,
		userMessageContentReady: false,
		ask: vi.fn<NonNullable<ToolExecutionHost["ask"]>>().mockResolvedValue({ response: "noButtonClicked" }),
		askApproval: vi
			.fn<NonNullable<ToolExecutionHost["askApproval"]>>()
			.mockResolvedValue({ response: "noButtonClicked" }),
		requestToolApproval: vi
			.fn<NonNullable<ToolExecutionHost["requestToolApproval"]>>()
			.mockResolvedValue(undefined),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		recordToolCallForStopping: observe,
		pushToolResultToUserContent: vi.fn((result: Anthropic.ToolResultBlockParam) => {
			userMessageContent.push(result)
			return true
		}),
	}
	const host = executionHost
	// A broken policy must fail this test without launching even the harmless fixture command.
	const execute = vi.spyOn(executeCommandTool, "execute").mockRejectedValue(new Error("Unexpected command execution"))
	const beforeEffect = vi.fn()
	const onEffectStart = vi.fn()
	const events: AgentTurnEvent[] = []
	const scheduler = new ToolScheduler({
		executionHost: host,
		registry: surface.registry,
		policy: surface.policy,
		mode: "code",
		executionMode,
		deferResultCommit,
		requirePreparedCommandRead: deferResultCommit,
		beforeEffect,
		onEffectStart,
		onEvent: (event) => {
			events.push(event)
		},
	})
	const response = createAgentResponse([
		{ type: "tool_call", id: CALL_ID, name: "exec_command", arguments: { cmd: command } },
	])
	return {
		surface,
		task,
		host,
		observe,
		execute,
		beginCommandExecution,
		admitCommandExecution,
		beforeEffect,
		onEffectStart,
		events,
		scheduler,
		response,
	}
}

function expectDeniedAttempt(task: Task, command = COMMAND) {
	const evidence = task.getCommandExecutionEvidence()
	expect(evidence).toHaveLength(1)
	expect(evidence[0]).toMatchObject({ toolCallId: CALL_ID, command, status: "denied" })
	for (const property of [
		"exitCode",
		"signalName",
		"verificationChangeSetIds",
		"verificationVersions",
		"acceptanceChecks",
	]) {
		expect(evidence[0]).not.toHaveProperty(property)
	}
	expect(task.hasActiveCommandExecutions()).toBe(false)
}

afterEach(() => vi.restoreAllMocks())

describe("native command policy denial receipts", () => {
	it.each(["serial", "selective-parallel"] as const)(
		"publishes one denied result for a callable Full Access command without starting it (%s)",
		async (executionMode) => {
			const fixture = createFixture(executionMode)
			expect(fixture.surface.policy.approval.mode).toBe("bypass")
			expect(fixture.surface.policy.execution.outsideWorkspace).toBe("approval")
			expect(fixture.surface.isCallable("exec_command")).toBe(true)
			expect(fixture.surface.resolve("exec_command")).toBeDefined()
			expect(
				fixture.surface.schemas.some(
					(schema) => schema.type === "function" && schema.function.name === "exec_command",
				),
			).toBe(true)

			const outcome = await fixture.scheduler.run(fixture.response)

			expect(outcome).toMatchObject({
				status: "completed",
				batchSize: 1,
				completedToolResultCount: 1,
				approvalRequestCount: 0,
				results: [
					{
						callId: CALL_ID,
						name: "exec_command",
						status: "denied",
						failure: {
							reason: "policy_denied",
							affectedScope: { kind: "capability" },
							effectsStarted: "no",
							outcome: "known",
							recovery: { kind: "user-action" },
						},
					},
				],
			})
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0].content).toBe(JSON.stringify({ status: "denied", message: DENIAL_MESSAGE }))
			expect(outcome.results[0].commandResult).toBeUndefined()
			expect(outcome.results[0].exitCode).toBeUndefined()
			expect(fixture.host.userMessageContent).toEqual([
				{ type: "tool_result", tool_use_id: CALL_ID, content: outcome.results[0].content, is_error: true },
			])
			expect(fixture.host.userMessageContentReady).toBe(true)
			expect(fixture.host.pushToolResultToUserContent).toHaveBeenCalledOnce()
			expect(fixture.events.filter((event) => event.type === "tool_result")).toMatchObject([
				{ type: "tool_result", callId: CALL_ID, name: "exec_command", status: "denied" },
			])
			expect(fixture.events.filter((event) => event.type === "tool_result")).toHaveLength(1)
			expect(fixture.events.some((event) => event.type === "approval_request")).toBe(false)
			expect(fixture.observe).toHaveBeenCalledOnce()
			expectDeniedAttempt(fixture.task)
			expect(fixture.host.ask).not.toHaveBeenCalled()
			expect(fixture.host.askApproval).not.toHaveBeenCalled()
			expect(fixture.host.requestToolApproval).not.toHaveBeenCalled()
			expect(fixture.execute).not.toHaveBeenCalled()
			expect(fixture.beginCommandExecution).not.toHaveBeenCalled()
			expect(fixture.admitCommandExecution).not.toHaveBeenCalled()
			expect(fixture.beforeEffect).not.toHaveBeenCalled()
			expect(fixture.onEffectStart).not.toHaveBeenCalled()
		},
	)

	it("retains a denied call/result pair through deferred commit and provider-history reload exactly once", async () => {
		const command = "git status"
		const fixture = createFixture("selective-parallel", true, command)
		const outcome = await fixture.scheduler.run(fixture.response)

		expect(outcome.results).toMatchObject([
			{ callId: CALL_ID, status: "denied", failure: { reason: "policy_denied", effectsStarted: "no" } },
		])
		expect(outcome.results).toHaveLength(1)
		expect(fixture.host.userMessageContent).toEqual([])
		expect(fixture.host.userMessageContentReady).toBe(false)
		expect(fixture.events.filter((event) => event.type === "tool_result")).toEqual([])
		expect(fixture.task.getCommandExecutionEvidence()).toEqual([])
		expect(fixture.observe).not.toHaveBeenCalled()

		await fixture.scheduler.commitDeferredResults()
		await fixture.scheduler.commitDeferredResults()

		expect(fixture.host.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(fixture.host.userMessageContent).toEqual([
			{ type: "tool_result", tool_use_id: CALL_ID, content: outcome.results[0].content, is_error: true },
		])
		expect(fixture.host.userMessageContentReady).toBe(true)
		expect(fixture.events.filter((event) => event.type === "tool_result")).toMatchObject([
			{ callId: CALL_ID, name: "exec_command", status: "denied", output: outcome.results[0].content },
		])
		expect(fixture.events.filter((event) => event.type === "tool_result")).toHaveLength(1)
		expect(fixture.events.filter((event) => event.type === "tool_batch_finished")).toHaveLength(1)
		expect(fixture.observe).toHaveBeenCalledOnce()
		expectDeniedAttempt(fixture.task, command)
		expect(fixture.execute).not.toHaveBeenCalled()
		expect(fixture.beginCommandExecution).not.toHaveBeenCalled()
		expect(fixture.admitCommandExecution).not.toHaveBeenCalled()
		expect(fixture.host.ask).not.toHaveBeenCalled()
		expect(fixture.host.requestToolApproval).not.toHaveBeenCalled()
		expect(fixture.onEffectStart).not.toHaveBeenCalled()

		const history: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: CALL_ID, name: "exec_command", input: { cmd: command } }],
			},
			{ role: "user", content: fixture.host.userMessageContent },
		]
		const reloadedHistory: Anthropic.Messages.MessageParam[] = JSON.parse(JSON.stringify(history))
		expect(reloadedHistory).toEqual(history)
		const providerMessages = convertToOpenAiMessages(reloadedHistory)
		expect(providerMessages).toHaveLength(2)
		expect(providerMessages).toMatchObject([
			{
				role: "assistant",
				tool_calls: [
					{
						id: CALL_ID,
						type: "function",
						function: { name: "exec_command", arguments: JSON.stringify({ cmd: command }) },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: CALL_ID,
				content: JSON.stringify({ status: "denied", message: DENIAL_MESSAGE }),
			},
		])
	})
})
