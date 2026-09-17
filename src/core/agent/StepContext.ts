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
	/** Digest of the captured context, excluding the creation timestamp and retry counter. */
	stepContextDigest?: string
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

/** Stable content digests for the model-visible parts of one step. */
export interface StepContextDigests {
	/** Digest of the whole sanitized context, excluding `createdAt` and `retryAttempt`. */
	context: string
	model: string
	prompt: string
	environment: string
	stableEnvironment: string
	volatileEnvironment: string
	instructions: string
	transcript: string
	tools: string
	policy: string
}

/** Backwards-friendly name for callers that describe this as a digest set. */
export type StepContextDigestSet = StepContextDigests

export interface RetryStepContextOptions {
	/** Explicit retry number. Omitted values advance the current retry by one. */
	retryAttempt?: number
}

/**
 * Partial fields accepted when deriving a child context. The parent snapshot is
 * used as the base; only the explicitly supplied fields are replaced.
 */
export interface ChildStepContextOptions {
	/** Stable child task identity. `taskId` is accepted as a concise alias. */
	childTaskId?: string
	taskId?: string
	contextId?: string
	kind?: StepContextKind
	createdAt?: number
	retryAttempt?: number
	task?: Partial<StepContext["task"]>
	mode?: Partial<StepContext["mode"]>
	provider?: Partial<StepContext["provider"]>
	instructions?: Partial<StepContext["instructions"]>
	environment?: Partial<StepContext["environment"]>
	transcript?: Partial<StepContext["transcript"]>
	tools?: Partial<StepContext["tools"]>
	policy?: StepContext["policy"]
	budget?: Partial<StepContext["budget"]> & {
		compaction?: Partial<StepCompactionMetadata>
	}
	request?: Partial<StepContext["request"]>
}

export interface CompactionStepContextOptions extends Omit<ChildStepContextOptions, "kind"> {
	/** Compaction kind is always forced to `compaction`, even when omitted. */
	action?: StepCompactionMetadata["action"]
	compaction?: Partial<StepCompactionMetadata>
}

const SECRET_KEY_PATTERN =
	/(api.?key|access.?key|secret|password|credential|authorization|private.?key|signing.?key|bearer|cookie|(?:api|auth|access|refresh|id)?token$)/i

/**
 * Return a JSON-shaped copy with credential-like fields redacted. This is
 * deliberately performed before cloning and digesting so captured metadata
 * cannot retain a live provider option or accidentally serialize a secret.
 */
