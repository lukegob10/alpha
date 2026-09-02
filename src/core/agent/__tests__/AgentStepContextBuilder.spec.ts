import { describe, expect, it, vi } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ModelInfo } from "@alpha-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createToolPolicySnapshot } from "../ToolPolicy"
import {
	AgentStepContextBuilder,
	buildAgentStepContext,
	deriveChildAgentStep,
	deriveCompactionAgentStep,
	deriveRetryAgentStep,
	type AgentStepSnapshot,
} from "../AgentStepContextBuilder"
import { digestValue, type CreateStepContextInput } from "../StepContext"

const modelInfo = { contextWindow: 16_000 } as ModelInfo
const toolSchema = {
	type: "function" as const,
	function: { name: "read_file", parameters: { type: "object" } },
}
const metadata: ApiHandlerCreateMessageMetadata = {
	taskId: "task-1",
	mode: "code",
	tools: [toolSchema],
	tool_choice: "auto",
	parallelToolCalls: true,
}

function capturedInput(): CreateStepContextInput {
	const messages: ApiMessage[] = [{ role: "user", content: "Inspect the workspace" }]
	const policy = createToolPolicySnapshot({
		visibleTools: ["read_file"],
		allowedTools: ["read_file"],
		capabilities: {
			read_file: { concurrency: "parallel", sideEffects: "none", controlFlow: false, requiresApproval: false },
		},
		outputLimits: { read_file: 4_000 },
		execution: { workspaceRoots: ["F:/workspace"] },
		digest: "policy-digest",
	})
	return {
		contextId: "root-context",
		createdAt: 10,
		kind: "agent",
		retryAttempt: 0,
		task: { taskId: "task-1", cwd: "F:/workspace", rootTaskId: "task-1" },
		mode: { slug: "code", profileName: "Work" },
		provider: {
			apiProvider: "fake-ai",
			apiProtocol: "chat",
			modelId: "fake-model",
			modelInfo,
			options: { apiKey: "top-secret", nested: { accessToken: "also-secret", temperature: 0 } },
		},
		instructions: {
			systemPrompt: "system prompt",
			environmentDetails: "<environment_details>workspace</environment_details>",
			environmentSnapshot: {
				stable: {
					workspaceRoot: "F:/workspace",
					roots: ["F:/workspace"],
					capabilities: ["read_file"],
				},
				volatile: { renderedDetails: "workspace", capturedAt: 1 },
				renderedDetails: "workspace",
			},
			sources: [{ kind: "system", path: "system.ts", digest: digestValue("system prompt") }],
		},
		environment: { roots: ["F:/workspace"], capabilities: ["read_file"] },
		transcript: {
			messages,
			boundary: { startIndex: 0, endIndex: 1, messageCount: 1, digest: digestValue(messages) },
		},
		tools: {
			schemas: [toolSchema],
			allowedFunctionNames: ["read_file"],
			toolChoice: "auto",
			parallelToolCalls: true,
			digest: digestValue([toolSchema]),
		},
		policy,
		budget: {
			contextWindow: 16_000,
			maxOutputTokens: 2_000,
			compaction: { action: "none", attempted: false },
		},
		request: { metadata },
	}
}

