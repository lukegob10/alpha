import { Anthropic } from "@anthropic-ai/sdk"
import { serializeError } from "serialize-error"
import path from "path"

import type { ClineAsk, ClineAskResponse, ClineSay, ModeConfig, ToolProgressStatus } from "@alpha-code/types"

import type { ToolResponse, ToolUse } from "../../shared/tools"
import type { ToolApprovalResponse, ToolCallbacks, ToolResultMetadata } from "../tools/BaseTool"
import { ToolReadDeniedError } from "../tools/BaseTool"
import { formatResponse } from "../prompts/responses"
import { getModeBySlug } from "../../shared/modes"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { AskIgnoredError } from "../task/AskIgnoredError"
import type { Task } from "../task/Task"
import { validateToolUse } from "../tools/validateToolUse"
import type { AgentResponse, AgentToolCall } from "./AgentResponse"
import type { AgentTurnEvent } from "./AgentTurnEvents"
import type { PreparedToolRead, TaskReadGrant, ToolDescriptor, ToolRegistry } from "../tools/ToolRegistry"
import {
	getToolOutputLimit,
	isCommandDeniedByPolicy,
	isPathAllowed,
	isToolAllowed,
	resolveCommandTimeoutMs,
	type ToolPolicySnapshot,
} from "./ToolPolicy"

export interface ToolSchedulerOptions {
	/**
	 * Legacy Task facade. New callers can provide `executionHost` instead and
	 * keep scheduler orchestration independent from the concrete Task class.
	 */
	task?: Task
	executionHost?: ToolExecutionHost
	registry: ToolRegistry
	mode: string
	customModes?: ModeConfig[]
	experiments?: Record<string, boolean>
	disabledTools?: string[]
	includedTools?: string[]
	policy?: ToolPolicySnapshot
	readGrant?: TaskReadGrant
	signal?: AbortSignal
	/** Optional test/host override for mode and disabled-tool validation. */
	validateCall?: (call: AgentToolCall, toolCall: ToolUse<any>) => void
	/** Revalidate the persisted assistant boundary immediately before an effect. */
	beforeEffect?: (call: AgentToolCall) => void | Promise<void>
	/** Persist deterministic results for all calls when cancellation wins. */
	preserveAbortedResults?: boolean
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>
	/** Safe by default. Parallel work is opt-in at the scheduler boundary. */
	executionMode?: ToolExecutionMode
	/** Maximum active calls and prepared calls in one window (hard capped at 16). */
	maxConcurrency?: number
}

/** Scheduler-level execution policy. */
export type ToolExecutionMode = "serial" | "selective-parallel"

type ToolExecutionContent = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam>

type ToolExecutionApproval = (
	type: ClineAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>

type ToolExecutionSay = (type: ClineSay, text?: string, images?: string[]) => Promise<unknown>

type ToolExecutionHostAsk = (
	type: ClineAsk,
	partialMessage?: string,
	partial?: boolean,
	progressStatus?: ToolProgressStatus,
	isProtected?: boolean,
) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>

/**
 * The small state and callback surface the scheduler needs from its host.
 *
 * `taskFacade` is intentionally optional: existing registry executors still
 * receive the legacy Task facade, while isolated hosts can use descriptors
 * that only need the provider-neutral scheduler context.
 */
export interface ToolExecutionHost {
	taskId: string
	cwd?: string
	abort?: boolean
	didToolFailInCurrentTurn?: boolean
	userMessageContent: ToolExecutionContent
	userMessageContentReady?: boolean
	ask?: ToolExecutionHostAsk
	/** Alias kept explicit for host implementations that prefer an approval name. */
	askApproval?: ToolExecutionApproval
	say: ToolExecutionSay
	recordToolUsage: (name: string) => void
	pushToolResultToUserContent: (result: Anthropic.ToolResultBlockParam) => boolean
	/** Query existing persisted/staged receipts without mutating the result transaction. */
	hasToolResultForCall?: (callId: string) => boolean
	/** Pure gate; checked before read preparation and immediately before execution. */
	shouldStopRepeatedToolCall?: (name: string, args: unknown) => boolean
	/** Observe terminal effects in model order before admitting the next effect. */
	recordToolCallForStopping?: (
		name: string,
		args: unknown,
		status: ToolSchedulerResult["status"],
		commandCategory?: "test" | "build" | "lint" | "typecheck",
		result?: ToolSchedulerResult,
	) => void | Promise<void>
	/** Rich facade for existing ToolRegistry handlers. */
	taskFacade?: Task
}

export interface ToolSchedulerOutcome {
	status: "completed" | "aborted" | "failed"
	results: ToolSchedulerResult[]
	batchSize: number
	parallelBatchCount: number
	parallelToolCount: number
	durationMs: number
	approvalRequestCount: number
	approvalDeniedCount: number
	approvalCancelledCount: number
	supersededAskCount: number
	completedToolResultCount: number
	outputTruncatedCount: number
	/** Present when host integrity checks prevented one or more effects. */
	failure?: ToolSchedulerFailure
}

export interface ToolSchedulerFailure {
	kind: "effect_fence"
	callId: string
	message: string
}

export interface ToolSchedulerResult {
	callId: string
	name: string
	status: "success" | "error" | "denied" | "cancelled"
	content: ToolResponse
	/** Actual process outcome, when the tool reports one separately from handler completion. */
	executionStatus?: ToolResultMetadata["executionStatus"]
	exitCode?: number
	truncated?: boolean
	timedOut?: boolean
	/** Trusted progress-only observation; never verification evidence. */
	trustedExploration?: ToolResultMetadata["trustedExploration"]
	durationMs: number
}

class ToolEffectFenceError extends Error {
	readonly call: AgentToolCall

	constructor(call: AgentToolCall, cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause)
		super(message, { cause })
		this.name = "ToolEffectFenceError"
		this.call = call
	}
}

type ToolResultStatus = NonNullable<ToolResultMetadata["status"]>

const STRUCTURED_TOOL_RESULT_STATUSES = new Set<ToolResultStatus>(["success", "error", "denied", "cancelled"])

