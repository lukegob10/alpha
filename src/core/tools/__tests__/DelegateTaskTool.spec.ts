import type { SubagentGroupState } from "@alpha-code/types"

import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../../agent/InternalTaskEnvelope"
import { delegate_task as delegateTaskSchema } from "../../prompts/tools/native-tools/delegate_task"
import { delegateTaskTool } from "../DelegateTaskTool"

const policy: InternalTaskPolicy = {
	read: true,
	execute: false,
	mutate: false,
	delegate: false,
	network: false,
	externalSideEffects: false,
	requireApproval: false,
}

function prepared(objectives = ["Inspect src"]) {
	const groupId = "group-1"
	const envelopes = objectives.map((objective, index) =>
		buildInternalTaskEnvelope({
			id: `child-${index + 1}`,
			parentTaskId: "parent",
			objective,
			agentKind: index === 0 ? "explore" : "review",
			parentPolicy: policy,
			requestedPolicy: policy,
			workspaceRoots: ["F:/workspace"],
		}),
	)
	const group: SubagentGroupState = {
		groupId,
		parentTaskId: "parent",
		status: "pending",
		createdAt: 1,
		agents: envelopes.map((envelope, index) => ({
			taskId: envelope.id,
			nickname: index === 0 ? "Maple" : "Nova",
			role: index === 0 ? "explore" : "review",
			objective: envelope.objective,
			status: "pending",
			usage: { durationMs: 0 },
		})),
	}
	return { group, envelopes }
}

describe("DelegateTaskTool", () => {
	it("publishes one bounded task shape without model-selected authority", () => {
		const parameters = delegateTaskSchema.function.parameters
		expect(parameters).not.toHaveProperty("anyOf")
		expect(parameters).toMatchObject({ required: ["tasks"], additionalProperties: false })
		expect(parameters.properties.tasks).toMatchObject({ minItems: 1, maxItems: 2 })

		const task = parameters.properties.tasks.items
		expect(task).toMatchObject({
			required: ["objective", "agent_kind"],
			additionalProperties: false,
			properties: {
				agent_kind: { enum: ["explore", "review", "worker"] },
				write_scope: {
					anyOf: [{ minItems: 1, maxItems: 12 }, { type: "null" }],
				},
			},
		})
		expect(task.properties).not.toHaveProperty("mutate")
		expect(task.properties).not.toHaveProperty("model")
	})

	it("prepares before approval and returns one structured group result", async () => {
		const batch = prepared()
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			runSubagentGroup: vi.fn(async () => ({
				groupId: batch.group.groupId,
				status: "completed",
				agents: [{ ...batch.group.agents[0], status: "completed", summary: "Found it" }],
			})),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => new AbortController().signal,
		} as any
		const askApproval = vi.fn(async () => true)
		const pushToolResult = vi.fn()

		await delegateTaskTool.execute({ tasks: [{ objective: "Inspect src", agent_kind: "explore" }] }, task, {
			askApproval,
			pushToolResult,
			handleError: vi.fn(),
			toolCallId: "call-1",
		} as any)

		expect(provider.prepareSubagentGroup).toHaveBeenCalledWith(task, expect.any(Array), "call-1")
		expect(askApproval).toHaveBeenCalledAfter(provider.prepareSubagentGroup)
		expect(provider.runSubagentGroup).toHaveBeenCalledWith(task, batch, expect.any(AbortSignal))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"groupId":"group-1"'))
	})

	it("rejects invalid or over-capacity drafts before approval", async () => {
		const provider = {
			prepareSubagentGroup: vi.fn(async () => {
				throw new Error("Not enough task capacity")
			}),
			runSubagentGroup: vi.fn(),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const askApproval = vi.fn()
		const pushToolResult = vi.fn()
		const recordToolError = vi.fn()
		const task = {
			providerRef: { deref: () => provider },
			recordToolError,
			didToolFailInCurrentTurn: false,
		} as any

		await delegateTaskTool.execute({ tasks: [{ objective: "Inspect src", agent_kind: "explore" }] }, task, {
			askApproval,
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		expect(askApproval).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Error: Not enough task capacity")
		expect(recordToolError).toHaveBeenCalledWith("delegate_task", "Not enough task capacity")
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("narrows nullable and provider-filled branch fields before preparation", async () => {
		const batch = prepared()
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			runSubagentGroup: vi.fn(async () => ({ groupId: "group-1", status: "completed", agents: [] })),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => new AbortController().signal,
		} as any

		await delegateTaskTool.execute(
			{
				tasks: [
					{
						objective: "Inspect src",
						agent_kind: "explore",
						write_scope: ["docs"],
						expected_output: null,
					},
				] as any,
			},
			task,
			{ askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError: vi.fn() } as any,
		)

		expect(provider.prepareSubagentGroup).toHaveBeenCalledWith(
			task,
			[{ objective: "Inspect src", agent_kind: "explore" }],
			undefined,
		)
	})

	it("cancels the prepared group when approval is denied", async () => {
		const batch = prepared()
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			runSubagentGroup: vi.fn(),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = { providerRef: { deref: () => provider } } as any

		await delegateTaskTool.execute({ tasks: [{ objective: "Inspect src", agent_kind: "explore" }] }, task, {
			askApproval: vi.fn(async () => false),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		} as any)

		expect(provider.runSubagentGroup).not.toHaveBeenCalled()
		expect(provider.cancelPreparedSubagentGroup).toHaveBeenCalledWith(
			task,
			batch,
			expect.stringContaining("denied"),
		)
	})

	it("passes two independent objectives to the bounded group runner in order", async () => {
		const batch = prepared(["first", "second"])
		const provider = {
			prepareSubagentGroup: vi.fn(async () => batch),
			runSubagentGroup: vi.fn(async () => ({ groupId: "group-1", status: "completed", agents: [] })),
			cancelPreparedSubagentGroup: vi.fn(),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => new AbortController().signal,
		} as any

		await delegateTaskTool.execute(
			{
				tasks: [
					{ objective: "first", agent_kind: "explore" },
					{ objective: "second", agent_kind: "review" },
				],
			},
			task,
			{ askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError: vi.fn() } as any,
		)

		const preparedDrafts = (provider.prepareSubagentGroup as any).mock.calls[0][1] as Array<{
			objective: string
		}>
		expect(preparedDrafts.map((draft) => draft.objective)).toEqual(["first", "second"])
	})
})
