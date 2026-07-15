import { describe, expect, it } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ModelInfo } from "@alpha-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { createStepContext, digestValue, toStepContextMetadata, type StepContext } from "../StepContext"

const modelInfo = { contextWindow: 32_000 } as ModelInfo
const toolSchema = {
	type: "function" as const,
	function: {
		name: "read_file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
}
const transcript: ApiMessage[] = [{ role: "user", content: "Inspect README.md" }]
const metadata: ApiHandlerCreateMessageMetadata = {
	taskId: "task-1",
	mode: "code",
	tools: [toolSchema],
	tool_choice: "auto",
	parallelToolCalls: true,
}

function makeContext(overrides: Partial<{ systemPrompt: string; retryAttempt: number }> = {}): StepContext {
	const systemPrompt = overrides.systemPrompt ?? "system prompt"
	return createStepContext({
		contextId: "context-1",
		kind: "agent",
		retryAttempt: overrides.retryAttempt ?? 0,
		task: { taskId: "task-1", cwd: "F:/workspace" },
		mode: { slug: "code", profileName: "Luna" },
		provider: {
			apiProvider: "openai-native",
			apiProtocol: "openai-responses",
			modelId: "gpt-5.6-luna",
			modelInfo,
			options: { model: "gpt-5.6-luna", openAiApiKey: "do-not-store", temperature: 0 },
		},
		instructions: {
			systemPrompt,
			environmentDetails: "<environment_details>F:/workspace</environment_details>",
			environmentSnapshot: {
				stable: {
					workspaceRoot: "F:/workspace",
					roots: ["F:/workspace"],
					mode: "code",
					modelId: "gpt-5.6-luna",
					capabilities: ["read_file"],
				},
				volatile: {
					renderedDetails: "<environment_details>F:/workspace</environment_details>",
					capturedAt: 1,
				},
				renderedDetails: "<environment_details>F:/workspace</environment_details>",
			},
			sources: [{ kind: "system_prompt", path: "system.ts", digest: digestValue(systemPrompt) }],
		},
		environment: { roots: ["F:/workspace"], capabilities: ["read_file"] },
		transcript: {
			messages: transcript,
			boundary: { startIndex: 0, endIndex: 1, messageCount: 1, digest: digestValue(transcript) },
		},
		tools: {
			schemas: [toolSchema],
			allowedFunctionNames: ["read_file"],
			toolChoice: "auto",
			parallelToolCalls: true,
			digest: digestValue([toolSchema]),
		},
		policy: {
			visibleTools: ["read_file"],
			allowedTools: ["read_file"],
			disabledTools: [],
			approval: { autoApprovalEnabled: false, liveRevalidation: true },
			capabilities: {
				read_file: {
					concurrency: "parallel",
					sideEffects: "none",
					controlFlow: false,
					requiresApproval: true,
				},
			},
			outputLimits: { read_file: 32_000 },
			execution: {
				sandboxMode: "workspace-write",
				workspaceRoots: ["F:/workspace"],
				command: {
					allowedPrefixes: [],
					deniedPrefixes: [],
					userTimeoutMs: 0,
					timeoutAllowlist: [],
				},
				cancellation: "abort-process",
			},
			summary: "Sandbox: workspace-write",
			digest: "policy-digest",
		},
		budget: {
			contextWindow: 32_000,
			maxOutputTokens: 4_000,
			inputTokens: 1_000,
			estimatedInputTokens: 1_000,
			remainingTokens: 27_000,
			compaction: { action: "none", attempted: false },
		},
		request: { metadata },
	})
}

describe("StepContext", () => {
	it("captures an exact immutable request snapshot and redacts credentials", () => {
		const context = makeContext()
		transcript[0] = { role: "user", content: "mutated" }

		expect(context.instructions.systemPrompt).toBe("system prompt")
		expect(context.transcript.messages[0].content).toBe("Inspect README.md")
		expect(context.provider.options.openAiApiKey).toBe("[redacted]")
		expect(context.budget.inputTokens).toBe(1_000)
		expect(Object.isFrozen(context)).toBe(true)
		expect(Object.isFrozen(context.transcript)).toBe(true)
		expect(Object.isFrozen(context.transcript.messages)).toBe(true)
		expect(Object.isFrozen(context.request.metadata)).toBe(true)
		transcript[0] = { role: "user", content: "Inspect README.md" }
	})

	it("produces stable digests and sanitized persisted metadata", () => {
		const context = makeContext()
		const metadata = toStepContextMetadata(context)
		const serialized = JSON.stringify(metadata)

		expect(digestValue({ b: 2, a: 1 })).toBe(digestValue({ a: 1, b: 2 }))
		expect(metadata.stepContextId).toBe("context-1")
		expect(metadata.stepContextPromptDigest).toBe(digestValue("system prompt"))
		expect(metadata.stepContextStableEnvironmentDigest).toBe(
			digestValue(context.instructions.environmentSnapshot?.stable),
		)
		expect(metadata.stepContextVolatileEnvironmentDigest).toBe(
			digestValue(context.instructions.environmentSnapshot?.volatile),
		)
		expect(metadata.stepContextTranscriptDigest).toBe(digestValue(transcript))
		expect(serialized).not.toContain("system prompt")
		expect(serialized).not.toContain("Inspect README.md")
		expect(serialized).not.toContain("do-not-store")
	})

	it("keeps retry identity while allowing a new context for changed inputs", () => {
		const retry = makeContext({ retryAttempt: 1 })
		const changed = makeContext({ systemPrompt: "changed prompt" })

		expect(toStepContextMetadata(retry).stepContextId).toBe("context-1")
		expect(toStepContextMetadata(retry).stepContextRetryAttempt).toBe(1)
		expect(changed.instructions.systemPrompt).not.toBe(retry.instructions.systemPrompt)
	})
})
