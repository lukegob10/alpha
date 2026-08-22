import type { SubagentGroupState } from "@alpha-code/types"

import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../../agent/InternalTaskEnvelope"
import { spawn_agent as spawnAgentSchema } from "../../prompts/tools/native-tools/spawn_agent"
import { spawnAgentTool } from "../SpawnAgentTool"

const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: false,
}

function prepared(objective = "Inspect src") {
	const envelope = buildInternalTaskEnvelope({
		id: "child-1",
		parentTaskId: "parent",
		objective,
		agentKind: "explore",
		parentPolicy: policy,
		requestedPolicy: policy,
		workspaceRoots: ["F:/workspace"],
	})
	const group: SubagentGroupState = {
		groupId: "group-1",
		parentTaskId: "parent",
		status: "pending",
		createdAt: 1,
		agents: [
			{
				taskId: envelope.id,
				nickname: "Maple",
				role: "explore",
				objective,
				status: "pending",
				usage: { durationMs: 0 },
			},
		],
	}
	return { group, envelopes: [envelope] }
}

function handle() {
	return {
		taskId: "child-1",
		runId: "child-1:1",
		parentTaskId: "parent",
		groupId: "group-1",
		path: "/root/maple",
		nickname: "Maple",
		role: "explore" as const,
		createdAt: 1,
		status: "running" as const,
	}
}

describe("SpawnAgentTool", () => {
	it("publishes one flat strict-schema task draft", () => {
		const definition = spawnAgentSchema.function
		expect(definition).toMatchObject({ name: "spawn_agent", strict: true })
		expect(definition.parameters).toMatchObject({
			type: "object",
			required: ["task_name", "fork_turns", "objective", "agent_kind", "write_scope", "expected_output"],
			additionalProperties: false,
		})
		expect(definition.parameters.properties).toMatchObject({
			task_name: { pattern: "^[a-z][a-z0-9_]{0,31}$" },
			fork_turns: { pattern: "^(?:none|all|[1-9][0-9]*)$" },
			agent_kind: { enum: ["explore", "review", "worker"] },
			write_scope: { anyOf: [{ minItems: 1, maxItems: 12 }, { type: "null" }] },
			expected_output: { anyOf: [{ type: "array" }, { type: "null" }] },
		})
		expect(definition.parameters.properties).not.toHaveProperty("tasks")
	})

	it("prepares and approves before returning a nonblocking spawn handle", async () => {
		const batch = { ...prepared(), requiresExplicitApproval: true }
		const requestSignal = new AbortController().signal
		const lifetimeSignal = new AbortController().signal
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			launchPreparedSubagentGroup: vi.fn(async () => handle()),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => requestSignal,
			getTaskLifetimeCancellationSignal: () => lifetimeSignal,
		} as any
		const askApproval = vi.fn(async () => true)
		const pushToolResult = vi.fn()

		await spawnAgentTool.execute(
			{
				task_name: "backend_review",
				fork_turns: "all",
				objective: "Inspect src",
				agent_kind: "explore",
				write_scope: null,
				expected_output: null,
			},
			task,
			{ askApproval, pushToolResult, handleError: vi.fn(), toolCallId: "call-1" } as any,
		)

		expect(provider.prepareSubagentGroup).toHaveBeenCalledWith(
			task,
			[
				{
					task_name: "backend_review",
					fork_turns: "all",
					objective: "Inspect src",
					agent_kind: "explore",
				},
			],
			"call-1",
		)
		expect(askApproval).toHaveBeenCalledAfter(provider.prepareSubagentGroup)
		expect(askApproval).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"tool":"spawnAgent"'),
			undefined,
			true,
		)
		expect(provider.launchPreparedSubagentGroup).toHaveBeenCalledAfter(askApproval)
		expect(provider.launchPreparedSubagentGroup).toHaveBeenCalledWith(task, batch, lifetimeSignal)
		expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalledWith(task, batch, requestSignal)
		expect(pushToolResult).toHaveBeenCalledWith(JSON.stringify({ ...handle(), taskName: "backend_review" }))
	})

	it("rejects an invalid draft before preparation or approval", async () => {
		const provider = {
			prepareSubagentGroup: vi.fn(),
			launchPreparedSubagentGroup: vi.fn(),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const recordToolError = vi.fn()
		const pushToolResult = vi.fn()
		const task = {
			providerRef: { deref: () => provider },
			recordToolError,
			didToolFailInCurrentTurn: false,
		} as any

		await spawnAgentTool.execute(
			{
				task_name: "invalid_worker",
				fork_turns: "none",
				objective: "Edit src",
				agent_kind: "worker",
				write_scope: null,
				expected_output: null,
			},
			task,
			{ askApproval: vi.fn(), pushToolResult, handleError: vi.fn() } as any,
		)

		expect(provider.prepareSubagentGroup).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Error: Worker task 1 requires write_scope")
		expect(recordToolError).toHaveBeenCalledWith("spawn_agent", "Worker task 1 requires write_scope")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("cancels the prepared child when approval is denied", async () => {
		const batch = prepared()
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			launchPreparedSubagentGroup: vi.fn(),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = { providerRef: { deref: () => provider } } as any

		await spawnAgentTool.execute(
			{
				task_name: "denied_explorer",
				fork_turns: "none",
				objective: "Inspect src",
				agent_kind: "explore",
				write_scope: null,
				expected_output: null,
			},
			task,
			{ askApproval: vi.fn(async () => false), pushToolResult: vi.fn(), handleError: vi.fn() } as any,
		)

		expect(provider.launchPreparedSubagentGroup).not.toHaveBeenCalled()
		expect(provider.cancelPreparedSubagentGroup).toHaveBeenCalledWith(
			task,
			batch,
			expect.stringContaining("denied"),
		)
	})

	it("releases a prepared child when launch fails", async () => {
		const batch = prepared()
		const failure = new Error("launcher failed")
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			launchPreparedSubagentGroup: vi.fn(async () => {
				throw failure
			}),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskLifetimeCancellationSignal: () => new AbortController().signal,
		} as any
		const handleError = vi.fn()

		await spawnAgentTool.execute(
			{
				task_name: "failing_explorer",
				fork_turns: "none",
				objective: "Inspect src",
				agent_kind: "explore",
				write_scope: null,
				expected_output: null,
			},
			task,
			{ askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError } as any,
		)

		expect(provider.cancelPreparedSubagentGroup).toHaveBeenCalledWith(
			task,
			batch,
			expect.stringContaining("failed to launch"),
		)
		expect(handleError).toHaveBeenCalledWith("launching a sub-agent", failure)
	})
})
