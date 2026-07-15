import { delegateTaskTool } from "../DelegateTaskTool"
import { buildInternalTaskEnvelope, type InternalTaskPolicy } from "../../agent/InternalTaskEnvelope"
import { delegate_task as delegateTaskSchema } from "../../prompts/tools/native-tools/delegate_task"

const policy: InternalTaskPolicy = {
	read: true,
	execute: true,
	mutate: true,
	delegate: true,
	network: false,
	externalSideEffects: false,
	requireApproval: true,
}

function envelope() {
	return buildInternalTaskEnvelope({
		id: "child-envelope",
		parentTaskId: "parent",
		objective: "Inspect src",
		parentPolicy: policy,
		requestedPolicy: { delegate: false },
		workspaceRoots: ["F:/workspace"],
	})
}

describe("DelegateTaskTool", () => {
	it("uses a Responses-compatible schema without conditional object branches", () => {
		const parameters = delegateTaskSchema.function.parameters
		expect(parameters).not.toHaveProperty("anyOf")
		expect(parameters).toMatchObject({
			required: ["tasks"],
			additionalProperties: false,
			properties: {
				tasks: {
					minItems: 1,
					maxItems: 2,
					items: { required: ["objective"], additionalProperties: false },
				},
			},
		})
	})
	it("builds an untrusted draft at the host boundary and records parent verification", async () => {
		const built = envelope()
		const provider = {
			buildInternalTaskEnvelopeForTask: vi.fn(() => built),
			runInternalTaskEnvelope: vi.fn(async () => ({
				taskId: built.id,
				status: "completed",
				changedFiles: ["src/a.ts"],
				requiresParentVerification: true,
			})),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => new AbortController().signal,
			requireChildVerification: vi.fn(),
		} as any
		const pushToolResult = vi.fn()
		await delegateTaskTool.execute({ envelope: { objective: "Inspect src" } }, task, {
			askApproval: vi.fn(async () => true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)
		expect(provider.buildInternalTaskEnvelopeForTask).toHaveBeenCalled()
		expect(provider.runInternalTaskEnvelope).toHaveBeenCalledWith(built, expect.any(AbortSignal))
		expect(task.requireChildVerification).toHaveBeenCalledWith(built.id)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"status":"completed"'))
	})

	it("rejects invalid drafts before approval", async () => {
		const task = {
			providerRef: {
				deref: () => ({
					buildInternalTaskEnvelopeForTask: () => {
						throw new Error("objective is required")
					},
					runInternalTaskEnvelope: vi.fn(),
				}),
			},
		} as any
		const askApproval = vi.fn()
		const pushToolResult = vi.fn()
		await delegateTaskTool.execute({ envelope: {} }, task, {
			askApproval,
			pushToolResult,
			handleError: vi.fn(),
		} as any)
		expect(askApproval).not.toHaveBeenCalled()
		expect(pushToolResult).toHaveBeenCalledWith("Error: objective is required")
	})

	it("runs two independent drafts through the bounded batch runner", async () => {
		const first = envelope()
		const second = { ...envelope(), id: "child-envelope-2" }
		const provider = {
			buildInternalTaskEnvelopeForTask: vi.fn((_task, draft) => (draft.objective === "first" ? first : second)),
			runInternalTaskEnvelope: vi.fn(),
			runInternalTaskEnvelopes: vi.fn(async () =>
				[first, second].map((item) => ({
					taskId: item.id,
					status: "completed",
					changedFiles: [],
					requiresParentVerification: false,
				})),
			),
		}
		const task = {
			providerRef: { deref: () => provider },
			getTaskCancellationSignal: () => new AbortController().signal,
			requireChildVerification: vi.fn(),
		} as any
		const pushToolResult = vi.fn()
		await delegateTaskTool.execute({ tasks: [{ objective: "first" }, { objective: "second" }] }, task, {
			askApproval: vi.fn(async () => true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)
		expect(provider.runInternalTaskEnvelopes).toHaveBeenCalledWith([first, second], expect.any(AbortSignal))
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"taskId":"child-envelope-2"'))
	})
})