describe("AgentStepContextBuilder", () => {
	it("deep-freezes and redacts captured data without mutating inputs", () => {
		const input = capturedInput()
		const originalMessages = input.transcript.messages
		const handler = { createMessage: vi.fn() }
		const executable = vi.fn()
		const step = buildAgentStepContext(input, { handler, executables: { read_file: executable } })

		input.provider.options.nested = { accessToken: "changed-after-capture" }
		input.transcript.messages.push({ role: "user", content: "later" })

		expect(step.context.provider.options).toMatchObject({
			apiKey: "[redacted]",
			nested: { accessToken: "[redacted]", temperature: 0 },
		})
		expect(step.context.transcript.messages).toHaveLength(1)
		expect(originalMessages).toHaveLength(2)
		expect(Object.isFrozen(step.context)).toBe(true)
		expect(Object.isFrozen(step.context.provider.options)).toBe(true)
		expect(Object.isFrozen(step.context.transcript.messages)).toBe(true)
		expect(Object.isFrozen(step.context.policy.capabilities)).toBe(true)
		expect(step.runtime.getHandler()).toBe(handler)
		expect(step.runtime.getExecutable("read_file")).toBe(executable)
		expect(JSON.stringify(step)).not.toContain("top-secret")
	})

	it("keeps retry identity and runtime references while changing only the attempt", () => {
		const handler = { id: "handler" }
		const builder = new AgentStepContextBuilder({ handler })
		const first = builder.build(capturedInput())
		const retry = builder.retry(first)
		const retryAgain = deriveRetryAgentStep(retry, { retryAttempt: 3 })

		expect(retry.context.contextId).toBe(first.context.contextId)
		expect(retry.context.createdAt).toBe(first.context.createdAt)
		expect(retry.context.retryAttempt).toBe(1)
		expect(retryAgain.context.retryAttempt).toBe(3)
		expect(retry.metadata.stepContextDigest).toBe(first.metadata.stepContextDigest)
		expect(retry.runtime.getHandler()).toBe(handler)
		expect(retry.context.instructions).toEqual(first.context.instructions)
	})

	it("derives deterministic child contexts with explicit ancestry", () => {
		const parent = buildAgentStepContext(capturedInput())
		const options = {
			childTaskId: "child-1",
			mode: { slug: "review", profileName: "Review" },
			transcript: {
				messages: [{ role: "user" as const, content: "Review only" }],
				boundary: { startIndex: 0, endIndex: 1, messageCount: 1, digest: digestValue("Review only") },
			},
		}
		const first = deriveChildAgentStep(parent, options)
		const second = deriveChildAgentStep(parent, options)

		expect(first.context.contextId).toBe(second.context.contextId)
		expect(first.context.contextId).not.toBe(parent.context.contextId)
		expect(first.context.parentContextId).toBe(parent.context.contextId)
		expect(first.context.task).toMatchObject({ taskId: "child-1", parentTaskId: "task-1" })
		expect(first.context.mode.slug).toBe("review")
		expect(first.context.request.metadata).toMatchObject({ taskId: "child-1", mode: "review" })
		expect(first.context.retryAttempt).toBe(0)
		expect(first.runtime.contextId).toBe(first.context.contextId)
	})

	it("creates a linked compaction context with deterministic metadata", () => {
		const parent = buildAgentStepContext(capturedInput())
		const first = deriveCompactionAgentStep(parent, {
			compaction: { action: "summary", attempted: true, summaryId: "summary-1", messagesRemoved: 4 },
		})
		const second = deriveCompactionAgentStep(parent, {
			compaction: { action: "summary", attempted: true, summaryId: "summary-1", messagesRemoved: 4 },
		})

		expect(first.context.kind).toBe("compaction")
		expect(first.context.parentContextId).toBe(parent.context.contextId)
		expect(first.context.task.taskId).toBe(parent.context.task.taskId)
		expect(first.context.budget.compaction).toMatchObject({
			action: "summary",
			attempted: true,
			summaryId: "summary-1",
			messagesRemoved: 4,
		})
		expect(first.context.contextId).toBe(second.context.contextId)
		expect(first.metadata.stepContextCompactionId).toBe("summary-1")
	})

	it("supports a separately captured context object and runtime", () => {
		const executable = vi.fn()
		const step: AgentStepSnapshot = new AgentStepContextBuilder().build({
			context: capturedInput(),
			runtime: { handler: "live-handler", executables: new Map([["read_file", executable]]) },
		})

		expect(step.runtime.getHandler()).toBe("live-handler")
		expect(step.runtime.getExecutable("read_file")).toBe(executable)
	})
})
