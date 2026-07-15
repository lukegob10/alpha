import crypto from "crypto"

import type OpenAI from "openai"
import type { ModelInfo } from "@alpha-code/types"

import type { ApiHandlerCreateMessageMetadata } from "../../api"
import type { ApiMessage } from "../task-persistence/apiMessages"
import type { ToolPolicySnapshot } from "./ToolPolicy"
import type { EnvironmentSnapshot } from "../environment/EnvironmentSnapshot"

export type StepContextKind = "agent" | "compaction"

export type DeepReadonly<T> = T extends (...args: any[]) => any
	? T
	: T extends readonly (infer U)[]
		? ReadonlyArray<DeepReadonly<U>>
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T

export interface StepInstructionSource {
	kind: string
	path: string
	digest: string
}

export interface StepTranscriptBoundary {
	startIndex: number
	endIndex: number
	messageCount: number
	digest: string
}

export interface StepCompactionMetadata {
	action: "none" | "summary" | "truncation"
	attempted: boolean
	prevContextTokens?: number
	newContextTokens?: number
	summaryId?: string
	truncationId?: string
	messagesRemoved?: number
	cost?: number
}

export interface StepContextData {
	contextId: string
	kind: StepContextKind
	parentContextId?: string
	createdAt: number
	retryAttempt: number

	task: {
		taskId: string
		cwd: string
		rootTaskId?: string
		parentTaskId?: string
	}

	mode: {
		slug: string
		executionProfileId?: "work" | "plan"
		executionProfileDigest?: string
		profileName?: string
		profileId?: string
		customModeDigest?: string
	}

	provider: {
		apiProvider?: string
		apiProtocol?: string
		modelId: string
		modelInfo: ModelInfo
		options: Record<string, unknown>
	}

	instructions: {
		systemPrompt: string
		environmentDetails?: string
		environmentSnapshot?: EnvironmentSnapshot
		sources: StepInstructionSource[]
	}

	environment: {
		roots: string[]
		capabilities: string[]
	}

	transcript: {
		messages: ApiMessage[]
		boundary: StepTranscriptBoundary
	}

	tools: {
		schemas: OpenAI.Chat.ChatCompletionTool[]
		allowedFunctionNames?: string[]
		toolChoice?: ApiHandlerCreateMessageMetadata["tool_choice"]
		parallelToolCalls: boolean
		digest: string
	}

	policy: ToolPolicySnapshot

	budget: {
		contextWindow: number
		maxOutputTokens?: number
		inputTokens?: number
		estimatedInputTokens?: number
		remainingTokens?: number
		compaction: StepCompactionMetadata
	}

	request: {
		metadata: ApiHandlerCreateMessageMetadata
	}
}

export type StepContext = DeepReadonly<StepContextData>

export interface StepContextMetadata {
	stepContextId: string
	stepContextKind: StepContextKind
	stepContextParentId?: string
	stepContextRetryAttempt: number
	stepContextProvider?: string
	stepContextProtocol?: string
	stepContextModel: string
	stepContextProfile?: string
	stepContextMode: string
	stepContextExecutionProfile?: "work" | "plan"
	stepContextExecutionProfileDigest?: string
	stepContextModelDigest: string
	stepContextPromptDigest: string
	stepContextEnvironmentDigest: string
	stepContextStableEnvironmentDigest: string
	stepContextVolatileEnvironmentDigest: string
	stepContextInstructionDigest: string
	stepContextTranscriptDigest: string
	stepContextTranscriptStart: number
	stepContextTranscriptEnd: number
	stepContextToolSchemaDigest: string
	stepContextPolicyDigest: string
	stepContextContextWindow: number
	stepContextMaxOutputTokens?: number
	stepContextInputTokens?: number
	stepContextEstimatedInputTokens?: number
	stepContextRemainingTokens?: number
	stepContextCompactionAction: StepCompactionMetadata["action"]
	stepContextCompactionAttempted: boolean
	stepContextCompactionId?: string
	stepContextTruncationId?: string
	stepContextMessagesRemoved?: number
}