export function sanitizeValue(value: unknown, key?: string): unknown {
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

/** Deep-freeze a JSON-shaped value while tolerating repeated object references. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
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

/**
 * Compute the stable digests used by telemetry and request metadata. The
 * input is already an immutable context, but sanitizing the projection again
 * keeps this helper safe for contexts assembled by older callers.
 */
export function getStepContextDigests(context: StepContext): StepContextDigests {
	const prompt = digestValue(context.instructions.systemPrompt)
	const environment = digestValue(context.instructions.environmentDetails ?? "")
	const stableEnvironment = digestValue(context.instructions.environmentSnapshot?.stable ?? {})
	const volatileEnvironment = digestValue(context.instructions.environmentSnapshot?.volatile ?? {})
	const instructions = digestValue(context.instructions.sources)
	const transcript = context.transcript.boundary.digest || digestValue(context.transcript.messages)
	const tools =
		context.tools.digest ||
		digestValue({
			schemas: context.tools.schemas,
			allowedFunctionNames: context.tools.allowedFunctionNames,
			toolChoice: context.tools.toolChoice,
			parallelToolCalls: context.tools.parallelToolCalls,
		})
	const policy = context.policy.digest || digestValue(context.policy)
	const model = digestValue({
		provider: context.provider.apiProvider,
		modelId: context.provider.modelId,
		options: context.provider.options,
	})

	const contextProjection = sanitizeValue(context) as Record<string, unknown>
	delete contextProjection.createdAt
	delete contextProjection.retryAttempt

	return Object.freeze({
		context: digestValue(contextProjection),
		model,
		prompt,
		environment,
		stableEnvironment,
		volatileEnvironment,
		instructions,
		transcript,
		tools,
		policy,
	})
}

/** Alias used by callers that prefer a verb describing the operation. */
export const computeStepContextDigests = getStepContextDigests

export function createStepContext(input: CreateStepContextInput): StepContext {
	const sanitized = sanitizeValue(input) as Omit<StepContextData, "contextId" | "createdAt">
	const context: StepContextData = {
		...sanitized,
		contextId: input.contextId ?? crypto.randomUUID(),
		createdAt: input.createdAt ?? Date.now(),
	}

	return deepFreeze(cloneValue(context)) as StepContext
}

/**
 * Reuse the exact captured context for a retry. Only the retry counter changes;
 * identity, creation time, prompts, tools, policy, and request metadata remain
 * byte-for-byte equivalent after canonical serialization.
 */
export function deriveRetryStepContext(
	context: StepContext,
	options: RetryStepContextOptions | number = {},
): StepContext {
	const retryAttempt = typeof options === "number" ? options : (options.retryAttempt ?? context.retryAttempt + 1)
	if (!Number.isInteger(retryAttempt) || retryAttempt < 0) {
		throw new Error("Step context retry attempt must be a non-negative integer")
	}
	if (retryAttempt < context.retryAttempt) {
		throw new Error("Step context retry attempt cannot move backwards")
	}

	return createStepContext({
		...(context as unknown as CreateStepContextInput),
		contextId: context.contextId,
		createdAt: context.createdAt,
		retryAttempt,
	})
}

function deriveChildContextId(parent: StepContext, childTaskId: string, options: ChildStepContextOptions): string {
	const kind = options.kind ?? "agent"
	const identity = sanitizeValue({
		parentContextId: parent.contextId,
		childTaskId,
		kind,
		task: options.task,
		mode: options.mode,
		provider: options.provider,
		instructions: options.instructions,
		environment: options.environment,
		transcript: options.transcript,
		tools: options.tools,
		policy: options.policy,
		budget: options.budget,
		request: options.request,
	})
	return `${kind === "compaction" ? "compaction" : "child"}-${digestValue(identity).slice(0, 32)}`
}

/**
 * Derive a child context from an already-captured parent. Child identity is
 * explicit when `contextId` is supplied and otherwise deterministic from the
 * parent, child task, kind, and captured overrides.
 */
export function deriveChildStepContext(context: StepContext, options: ChildStepContextOptions): StepContext {
	const childTaskId = options.childTaskId ?? options.taskId ?? options.task?.taskId
	if (!childTaskId?.trim()) {
		throw new Error("Child step context requires a child task ID")
	}

	const task = {
		...context.task,
		...(options.task ?? {}),
		taskId: childTaskId,
		parentTaskId:
			options.task?.parentTaskId ??
			(childTaskId === context.task.taskId ? context.task.parentTaskId : context.task.taskId),
	}
	const mode = { ...context.mode, ...(options.mode ?? {}) }
	const provider = { ...context.provider, ...(options.provider ?? {}) }
	const instructions = { ...context.instructions, ...(options.instructions ?? {}) }
	const environment = { ...context.environment, ...(options.environment ?? {}) }
	const transcript = { ...context.transcript, ...(options.transcript ?? {}) }
	const tools = { ...context.tools, ...(options.tools ?? {}) }
	const budget = {
		...context.budget,
		...(options.budget ?? {}),
		compaction: {
			...context.budget.compaction,
			...(options.budget?.compaction ?? {}),
		},
	}
	const request = {
		...context.request,
		...(options.request ?? {}),
		metadata: {
			...context.request.metadata,
			...(options.request?.metadata ?? {}),
			taskId: childTaskId,
			mode: mode.slug,
			tools: tools.schemas,
			tool_choice: tools.toolChoice,
			parallelToolCalls: tools.parallelToolCalls,
			allowedFunctionNames: tools.allowedFunctionNames,
		},
	}

	return createStepContext({
		contextId: options.contextId ?? deriveChildContextId(context, childTaskId, options),
		parentContextId: context.contextId,
		createdAt: options.createdAt ?? context.createdAt,
		retryAttempt: options.retryAttempt ?? 0,
		kind: options.kind ?? "agent",
		task,
		mode,
		provider,
		instructions,
		environment,
		transcript,
		tools,
		policy: options.policy ?? context.policy,
		budget,
		request,
	} as unknown as CreateStepContextInput)
}

/**
 * Derive the compaction lane as a first-class child context. It inherits the
 * parent task and execution inputs while recording the compaction operation in
 * the budget metadata and linking back to the parent context.
 */
export function deriveCompactionStepContext(
	context: StepContext,
	options: CompactionStepContextOptions = {},
): StepContext {
	const compaction = {
		...context.budget.compaction,
		...(options.compaction ?? {}),
		...(options.action ? { action: options.action } : {}),
	}
	const { compaction: _ignored, action: _action, ...childOptions } = options

	return deriveChildStepContext(context, {
		...childOptions,
		childTaskId: childOptions.childTaskId ?? childOptions.taskId ?? context.task.taskId,
		kind: "compaction",
		budget: {
			...(childOptions.budget ?? {}),
			compaction,
		},
	})
}

export function toStepContextMetadata(context: StepContext, retryAttempt = context.retryAttempt): StepContextMetadata {
	const digests = getStepContextDigests(context)

	return Object.freeze({
		stepContextId: context.contextId,
		stepContextKind: context.kind,
		stepContextParentId: context.parentContextId,
		stepContextRetryAttempt: retryAttempt,
		stepContextDigest: digests.context,
		stepContextProvider: context.provider.apiProvider,
		stepContextProtocol: context.provider.apiProtocol,
		stepContextModel: context.provider.modelId,
		stepContextProfile: context.mode.profileName,
		stepContextMode: context.mode.slug,
		stepContextExecutionProfile: context.mode.executionProfileId,
		stepContextExecutionProfileDigest: context.mode.executionProfileDigest,
		stepContextModelDigest: digests.model,
		stepContextPromptDigest: digests.prompt,
		stepContextEnvironmentDigest: digests.environment,
		stepContextStableEnvironmentDigest: digests.stableEnvironment,
		stepContextVolatileEnvironmentDigest: digests.volatileEnvironment,
		stepContextInstructionDigest: digests.instructions,
		stepContextTranscriptDigest: digests.transcript,
		stepContextTranscriptStart: context.transcript.boundary.startIndex,
		stepContextTranscriptEnd: context.transcript.boundary.endIndex,
		stepContextToolSchemaDigest: digests.tools,
		stepContextPolicyDigest: digests.policy,
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
	})
}

/** Alias retained for callers that use “metadata” as the snapshot boundary. */
export const createStepContextMetadata = toStepContextMetadata