function getStructuredToolResultStatus(content: ToolResponse): ToolResultStatus | undefined {
	const textParts =
		typeof content === "string"
			? [content]
			: content.filter((item): item is Anthropic.TextBlockParam => item.type === "text").map((item) => item.text)

	for (const text of textParts) {
		if (text.length > 16_000) {
			continue
		}

		try {
			const parsed: unknown = JSON.parse(text)
			if (parsed && typeof parsed === "object" && "status" in parsed) {
				const status = (parsed as { status?: unknown }).status
				if (typeof status === "string" && STRUCTURED_TOOL_RESULT_STATUSES.has(status as ToolResultStatus)) {
					return status as ToolResultStatus
				}
			}
		} catch {
			// Most tool output is plain text. Only structured status payloads are normalized.
		}
	}

	return undefined
}

class AsyncMutex {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(operation: () => Promise<T>): Promise<T> {
		let release!: () => void
		const previous = this.tail
		this.tail = new Promise<void>((resolve) => {
			release = resolve
		})

		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}
}

class ToolResultCollector {
	private result: ToolResponse | undefined
	private feedback?: { text: string; images?: string[] }
	private status: ToolSchedulerResult["status"] = "success"
	private metadata: ToolResultMetadata = {}
	private truncated = false

	constructor(private readonly maxOutputChars: number) {}

	setApprovalFeedback(feedback: { text: string; images?: string[] }): void {
		this.feedback = feedback
	}

	setStatus(status: ToolSchedulerResult["status"]): void {
		this.status = status
	}

	setMetadata(metadata: ToolResultMetadata): void {
		this.metadata = { ...this.metadata, ...metadata }
	}

	getMetadata(): ToolResultMetadata {
		return this.metadata
	}

	push(content: ToolResponse): void {
		if (this.result !== undefined) {
			return
		}

		const structuredStatus = getStructuredToolResultStatus(content)
		if (structuredStatus && this.status === "success") {
			this.status = structuredStatus
		}

		if (this.feedback) {
			const feedbackText = formatResponse.toolApprovedWithFeedback(this.feedback.text)
			const feedbackImages = this.feedback.images ? formatResponse.imageBlocks(this.feedback.images) : []
			if (typeof content === "string") {
				content = `${feedbackText}\n\n${content || "(tool did not return anything)"}`
			} else {
				content = [{ type: "text", text: feedbackText }, ...feedbackImages, ...content]
			}
		}

		const limited = limitToolResponse(content, this.maxOutputChars)
		content = limited.content
		this.truncated ||= limited.truncated

		this.result = content
	}

	getStatus(): ToolSchedulerResult["status"] {
		// A non-success status from either the handler metadata or structured output
		// must not be hidden by a normally-resolved outer invocation.
		if (this.metadata.status && this.metadata.status !== "success") {
			return this.metadata.status
		}
		return this.status === "success" ? (this.metadata.status ?? this.status) : this.status
	}

	getContent(): ToolResponse {
		return this.result ?? "(tool did not return anything)"
	}

	hasResult(): boolean {
		return this.result !== undefined
	}

	isTruncated(): boolean {
		return this.truncated
	}
}

function limitToolResponse(
	content: ToolResponse,
	maxOutputChars: number,
): { content: ToolResponse; truncated: boolean } {
	const parts = getToolResultParts(content)
	if (parts.text.length <= maxOutputChars) {
		return { content, truncated: false }
	}

	const suffix = "\n[Tool output truncated by harness]"
	const available = Math.max(0, maxOutputChars - suffix.length)
	const text = `${parts.text.slice(0, available)}${suffix}`
	return {
		content: typeof content === "string" ? text : [{ type: "text", text }, ...parts.images],
		truncated: true,
	}
}

function getVerificationCategory(call: AgentToolCall): "test" | "build" | "lint" | "typecheck" | undefined {
	if (call.name !== "execute_command") {
		return undefined
	}

	const command =
		typeof call.arguments === "object" && call.arguments !== null
			? String((call.arguments as Record<string, unknown>).command ?? "")
			: ""
	if (/(test|pytest|vitest|jest|mocha|ruff)/i.test(command)) return "test"
	if (/(build|bundle|compile)/i.test(command)) return "build"
	if (/(lint|eslint|prettier|format)/i.test(command)) return "lint"
	if (/(typecheck|check-types|tsc)/i.test(command)) return "typecheck"
	return undefined
}

interface PreparedCall {
	index: number
	call: AgentToolCall
	toolCall?: ToolUse<any>
	descriptor?: ToolDescriptor
	validationError?: string
	preparationDenied?: boolean
	readPrepared?: boolean
	read?: PreparedToolRead
	scope?: string
	finalizeRead?: () => Promise<ToolResponse>
}