export interface CreateStepContextInput extends Omit<StepContextData, "contextId" | "createdAt"> {
	contextId?: string
	createdAt?: number
}

const SECRET_KEY_PATTERN =
	/(api.?key|access.?key|secret|password|credential|authorization|private.?key|bearer|(?:api|auth|access|refresh|id)?token$)/i

function sanitizeValue(value: unknown, key?: string): unknown {
	if (key && SECRET_KEY_PATTERN.test(key)) {
		return "[redacted]"
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeValue(item))
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
				entryKey,
				sanitizeValue(entryValue, entryKey),
			]),
		)
	}

	return value
}

function cloneValue<T>(value: T): T {
	return structuredClone(value)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== "object" || seen.has(value as object)) {
		return value
	}

	seen.add(value as object)
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child, seen)
	}

	return Object.freeze(value)
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue)
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stableValue(child)]),
		)
	}

	return value
}

export function digestValue(value: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableValue(value)) ?? "undefined")
		.digest("hex")
}

export function createStepContext(input: CreateStepContextInput): StepContext {
	const sanitized = sanitizeValue(input) as Omit<StepContextData, "contextId" | "createdAt">
	const context: StepContextData = {
		...sanitized,
		contextId: input.contextId ?? crypto.randomUUID(),
		createdAt: input.createdAt ?? Date.now(),
	}

	return deepFreeze(cloneValue(context)) as StepContext
}

export function toStepContextMetadata(context: StepContext, retryAttempt = context.retryAttempt): StepContextMetadata {
	const promptDigest = digestValue(context.instructions.systemPrompt)
	const environmentDigest = digestValue(context.instructions.environmentDetails ?? "")
	const stableEnvironmentDigest = digestValue(context.instructions.environmentSnapshot?.stable ?? {})
	const volatileEnvironmentDigest = digestValue(context.instructions.environmentSnapshot?.volatile ?? {})
	const instructionDigest = digestValue(context.instructions.sources)

	return {
		stepContextId: context.contextId,
		stepContextKind: context.kind,
		stepContextParentId: context.parentContextId,
		stepContextRetryAttempt: retryAttempt,
		stepContextProvider: context.provider.apiProvider,
		stepContextProtocol: context.provider.apiProtocol,
		stepContextModel: context.provider.modelId,
		stepContextProfile: context.mode.profileName,
		stepContextMode: context.mode.slug,
		stepContextExecutionProfile: context.mode.executionProfileId,
		stepContextExecutionProfileDigest: context.mode.executionProfileDigest,
		stepContextModelDigest: digestValue({
			provider: context.provider.apiProvider,
			modelId: context.provider.modelId,
			options: context.provider.options,
		}),
		stepContextPromptDigest: promptDigest,
		stepContextEnvironmentDigest: environmentDigest,
		stepContextStableEnvironmentDigest: stableEnvironmentDigest,
		stepContextVolatileEnvironmentDigest: volatileEnvironmentDigest,
		stepContextInstructionDigest: instructionDigest,
		stepContextTranscriptDigest: context.transcript.boundary.digest,
		stepContextTranscriptStart: context.transcript.boundary.startIndex,
		stepContextTranscriptEnd: context.transcript.boundary.endIndex,
		stepContextToolSchemaDigest: context.tools.digest,
		stepContextPolicyDigest: context.policy.digest,
		stepContextContextWindow: context.budget.contextWindow,
		stepContextMaxOutputTokens: context.budget.maxOutputTokens,
		stepContextInputTokens: context.budget.inputTokens,
		stepContextEstimatedInputTokens: context.budget.estimatedInputTokens,
		stepContextRemainingTokens: context.budget.remainingTokens,
		stepContextCompactionAction: context.budget.compaction.action,
		stepContextCompactionAttempted: context.budget.compaction.attempted,
		stepContextCompactionId: context.budget.compaction.summaryId,
		stepContextTruncationId: context.budget.compaction.truncationId,
		stepContextMessagesRemoved: context.budget.compaction.messagesRemoved,
	}
}