function scopeContains(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function scopesOverlap(left: string, right: string): boolean {
	return scopeContains(left, right) || scopeContains(right, left)
}

function trustedExplorationForResult(
	metadata: ToolResultMetadata,
	status: ToolSchedulerResult["status"],
	toolName: string,
	workspaceRoot?: string,
): ToolResultMetadata["trustedExploration"] | undefined {
	const observation = metadata.trustedExploration
	const executionStatus = metadata.executionStatus ?? metadata.status
	if (
		toolName !== "execute_command" ||
		status !== "success" ||
		executionStatus !== "success" ||
		metadata.exitCode !== 0 ||
		!observation ||
		!path.isAbsolute(observation.scope) ||
		observation.scope.length > 4_096 ||
		path.normalize(observation.scope) !== observation.scope ||
		(workspaceRoot !== undefined &&
			(!path.isAbsolute(workspaceRoot) || !scopeContains(path.normalize(workspaceRoot), observation.scope))) ||
		!/^[a-f0-9]{64}$/.test(observation.semanticFingerprint)
	) {
		return undefined
	}
	return {
		scope: observation.scope,
		semanticFingerprint: observation.semanticFingerprint,
	}
}

function formatFailureResult(message: string, status: Exclude<ToolResultStatus, "success">): string {
	// Scheduler-generated receipts use the same status/message envelope as tool
	// denial and discovery cancellation. toolError is reserved for actual failures.
	return status === "error" ? formatResponse.toolError(message) : JSON.stringify({ status, message })
}

function resultForError(
	call: AgentToolCall,
	message: string,
	status: "error" | "denied" = "error",
): ToolSchedulerResult {
	return {
		callId: call.id,
		name: call.name,
		status,
		content: formatFailureResult(message, status),
		durationMs: 0,
	}
}

/** Shared preflight for the host's persistence boundary and the scheduler's effect boundary. */
export function getToolBatchIsolationError(registry: ToolRegistry, toolNames: readonly string[]): string | undefined {
	if (toolNames.length <= 1) return undefined

	const barrier = toolNames.find((name) => registry.resolve(name)?.capabilities.concurrency === "barrier")
	if (!barrier) return undefined

	return (
		`${barrier} must be called by itself in a message turn. ` +
		"No tools from this turn were executed. Retry with the control-flow tool alone."
	)
}

function getToolResultParts(content: ToolResponse): {
	text: string
	images: Anthropic.ImageBlockParam[]
} {
	if (typeof content === "string") {
		return { text: content || "(tool did not return anything)", images: [] }
	}

	const text = content
		.filter((item): item is Anthropic.TextBlockParam => item.type === "text")
		.map((item) => item.text)
		.join("\n")
	const images = content.filter((item): item is Anthropic.ImageBlockParam => item.type === "image")

	return {
		text: text || "(tool did not return anything)",
		images,
	}
}

function normalizeAgentToolCall(value: unknown): AgentToolCall {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
	return {
		type: "tool_call",
		id: typeof record?.id === "string" ? record.id : "",
		name: typeof record?.name === "string" ? record.name : "",
		arguments: record?.arguments,
	}
}

function getPathArguments(toolName: string, argumentsValue: Record<string, unknown>): unknown[] {
	const candidates = ["path", "file_path", "cwd", "directory"].map((key) => argumentsValue[key])
	if (toolName === "generate_image") candidates.push(argumentsValue.image)

	if (toolName === "read_file" && Array.isArray(argumentsValue.files)) {
		candidates.push(
			...argumentsValue.files.map((entry) => (entry && typeof entry === "object" ? entry.path : undefined)),
		)
	}
	if (toolName === "search_files" && Array.isArray(argumentsValue.queries)) {
		candidates.push(
			...argumentsValue.queries.map((entry) => (entry && typeof entry === "object" ? entry.path : undefined)),
		)
	}

	return candidates
}

const VERIFICATION_OUTPUT_LIMIT = 8_000
const SENSITIVE_OUTPUT_PATTERN =
	/(\b(?:api[_-]?key|secret|password|credential|authorization|private[_-]?key|bearer|token)\s*[:=]\s*)(["']?)([^\s"',}\n]+)(\2)/gi

function getVerificationOutput(content: ToolResponse): string {
	const text = getToolResultParts(content).text
	const redacted = text.replace(SENSITIVE_OUTPUT_PATTERN, "$1$2[redacted]$4")
	const suffix = "\n[truncated]"
	return redacted.length > VERIFICATION_OUTPUT_LIMIT
		? `${redacted.slice(0, VERIFICATION_OUTPUT_LIMIT - suffix.length)}${suffix}`
		: redacted
}

export class ToolScheduler {
	private readonly approvalMutex = new AsyncMutex()
	private readonly admissionMutex = new AsyncMutex()
	private effectFenceFailure?: ToolEffectFenceError
	private batchController = new AbortController()
	private executionSignal?: AbortSignal
	private approvalRequestCount = 0
	private approvalDeniedCount = 0
	private approvalCancelledCount = 0
	private supersededAskCount = 0
	private parallelToolCount = 0
	private outputTruncatedCount = 0
	private readonly observedToolCallIds = new Set<string>()

	constructor(private readonly options: ToolSchedulerOptions) {}

	private get executionHost(): ToolExecutionHost {
		const host = this.options.executionHost ?? (this.options.task as unknown as ToolExecutionHost | undefined)
		if (!host) {
			throw new Error("ToolScheduler requires an executionHost or legacy task facade.")
		}
		return host
	}

	private get toolTask(): Task {
		return (
			this.options.executionHost?.taskFacade ??
			this.options.task ??
			(this.options.executionHost as unknown as Task)
		)
	}

	private get executionMode(): ToolExecutionMode {
		return this.options.executionMode ?? "serial"
	}

	private get maxConcurrency(): number {
		const requested = this.options.maxConcurrency
		if (requested === undefined || !Number.isFinite(requested)) {
			return 4
		}
		return Math.min(16, Math.max(1, Math.floor(requested)))
	}

	private isSelectableParallel(item: PreparedCall | undefined): boolean {
		const capabilities = item?.descriptor?.capabilities
		const captured = item?.descriptor && this.options.policy?.capabilities[item.descriptor.name]
		return (
			this.executionMode === "selective-parallel" &&
			capabilities?.concurrency === "parallel" &&
			capabilities.sideEffects === "none" &&
			!capabilities.controlFlow &&
			!!item?.scope &&
			(!captured ||
				(captured.concurrency === "parallel" &&
					captured.sideEffects === "none" &&
					!captured.controlFlow &&
					(!captured.requiresApproval || !!item.read))) &&
			(!capabilities.requiresApproval || !!item.read)
		)
	}

	private hasAuditedParallelReadCapability(item: PreparedCall): boolean {
		const descriptor = item.descriptor
		if (!descriptor) return false
		const capabilities = descriptor.capabilities
		if (
			!capabilities ||
			capabilities.concurrency !== "parallel" ||
			capabilities.sideEffects !== "none" ||
			capabilities.controlFlow
		)
			return false

		const captured = this.options.policy?.capabilities[descriptor.name]
		return (
			!captured ||
			(captured.concurrency === "parallel" && captured.sideEffects === "none" && !captured.controlFlow)
		)
	}

	private async checkEffectFence(call: AgentToolCall): Promise<void> {
		if (this.effectFenceFailure) throw this.effectFenceFailure
		try {
			await this.options.beforeEffect?.(call)
		} catch (error) {
			this.effectFenceFailure ??= new ToolEffectFenceError(call, error)
			this.batchController.abort(this.effectFenceFailure)
			throw this.effectFenceFailure
		}
	}

	private async observeToolResult(result: ToolSchedulerResult, call: AgentToolCall): Promise<void> {
		if (!this.executionHost.recordToolCallForStopping) return
		const callId = sanitizeToolUseId(result.callId)
		try {
			if (
				this.observedToolCallIds.has(callId) ||
				this.executionHost.hasToolResultForCall?.(callId) ||
				this.executionHost.userMessageContent.some(
					(item) => item.type === "tool_result" && sanitizeToolUseId(item.tool_use_id) === callId,
				)
			)
				return
			this.observedToolCallIds.add(callId)
			await this.executionHost.recordToolCallForStopping(
				result.name,
				call.arguments,
				result.status,
				getVerificationCategory(call),
				result,
			)
		} catch (error) {
			// A failed evidence observation must preserve the already completed effect
			// and close remaining receipts through the existing failed-batch boundary.
			this.effectFenceFailure ??= new ToolEffectFenceError(call, error)
			this.batchController.abort(this.effectFenceFailure)
			throw this.effectFenceFailure
		}
	}

	private async prepareRead(item: PreparedCall): Promise<void> {
		if (item.readPrepared || item.validationError || !item.toolCall || !item.descriptor) return
		item.readPrepared = true
		const { readGrant, policy } = this.options
		if (
			readGrant?.enabled &&
			policy &&
			item.descriptor.prepareParallelRead &&
			this.hasAuditedParallelReadCapability(item)
		) {
			// Canonical path preflight itself performs filesystem reads. Keep it
			// behind the same per-call durability boundary as the eventual handler.
			await this.checkEffectFence(item.call)
			if (this.isCancelled()) return
			try {
				item.read = await item.descriptor.prepareParallelRead(
					this.toolTask,
					item.toolCall,
					readGrant,
					policy,
					this.executionSignal,
				)
			} catch (error) {
				if (!this.isCancelled())
					item.validationError = `Unable to prepare ${item.call.name}: ${this.errorMessage(error)}`
				item.preparationDenied = error instanceof ToolReadDeniedError
				return
			}
		}
		try {
			item.scope =
				item.read?.scope ?? item.descriptor.getConcurrencyScope?.(item.toolCall, this.executionHost.cwd ?? "")
		} catch (error) {
			item.validationError = `Unable to resolve ${item.call.name} scope: ${this.errorMessage(error)}`
		}
		if (!item.scope || !path.isAbsolute(item.scope)) item.scope = undefined
	}

	private async finalizeRead(item: PreparedCall, result: ToolSchedulerResult): Promise<ToolSchedulerResult> {
		const finalize = item.finalizeRead
		item.finalizeRead = undefined
		if (item.read && result.status === "error") this.executionHost.didToolFailInCurrentTurn = true
		if (!finalize || this.isCancelled()) return this.isCancelled() ? this.cancelledResultFor(item.call) : result
		const startedAt = performance.now()
		try {
			const output = limitToolResponse(
				await finalize(),
				Math.min(
					item.descriptor?.maxOutputChars ?? Number.MAX_SAFE_INTEGER,
					getToolOutputLimit(this.options.policy, item.call.name),
				),
			)
			if (output.truncated) this.outputTruncatedCount++
			return {
				...result,
				content: output.content,
				truncated: output.truncated,
				durationMs: result.durationMs + Math.max(0, performance.now() - startedAt),
			}
		} catch (error) {
			if (this.isCancelled()) return this.cancelledResultFor(item.call)
			if (!(error instanceof ToolReadDeniedError)) this.executionHost.didToolFailInCurrentTurn = true
			const status = error instanceof ToolReadDeniedError ? "denied" : "error"
			return {
				...result,
				status,
				content: formatFailureResult(this.errorMessage(error), status),
			}
		}
	}

	async run(response: AgentResponse | AgentToolCall[]): Promise<ToolSchedulerOutcome> {
		this.approvalRequestCount = 0
		this.approvalDeniedCount = 0
		this.approvalCancelledCount = 0
		this.supersededAskCount = 0
		this.parallelToolCount = 0
		this.outputTruncatedCount = 0
		this.observedToolCallIds.clear()
		this.effectFenceFailure = undefined
		this.batchController = new AbortController()
		this.executionSignal = this.options.signal
			? AbortSignal.any([this.options.signal, this.batchController.signal])
			: this.batchController.signal
		const startedAt = performance.now()
		const calls = (
			Array.isArray(response)
				? response
				: response && typeof response === "object" && Array.isArray(response.items)
					? response.items.filter((item) => item?.type === "tool_call")
					: []
		).map(normalizeAgentToolCall)
		const prepared = calls.map((call, index) => this.prepareCall(call, index))
		const results = new Array<ToolSchedulerResult | undefined>(prepared.length)

		if (prepared.length === 0) {
			return this.metrics("completed", [], calls.length, 0, startedAt)
		}

		await this.options.onEvent?.({ type: "tool_batch_started", batchSize: calls.length })

		// The host may already have staged these rejections before persistence.
		// Cancellation aborts the batch without changing an invalid call's error receipt.
		const isolationError = getToolBatchIsolationError(
			this.options.registry,
			calls.map((call) => (typeof call?.name === "string" ? call.name : "")),
		)
		if (isolationError) {
			for (const item of prepared) {
				results[item.index] = resultForError(item.call, isolationError)
			}
			return this.commitResults(results, calls, calls.length, 0, startedAt)
		}

		if (this.isCancelled()) {
			this.fillCancelledResults(results, calls)
			return this.abortOutcome(results, calls, calls.length, 0, startedAt)
		}

		let cursor = 0
		let parallelBatchCount = 0
		while (cursor < prepared.length) {
			if (this.isCancelled()) {
				this.fillCancelledResults(results, calls, cursor)
				return this.abortOutcome(results, calls, calls.length, parallelBatchCount, startedAt)
			}

			const item = prepared[cursor]
			if (item.validationError || !item.descriptor || !item.toolCall) {
				results[item.index] = resultForError(
					item.call,
					item.validationError ?? "Tool call could not be prepared.",
					item.preparationDenied ? "denied" : "error",
				)
				cursor += 1
				continue
			}
			if (
				this.executionHost.shouldStopRepeatedToolCall?.(
					item.call.name,
					item.toolCall?.nativeArgs ?? item.call.arguments,
				)
			) {
				results[item.index] = resultForError(
					item.call,
					`Stopping repeated ${item.call.name} call; use existing evidence or change the approach.`,
				)
				cursor += 1
				continue
			}
			try {
				await this.prepareRead(item)
			} catch (error) {
				if (!(error instanceof ToolEffectFenceError)) throw error
				return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
			}
			if (item.validationError) {
				results[item.index] = resultForError(
					item.call,
					item.validationError,
					item.preparationDenied ? "denied" : "error",
				)
				cursor++
				continue
			}
			if (this.isSelectableParallel(item)) {
				const parallelItems: PreparedCall[] = []
				while (cursor < prepared.length && parallelItems.length < this.maxConcurrency) {
					const candidate = prepared[cursor]
					try {
						await this.prepareRead(candidate)
					} catch (error) {
						if (!(error instanceof ToolEffectFenceError)) throw error
						return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
					}
					if (
						candidate.validationError ||
						!candidate.descriptor ||
						!candidate.toolCall ||
						!this.isSelectableParallel(candidate) ||
						parallelItems.some((active) => scopesOverlap(active.scope!, candidate.scope!))
					) {
						break
					}
					parallelItems.push(candidate)
					cursor += 1
				}
				parallelBatchCount += 1
				this.parallelToolCount += parallelItems.length

				const settled = await this.executeParallelBatch(parallelItems)
				settled.results.forEach((result, offset) => {
					if (result) results[parallelItems[offset].index] = result
				})
				// No worker is live here, including workers that ignored cancellation.
				// Publish UI and shared Task state in model-call order.
				for (const readItem of parallelItems) {
					const result = results[readItem.index]
					if (result) results[readItem.index] = await this.finalizeRead(readItem, result)
				}
				if (settled.failure) {
					return this.failedOutcome(
						results,
						calls,
						settled.failure,
						calls.length,
						parallelBatchCount,
						startedAt,
					)
				}
				if (this.isCancelled()) {
					this.fillCancelledResults(results, calls, cursor)
					return this.abortOutcome(results, calls, calls.length, parallelBatchCount, startedAt)
				}
				try {
					// All workers and finalizers are settled. Only this bounded read
					// window can overshoot a stop; later windows have not been admitted.
					for (const readItem of parallelItems) {
						await this.observeToolResult(results[readItem.index]!, readItem.call)
					}
				} catch (error) {
					if (!(error instanceof ToolEffectFenceError)) throw error
					return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
				}
				continue
			}

			try {
				results[item.index] = await this.executeCall(item)
				results[item.index] = await this.finalizeRead(item, results[item.index]!)
				if (!this.isCancelled()) await this.observeToolResult(results[item.index]!, item.call)
			} catch (error) {
				if (!(error instanceof ToolEffectFenceError)) throw error
				return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
			}
			cursor += 1
			if (this.isCancelled()) {
				this.fillCancelledResults(results, calls, cursor)
				return this.abortOutcome(results, calls, calls.length, parallelBatchCount, startedAt)
			}
		}

		if (this.isCancelled()) {
			this.fillCancelledResults(results, calls)
			return this.abortOutcome(results, calls, calls.length, parallelBatchCount, startedAt)
		}

		return this.commitResults(results, calls, calls.length, parallelBatchCount, startedAt)
	}

	private async executeParallelBatch(items: PreparedCall[]): Promise<{
		results: Array<ToolSchedulerResult | undefined>
		failure?: ToolEffectFenceError
	}> {
		const results = new Array<ToolSchedulerResult | undefined>(items.length)
		let nextIndex = 0
		let failure: ToolEffectFenceError | undefined
		const workerCount = Math.min(this.maxConcurrency, items.length)

		const worker = async (): Promise<void> => {
			while (nextIndex < items.length) {
				if (failure) return
				const index = nextIndex
				nextIndex += 1
				const item = items[index]
				if (this.isCancelled()) {
					results[index] = this.cancelledResultFor(item.call)
					continue
				}

				// executeCall converts ordinary tool failures into deterministic results.
				// The only error it intentionally lets escape is the host's beforeEffect
				// fence, which must fail the scheduler rather than become a tool result.
				try {
					results[index] = await this.executeCall(item)
				} catch (error) {
					if (!(error instanceof ToolEffectFenceError)) throw error
					failure ??= error
				}
			}
		}

		const workers = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
		const rejected = workers.find((result) => result.status === "rejected")
		if (rejected?.status === "rejected") throw rejected.reason
		return { results, ...(failure ? { failure } : {}) }
	}

	private cancelledResultFor(call: AgentToolCall): ToolSchedulerResult {
		return {
			callId: call.id,
			name: call.name,
			status: "cancelled",
			content: formatFailureResult("Tool execution was cancelled.", "cancelled"),
			executionStatus: "cancelled",
			durationMs: 0,
		}
	}

	private fillCancelledResults(
		results: Array<ToolSchedulerResult | undefined>,
		calls: AgentToolCall[],
		fromIndex = 0,
	): void {
		for (let index = Math.max(0, fromIndex); index < calls.length; index += 1) {
			if (!results[index]) {
				results[index] = this.cancelledResultFor(calls[index])
			}
		}
	}

	private async abortOutcome(
		results: Array<ToolSchedulerResult | undefined>,
		calls: AgentToolCall[],
		batchSize: number,
		parallelBatchCount: number,
		startedAt: number,
	): Promise<ToolSchedulerOutcome> {
		const completeResults = calls.map((call, index) => results[index] ?? this.cancelledResultFor(call))
		// Cancellation can win while a call is running or between calls. Hosts
		// that own durable transcripts opt into preserving every result (including
		// deterministic cancelled receipts) through the same boundary used by
		// normal completion. `push...` is idempotent, so results already committed
		// before cancellation are not duplicated.
		if (this.options.preserveAbortedResults) {
			for (const [index, result] of completeResults.entries()) {
				const parts = getToolResultParts(result.content)
				const added = this.executionHost.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(result.callId),
					content: parts.text,
					is_error: result.status === "error" || result.status === "denied" || result.status === "cancelled",
				})
				if (added && parts.images.length > 0) this.executionHost.userMessageContent.push(...parts.images)
				if (!added) continue
				await this.options.onEvent?.({
					type: "tool_result",
					callId: result.callId,
					name: result.name,
					status: result.status,
					output: result.content,
					truncated: result.truncated,
					timedOut: result.timedOut,
				})
				const commandCategory = getVerificationCategory(calls[index])
				const verificationStatus =
					result.executionStatus ?? (result.status === "success" ? undefined : result.status)
				if (commandCategory && verificationStatus && verificationStatus !== "running") {
					await this.options.onEvent?.({
						type: "verification_result",
						commandCategory,
						toolName: result.name,
						status: verificationStatus,
						durationMs: result.durationMs,
						exitCode: result.exitCode,
						output: getVerificationOutput(result.content),
					})
				}
			}
			this.executionHost.userMessageContentReady = true
		}
		const outcome = this.metrics("aborted", completeResults, batchSize, parallelBatchCount, startedAt)
		await this.options.onEvent?.({
			type: "tool_batch_finished",
			status: outcome.status,
			batchSize: outcome.batchSize,
			parallelBatchCount: outcome.parallelBatchCount,
			parallelToolCount: outcome.parallelToolCount,
			durationMs: outcome.durationMs,
			truncatedResultCount: outcome.outputTruncatedCount,
		})
		return outcome
	}

	private async failedOutcome(
		results: Array<ToolSchedulerResult | undefined>,
		calls: AgentToolCall[],
		failure: ToolEffectFenceError,
		batchSize: number,
		parallelBatchCount: number,
		startedAt: number,
	): Promise<ToolSchedulerOutcome> {
		const failedIndex = calls.indexOf(failure.call)
		const cancelled = this.isCancelled()
		const completeResults = calls.map((call, index) => {
			const existing = results[index]
			if (existing) return existing
			if (cancelled) return this.cancelledResultFor(call)
			return resultForError(
				call,
				index === failedIndex
					? `Tool effect was blocked by the transcript persistence fence: ${failure.message}`
					: `Tool call was not executed because the transcript persistence fence failed before it could start: ${failure.message}`,
			)
		})

		// Unlike an exception, this path retains the scheduler's truthful local
		// results. Stage all terminal receipts so the host can durably close every
		// accepted call before returning the failed turn.
		for (const [index, result] of completeResults.entries()) {
			const parts = getToolResultParts(result.content)
			const added = this.executionHost.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(result.callId),
				content: parts.text,
				is_error: result.status === "error" || result.status === "denied" || result.status === "cancelled",
			})
			if (added && parts.images.length > 0) this.executionHost.userMessageContent.push(...parts.images)
			if (added) {
				await this.options.onEvent?.({
					type: "tool_result",
					callId: result.callId,
					name: result.name,
					status: result.status,
					output: result.content,
					truncated: result.truncated,
					timedOut: result.timedOut,
				})
			}
		}
		this.executionHost.userMessageContentReady = true

		const outcome: ToolSchedulerOutcome = {
			...this.metrics("failed", completeResults, batchSize, parallelBatchCount, startedAt),
			failure: {
				kind: "effect_fence",
				callId: failure.call.id,
				message: failure.message,
			},
		}
		await this.options.onEvent?.({
			type: "tool_batch_finished",
			status: outcome.status,
			batchSize: outcome.batchSize,
			parallelBatchCount: outcome.parallelBatchCount,
			parallelToolCount: outcome.parallelToolCount,
			durationMs: outcome.durationMs,
			truncatedResultCount: outcome.outputTruncatedCount,
		})
		return outcome
	}

	private async raceCancellation<T>(operation: () => Promise<T>): Promise<T | undefined> {
		if (this.isCancelled()) {
			return undefined
		}

		let interval: ReturnType<typeof setInterval> | undefined
		let abortListener: (() => void) | undefined
		const cancellation = new Promise<undefined>((resolve) => {
			abortListener = () => resolve(undefined)
			if (this.options.signal) {
				this.options.signal.addEventListener("abort", abortListener, { once: true })
			}
			// Task.abort is a legacy boolean without an event source. Poll only
			// while an interactive host callback is pending so cancellation can
			// release the approval lane deterministically in that compatibility path.
			interval = setInterval(() => {
				if (this.isCancelled()) {
					resolve(undefined)
				}
			}, 25)
		})

		try {
			return await Promise.race([Promise.resolve().then(operation), cancellation])
		} finally {
			if (interval) {
				clearInterval(interval)
			}
			if (abortListener && this.options.signal) {
				this.options.signal.removeEventListener("abort", abortListener)
			}
		}
	}

	private prepareCall(call: AgentToolCall, index: number): PreparedCall {
		const prepared: PreparedCall = { index, call }

		if (typeof call.id !== "string" || typeof call.name !== "string" || !call.id || !call.name) {
			prepared.validationError = "Tool call is missing a valid ID or name."
			return prepared
		}

		const descriptor = this.options.registry.resolve(call.name)
		if (!descriptor) {
			prepared.validationError = `Unknown tool "${call.name}". This tool is not registered.`
			return prepared
		}

		const canonicalName = this.options.registry.canonicalName(call.name)
		if (!isToolAllowed(this.options.policy, canonicalName)) {
			prepared.validationError = `Tool "${call.name}" is not allowed by the current step policy.`
			prepared.descriptor = descriptor
			return prepared
		}

		const argumentsValue = call.arguments === undefined ? {} : call.arguments
		if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
			prepared.validationError = `Invalid arguments for tool "${call.name}".`
			prepared.descriptor = descriptor
			return prepared
		}

		for (const candidate of getPathArguments(canonicalName, argumentsValue as Record<string, unknown>)) {
			if (
				typeof candidate === "string" &&
				candidate &&
				!isPathAllowed(this.options.policy, candidate, this.executionHost.cwd ?? "")
			) {
				prepared.validationError = `Path argument "${candidate}" is outside the allowed workspace roots.`
				prepared.descriptor = descriptor
				return prepared
			}
		}

		if (canonicalName === "execute_command") {
			const command = (argumentsValue as Record<string, unknown>).command
			if (typeof command === "string" && isCommandDeniedByPolicy(this.options.policy, command)) {
				prepared.validationError = "This command is denied by the current execution policy."
				prepared.descriptor = descriptor
				return prepared
			}
		}

		const toolCall: ToolUse<any> = {
			type: "tool_use",
			id: call.id,
			name: canonicalName as never,
			originalName: canonicalName !== call.name ? call.name : undefined,
			params: {},
			partial: false,
			nativeArgs: argumentsValue,
		}

		try {
			if (!getModeBySlug(this.options.mode, this.options.customModes)) {
				throw new Error(`Unknown task mode "${this.options.mode}".`)
			}

			const disabledRequirements = (this.options.disabledTools ?? []).reduce(
				(acc, name) => {
					acc[name] = false
					acc[this.options.registry.canonicalName(name)] = false
					return acc
				},
				{} as Record<string, boolean>,
			)

			if (this.options.validateCall) {
				this.options.validateCall(call, toolCall)
			} else {
				validateToolUse(
					call.name as never,
					this.options.mode,
					this.options.customModes,
					disabledRequirements,
					(toolCall.nativeArgs ?? {}) as Record<string, unknown>,
					this.options.experiments,
					this.options.includedTools,
				)
			}
		} catch (error) {
			prepared.validationError = this.errorMessage(error)
		}

		prepared.descriptor = descriptor
		prepared.toolCall = toolCall
		return prepared
	}

	private async executeCall(prepared: PreparedCall): Promise<ToolSchedulerResult> {
		const startedAt = performance.now()
		if (this.isCancelled()) {
			return this.cancelledResultFor(prepared.call)
		}

		const collector = new ToolResultCollector(
			Math.min(
				prepared.descriptor?.maxOutputChars ?? Number.MAX_SAFE_INTEGER,
				getToolOutputLimit(this.options.policy, prepared.call.name),
			),
		)
		const approvalFeedback = (text: string, images?: string[]) => collector.setApprovalFeedback({ text, images })
		const requestApproval = async (
			args: Parameters<ToolCallbacks["askApproval"]>,
			responseMode: "boolean" | "structured",
		): Promise<ToolApprovalResponse | undefined> =>
			this.approvalMutex.run(async () => {
				if (this.isSelectableParallel(prepared)) {
					throw new ToolReadDeniedError("An approval request cannot run in an approval-free parallel lane.")
				}
				const [type, partialMessage, progressStatus, forceApproval] = args
				const requestId = `${this.executionHost.taskId}:${prepared.call.id}`
				this.approvalRequestCount += 1

				if (this.isCancelled()) {
					this.approvalCancelledCount += 1
					collector.setStatus("cancelled")
					collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
					await this.options.onEvent?.({
						type: "approval_result",
						requestId,
						decision: "cancelled",
						reason: "Task aborted before approval",
					})
					return undefined
				}

				await this.options.onEvent?.({
					type: "approval_request",
					requestId,
					callId: prepared.call.id,
					toolName: prepared.call.name,
				})

				let approval: ToolApprovalResponse | undefined
				try {
					approval = await this.raceCancellation(async () => {
						if (this.executionHost.askApproval) {
							return this.executionHost.askApproval(
								type,
								partialMessage,
								progressStatus,
								forceApproval || false,
							)
						}
						if (this.executionHost.ask) {
							return this.executionHost.ask(
								type,
								partialMessage,
								false,
								progressStatus,
								forceApproval || false,
							)
						}
						throw new Error("Tool execution host does not provide an approval callback.")
					})
				} catch (error) {
					if (error instanceof AskIgnoredError) {
						this.supersededAskCount += 1
						this.approvalCancelledCount += 1
						const status = this.isCancelled() ? "cancelled" : "error"
						collector.setStatus(status)
						collector.push(formatFailureResult(`Approval request was superseded: ${error.message}`, status))
						await this.options.onEvent?.({
							type: "approval_result",
							requestId,
							decision: "cancelled",
							reason: error.message,
						})
						return undefined
					}
					throw error
				}

				if (!approval) {
					this.approvalCancelledCount += 1
					collector.setStatus("cancelled")
					collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
					await this.options.onEvent?.({
						type: "approval_result",
						requestId,
						decision: "cancelled",
						reason: "Task aborted while waiting for approval",
					})
					return undefined
				}

				const { response, text, images } = approval
				if (responseMode === "structured") {
					let decision: "approved" | "denied" | "cancelled"
					if (response === "yesButtonClicked") {
						decision = "approved"
					} else if (response === "objectResponse") {
						try {
							const parsed: unknown = JSON.parse(text || "{}")
							const values =
								parsed && typeof parsed === "object" && !Array.isArray(parsed)
									? Object.values(parsed as Record<string, unknown>)
									: []
							decision =
								values.length > 0 && values.every((value) => value === true) ? "approved" : "denied"
						} catch {
							decision = "denied"
						}
					} else {
						decision = response === "noButtonClicked" || text ? "denied" : "cancelled"
					}

					if (decision !== "approved") {
						collector.setStatus(decision)
						if (decision === "denied") this.approvalDeniedCount += 1
						else this.approvalCancelledCount += 1
					}
					await this.options.onEvent?.({
						type: "approval_result",
						requestId,
						decision,
						...(response !== "objectResponse" && text ? { reason: text } : {}),
					})
					if (decision === "cancelled") {
						collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
						return undefined
					}
					return approval
				}

				if (response !== "yesButtonClicked") {
					const decision = response === "noButtonClicked" || text ? "denied" : "cancelled"
					if (text) {
						await this.executionHost.say("user_feedback", text, images)
						collector.push(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
					} else if (decision === "denied") {
						collector.push(formatResponse.toolDenied())
					} else {
						collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
					}
					collector.setStatus(decision)
					if (decision === "denied") this.approvalDeniedCount += 1
					else this.approvalCancelledCount += 1
					await this.options.onEvent?.({
						type: "approval_result",
						requestId,
						decision,
						reason: text,
					})
					return undefined
				}

				if (text) {
					await this.executionHost.say("user_feedback", text, images)
					approvalFeedback(text, images)
				}
				await this.options.onEvent?.({ type: "approval_result", requestId, decision: "approved" })
				return approval
			})

		const callbacks: ToolCallbacks = {
			askApproval: async (...args: Parameters<ToolCallbacks["askApproval"]>) =>
				(await requestApproval(args, "boolean"))?.response === "yesButtonClicked",
			askApprovalResponse: async (...args: Parameters<NonNullable<ToolCallbacks["askApprovalResponse"]>>) =>
				requestApproval(args, "structured"),
			handleError: async (action: string, error: Error) => {
				if (error instanceof AskIgnoredError) {
					this.supersededAskCount += 1
					const status = this.isCancelled() ? "cancelled" : "error"
					collector.setStatus(status)
					collector.push(formatFailureResult(`Tool approval was superseded: ${error.message}`, status))
					return
				}
				const cancelled = this.isCancelled()
				if (!cancelled) {
					this.executionHost.didToolFailInCurrentTurn = true
				}
				collector.setStatus(cancelled ? "cancelled" : "error")
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
				if (cancelled) {
					collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
				} else {
					await this.executionHost.say("error", `Error ${action}:\n${error.message}`)
					collector.push(formatResponse.toolError(errorString))
				}
			},
			pushToolResult: (content: ToolResponse) => collector.push(content),
			setResultMetadata: (metadata: ToolResultMetadata) => collector.setMetadata(metadata),
			toolCallId: prepared.call.id,
			signal: this.executionSignal,
			resolveCommandTimeoutMs: (requestedTimeoutMs, command) =>
				resolveCommandTimeoutMs(this.options.policy, requestedTimeoutMs ?? 0, command),
		}

		try {
			if (
				this.executionHost.shouldStopRepeatedToolCall?.(
					prepared.call.name,
					prepared.toolCall?.nativeArgs ?? prepared.toolCall?.params,
				)
			) {
				collector.setStatus("error")
				collector.push(
					formatResponse.toolError(
						`Stopping repeated ${prepared.call.name} call; use existing evidence or change the approach.`,
					),
				)
				return {
					callId: prepared.call.id,
					name: prepared.call.name,
					status: "error",
					content: collector.getContent(),
					durationMs: Math.max(0, performance.now() - startedAt),
				}
			}
			let execution: Promise<void> | undefined
			await this.admissionMutex.run(async () => {
				if (this.isCancelled()) return
				await this.options.onEvent?.({
					type: "progress",
					callId: prepared.call.id,
					text: `Running ${prepared.call.name}`,
				})
				await this.checkEffectFence(prepared.call)
				if (this.isCancelled()) return
				this.executionHost.recordToolUsage(prepared.call.name)
				execution = prepared.read
					? prepared.read.run(this.executionSignal).then((finalize) => {
							prepared.finalizeRead = finalize
						})
					: prepared.descriptor!.execute({
							task: this.toolTask,
							call: prepared.toolCall!,
							signal: this.executionSignal,
							callbacks,
						})
				// Observe an immediate rejection while the admission mutex releases.
				void execution.catch(() => {})
			})
			await execution
		} catch (error) {
			if (error instanceof ToolEffectFenceError) throw error
			const cancelled = this.isCancelled()
			const status = cancelled ? "cancelled" : error instanceof ToolReadDeniedError ? "denied" : "error"
			collector.setStatus(status)
			if (prepared.read && error instanceof Error && "timedOut" in error && error.timedOut === true) {
				collector.setMetadata({ status: "error", timedOut: true })
			}
			collector.push(
				formatFailureResult(
					cancelled
						? "Tool execution was cancelled."
						: `Error executing ${prepared.call.name}: ${this.errorMessage(error)}`,
					status,
				),
			)
		}

		// A handler may finish normally after its abort signal was observed. Keep
		// the externally visible outcome deterministic: once cancellation wins,
		// the call is cancelled even if a late handler callback reported success.
		if (this.isCancelled()) {
			collector.setMetadata({ status: "cancelled" })
			if (!collector.hasResult()) {
				collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
			}
		}

		if (collector.isTruncated()) {
			this.outputTruncatedCount += 1
		}

		const status = collector.getStatus()
		const metadata = collector.getMetadata()
		const executionStatus = metadata.executionStatus ?? metadata.status
		const trustedExploration = trustedExplorationForResult(
			metadata,
			status,
			prepared.call.name,
			this.executionHost.cwd,
		)
		return {
			callId: prepared.call.id,
			name: prepared.call.name,
			status,
			content: collector.getContent(),
			executionStatus,
			exitCode: metadata.exitCode,
			truncated: collector.isTruncated(),
			timedOut: metadata.timedOut,
			...(trustedExploration ? { trustedExploration } : {}),
			durationMs: Math.max(0, performance.now() - startedAt),
		}
	}

	private async commitResults(
		results: Array<ToolSchedulerResult | undefined>,
		calls: AgentToolCall[],
		batchSize: number,
		parallelBatchCount: number,
		startedAt: number,
	): Promise<ToolSchedulerOutcome> {
		if (this.isCancelled()) {
			this.fillCancelledResults(results, calls)
			return this.abortOutcome(results, calls, batchSize, parallelBatchCount, startedAt)
		}

		const committed: ToolSchedulerResult[] = []
		for (let index = 0; index < results.length; index += 1) {
			if (this.isCancelled()) {
				this.fillCancelledResults(results, calls, index)
				return this.abortOutcome(results, calls, batchSize, parallelBatchCount, startedAt)
			}

			const result = results[index] ?? resultForError(calls[index], "Tool execution did not produce a result.")
			try {
				// Effects were observed before the next admission. This fallback
				// handles only previously unobserved preflight/error receipts.
				await this.observeToolResult(result, calls[index])
			} catch (error) {
				if (!(error instanceof ToolEffectFenceError)) throw error
				return this.failedOutcome(results, calls, error, batchSize, parallelBatchCount, startedAt)
			}
			const parts = getToolResultParts(result.content)
			const added = this.executionHost.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(result.callId),
				content: parts.text,
				is_error: result.status === "error" || result.status === "denied" || result.status === "cancelled",
			})
			if (added && parts.images.length > 0) {
				this.executionHost.userMessageContent.push(...parts.images)
			}
			committed.push(result)
			await this.options.onEvent?.({
				type: "tool_result",
				callId: result.callId,
				name: result.name,
				status: result.status,
				output: result.content,
				truncated: result.truncated,
				timedOut: result.timedOut,
			})
			const commandCategory = getVerificationCategory(calls[index])
			const verificationStatus =
				result.executionStatus ?? (result.status === "success" ? undefined : result.status)
			if (commandCategory && verificationStatus && verificationStatus !== "running") {
				await this.options.onEvent?.({
					type: "verification_result",
					commandCategory,
					toolName: result.name,
					status: verificationStatus,
					durationMs: result.durationMs,
					exitCode: result.exitCode,
					output: getVerificationOutput(result.content),
				})
			}
		}

		if (this.isCancelled()) {
			this.fillCancelledResults(results, calls)
			return this.abortOutcome(results, calls, batchSize, parallelBatchCount, startedAt)
		}

		this.executionHost.userMessageContentReady = true
		const outcome = this.metrics("completed", committed, batchSize, parallelBatchCount, startedAt)
		await this.options.onEvent?.({
			type: "tool_batch_finished",
			status: outcome.status,
			batchSize: outcome.batchSize,
			parallelBatchCount: outcome.parallelBatchCount,
			parallelToolCount: outcome.parallelToolCount,
			durationMs: outcome.durationMs,
			truncatedResultCount: outcome.outputTruncatedCount,
		})
		return outcome
	}

	private metrics(
		status: ToolSchedulerOutcome["status"],
		results: ToolSchedulerResult[],
		batchSize: number,
		parallelBatchCount: number,
		startedAt: number,
	): ToolSchedulerOutcome {
		return {
			status,
			results,
			batchSize,
			parallelBatchCount,
			parallelToolCount: this.parallelToolCount,
			durationMs: Math.max(0, performance.now() - startedAt),
			approvalRequestCount: this.approvalRequestCount,
			approvalDeniedCount: this.approvalDeniedCount,
			approvalCancelledCount: this.approvalCancelledCount,
			supersededAskCount: this.supersededAskCount,
			completedToolResultCount: results.length,
			outputTruncatedCount: this.outputTruncatedCount,
		}
	}

	private isCancelled(): boolean {
		return this.executionHost.abort === true || this.options.signal?.aborted === true
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}
}
