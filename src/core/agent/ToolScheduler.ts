import { Anthropic } from "@anthropic-ai/sdk"
import { serializeError } from "serialize-error"
import path from "path"
import { createHash, randomUUID } from "crypto"
import stringify from "safe-stable-stringify"
import { t } from "../../i18n"
import { isBundledSkillResource } from "../../services/skills/bundledSkillResources"
import {
	createTaskSessionApprovalKey,
	grantTaskSessionApproval,
	hasTaskSessionApproval,
} from "../auto-approval/taskSessionApprovalGrants"
import { createPersistentCommandPrefixAmendment } from "../auto-approval/commandApprovalAmendment"
import { assessCommandPaths } from "../auto-approval/commandPathScope"
import { unescapeHtmlEntities } from "../../utils/text-normalization"

import { toolApprovalDecisionSchema, toolApprovalRequestSchema } from "@alpha-code/types"
import type { AlphaAsk, AlphaAskResponse, AlphaSay, ModeConfig, ToolProgressStatus } from "@alpha-code/types"
import type { ToolApprovalDecision, ToolApprovalRequest } from "@alpha-code/types"

import type { ToolResponse, ToolUse } from "../../shared/tools"
import type { ToolApprovalResponse, ToolCallbacks, ToolResultMetadata } from "../tools/BaseTool"
import { MAX_TOOL_PROGRESS_OBSERVATIONS, ToolReadDeniedError } from "../tools/BaseTool"
import {
	createToolFailure,
	formatToolFailureGuidance,
	normalizeToolFailure,
	type ToolFailureMetadata,
} from "../tools/ToolFailure"
import { getImageOutputPaths } from "../tools/imageOutputPaths"
import { extractApplyPatchCommand, rebaseApplyPatchPaths } from "../tools/apply-patch/invocation"
import { resolvePathWithExistingAncestor } from "../tools/pathSafety"
import {
	getTaskDisplayPath,
	normalizeTaskToolArguments,
	redactTaskPrivatePaths,
	resolveTaskWorkspacePath,
	type TaskPathContext,
} from "../tools/taskPathPresentation"
import { extractMutationPaths } from "./VerificationScope"
import { formatResponse } from "../prompts/responses"
import { getModeBySlug } from "../../shared/modes"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { AskIgnoredError } from "../task/AskIgnoredError"
import type { Task } from "../task/Task"
import { validateToolUse } from "../tools/validateToolUse"
import type { AgentResponse, AgentToolCall } from "./AgentResponse"
import type { AgentTurnEvent } from "./AgentTurnEvents"
import type {
	PreparedCommandRead,
	PreparedToolRead,
	TaskReadGrant,
	ToolDescriptor,
	ToolRegistry,
} from "../tools/ToolRegistry"
import { canonicalizeToolName } from "../tools/ToolRegistry"
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
	/** Trusted extension adapter location; admits only the packaged authoring reference allowlist for read_file. */
	bundledSkillExtensionPath?: string
	signal?: AbortSignal
	/** Optional test/host override for mode and disabled-tool validation. */
	validateCall?: (call: AgentToolCall, toolCall: ToolUse<any>) => void
	/** Revalidate the persisted assistant boundary immediately before an effect. */
	beforeEffect?: (call: AgentToolCall) => void | Promise<void>
	/** Durably record that a potentially effectful call is about to start, after approval settles. */
	onEffectStart?: (call: AgentToolCall) => void | Promise<void>
	/** Persist deterministic results for all calls when cancellation wins. */
	preserveAbortedResults?: boolean
	/** Hold results until the host commits the assistant transcript boundary. */
	deferResultCommit?: boolean
	/** Pre-EOF dispatch may execute a command only through its isolated read executor. */
	requirePreparedCommandRead?: boolean
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
	type: AlphaAsk,
	partialMessage?: string,
	progressStatus?: ToolProgressStatus,
	forceApproval?: boolean,
	requiresExplicitApproval?: boolean,
) => Promise<{ response: AlphaAskResponse; text?: string; images?: string[] }>

type ToolExecutionSay = (type: AlphaSay, text?: string, images?: string[]) => Promise<unknown>

type ToolExecutionHostAsk = (
	type: AlphaAsk,
	partialMessage?: string,
	partial?: boolean,
	progressStatus?: ToolProgressStatus,
	isProtected?: boolean,
	requiresExplicitApproval?: boolean,
) => Promise<{ response: AlphaAskResponse; text?: string; images?: string[] }>

/** Full review text stays separate from bounded metadata and is never truncated. */
type ToolExecutionHostApproval = (
	request: ToolApprovalRequest,
	reviewMessage?: string,
) => Promise<ToolApprovalDecision | undefined>

function describeToolApproval(toolName: string, askType: AlphaAsk, message: string | undefined): string | undefined {
	// Command amendments require the exact reviewed command. Never summarize it.
	if (message === undefined || askType === "command" || message.length <= 4_096) return message
	return t("tools:approvalDetails", { toolName, length: message.length })
}

/**
 * The small state and callback surface the scheduler needs from its host.
 *
 * `taskFacade` is intentionally optional: existing registry executors still
 * receive the legacy Task facade, while isolated hosts can use descriptors
 * that only need the provider-neutral scheduler context.
 */
export interface ToolExecutionHost {
	taskId: string
	taskKind?: "primary" | "subagent"
	cwd?: string
	abort?: boolean
	didToolFailInCurrentTurn?: boolean
	userMessageContent: ToolExecutionContent
	userMessageContentReady?: boolean
	ask?: ToolExecutionHostAsk
	/** Alias kept explicit for host implementations that prefer an approval name. */
	askApproval?: ToolExecutionApproval
	/** Typed approval path for hosts that support once/session decisions and reviewed amendments. */
	requestToolApproval?: ToolExecutionHostApproval
	/** Persist a user-approved command prefix to the host's existing command allowlist settings. */
	persistCommandApprovalPrefix?: (prefix: string) => Promise<boolean>
	say: ToolExecutionSay
	recordToolUsage: (name: string) => void
	pushToolResultToUserContent: (result: Anthropic.ToolResultBlockParam) => boolean
	/** Query existing persisted/staged receipts without mutating the result transaction. */
	hasToolResultForCall?: (callId: string) => boolean
	/** Pure gate; checked before read preparation and immediately before execution. */
	shouldStopRepeatedToolCall?: (name: string, args: unknown) => boolean
	/** Trusted cause for a blocked retry; independent tools keep their normal authority. */
	getToolRetryBlock?: (name: string, args: unknown) => ToolFailureMetadata | undefined
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
	commandResult?: ToolResultMetadata["commandResult"]
	truncated?: boolean
	timedOut?: boolean
	/** Trusted progress-only observation; never verification evidence. */
	trustedExploration?: ToolResultMetadata["trustedExploration"]
	trustedProgress?: ToolResultMetadata["trustedProgress"]
	waitOutcome?: ToolResultMetadata["waitOutcome"]
	opaqueResultFingerprint?: string
	failure?: ToolFailureMetadata
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
	private approvalResult: ToolResponse | undefined
	private feedback?: { text: string; images?: string[] }
	private status: ToolSchedulerResult["status"] = "success"
	private structuredStatus?: ToolResultStatus
	private metadata: ToolResultMetadata = {}
	private truncated = false

	constructor(
		private readonly maxOutputChars: number,
		private readonly statusSource: "handler" | "structured_output",
	) {}

	setApprovalFeedback(feedback: { text: string; images?: string[] }): void {
		this.feedback = feedback
	}

	setStatus(status: ToolSchedulerResult["status"]): void {
		this.status = status
	}

	setMetadata(metadata: ToolResultMetadata): void {
		const { failure, ...rest } = metadata
		const normalizedFailure = normalizeToolFailure(failure)
		this.metadata = {
			...this.metadata,
			...rest,
			...(rest.trustedProgress
				? {
						trustedProgress: Array.isArray(rest.trustedProgress)
							? rest.trustedProgress.slice(0, MAX_TOOL_PROGRESS_OBSERVATIONS).map((item) => ({ ...item }))
							: { ...rest.trustedProgress },
					}
				: {}),
			...(normalizedFailure ? { failure: normalizedFailure } : {}),
		}
	}

	getMetadata(): ToolResultMetadata {
		return this.metadata
	}

	getRemainingOutputChars(): number {
		const feedback = this.feedback ? formatResponse.toolApprovedWithFeedback(this.feedback.text).length + 2 : 0
		const approval = this.approvalResult === undefined ? 0 : getToolResultParts(this.approvalResult).text.length + 2
		return Math.max(0, this.maxOutputChars - feedback - approval)
	}

	// Approval may end one file in a batch after earlier files were committed.
	// Keep its feedback without consuming the tool's final outcome slot.
	pushApprovalResult(content: ToolResponse): void {
		const limited = limitToolResponse(content, this.maxOutputChars)
		this.approvalResult = limited.content
		this.truncated ||= limited.truncated
	}

	push(content: ToolResponse): void {
		if (this.result !== undefined) {
			return
		}

		const structuredStatus =
			this.statusSource === "structured_output" ? getStructuredToolResultStatus(content) : undefined
		this.structuredStatus = structuredStatus

		if (this.feedback) {
			const feedbackText = formatResponse.toolApprovedWithFeedback(this.feedback.text)
			const feedbackImages = this.feedback.images ? formatResponse.imageBlocks(this.feedback.images) : []
			if (typeof content === "string") {
				content = `${feedbackText}\n\n${content || "(tool did not return anything)"}`
			} else {
				content = [{ type: "text", text: feedbackText }, ...feedbackImages, ...content]
			}
		}

		if (this.approvalResult !== undefined) {
			content =
				typeof content === "string" && typeof this.approvalResult === "string"
					? `${this.approvalResult}\n\n${content}`
					: [this.approvalResult, content].flatMap((response) =>
							typeof response === "string" ? [{ type: "text" as const, text: response }] : response,
						)
		}

		const limited = limitToolResponse(content, this.maxOutputChars)
		content = limited.content
		this.truncated ||= limited.truncated

		this.result = content
	}

	getStatus(): ToolSchedulerResult["status"] {
		// Runtime cancellation/denial and handler metadata outrank status-looking
		// result text. Only legacy native results without metadata use the text.
		if (this.status !== "success") return this.status
		return this.metadata.status ?? this.structuredStatus ?? "success"
	}

	getContent(): ToolResponse {
		return this.result ?? this.approvalResult ?? "(tool did not return anything)"
	}

	hasResult(): boolean {
		return this.result !== undefined || this.approvalResult !== undefined
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
	if (canonicalizeToolName(call.name) !== "exec_command") {
		return undefined
	}

	const args: Record<string, unknown> =
		typeof call.arguments === "object" && call.arguments !== null ? (call.arguments as Record<string, unknown>) : {}
	const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : ""
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
	failure?: ToolFailureMetadata
	preparationDenied?: boolean
	readPrepared?: boolean
	read?: PreparedToolRead
	commandRead?: PreparedCommandRead
	/** Approval was settled serially for a captured MCP read-only annotation. */
	mcpApprovalPrepared?: boolean
	mcpReadPrepared?: boolean
	commandCollector?: ToolResultCollector
	commandApproval?: { command: string; response: ToolApprovalResponse }
	preparationResult?: ToolSchedulerResult
	preparationDurationMs?: number
	finalizeCommand?: () => Promise<void>
	usageRecorded?: boolean
	scope?: string
	finalizeRead?: () => Promise<ToolResponse>
	/** The handler returned a terminal result before cancellation, with no read finalizer pending. */
	terminalResultReady?: boolean
	pathIdentities?: ReadonlyArray<{ absolute: string; canonical: string }>
	requiresExplicitApproval?: boolean
	commandPathApproval?: { outsidePaths: string[]; unresolved: boolean }
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
		canonicalizeToolName(toolName) !== "exec_command" ||
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

function trustedProgressForResult(
	metadata: ToolResultMetadata,
	status: ToolSchedulerResult["status"],
): ToolResultMetadata["trustedProgress"] | undefined {
	const observation = metadata.trustedProgress
	if (Array.isArray(observation)) {
		if (observation.length === 0 || observation.length > MAX_TOOL_PROGRESS_OBSERVATIONS) return undefined
		const admitted = observation.flatMap(
			(item) => trustedProgressForResult({ ...metadata, trustedProgress: item }, status) ?? [],
		)
		return admitted.length === observation.length ? admitted : undefined
	}
	if (
		status !== "success" ||
		(metadata.executionStatus ?? metadata.status) !== "success" ||
		!observation ||
		(observation.kind !== "read" && observation.kind !== "mutation") ||
		typeof observation.scope !== "string" ||
		!observation.scope.length ||
		observation.scope.length > 4_096 ||
		!/^[a-f0-9]{64}$/.test(observation.stateFingerprint) ||
		(observation.previousStateFingerprint !== undefined &&
			!/^[a-f0-9]{64}$/.test(observation.previousStateFingerprint))
	)
		return undefined
	return {
		kind: observation.kind,
		scope: observation.scope,
		stateFingerprint: observation.stateFingerprint,
		...(observation.previousStateFingerprint !== undefined
			? { previousStateFingerprint: observation.previousStateFingerprint }
			: {}),
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
	failure?: ToolFailureMetadata,
): ToolSchedulerResult {
	return {
		callId: call.id,
		name: call.name,
		status,
		content: formatFailureResult(message, status),
		failure:
			failure ??
			createToolFailure({
				reason: status === "denied" ? "policy_denied" : "pre_launch_rejected",
				scopeKind: "operation",
				scopeIdentity: [call.name, call.arguments],
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: status === "denied" ? "user-action" : "repair" },
			}),
		durationMs: 0,
	}
}

/** Shared preflight for the host's persistence boundary and the scheduler's effect boundary. */
export function getToolBatchIsolationError(registry: ToolRegistry, toolNames: readonly string[]): string | undefined {
	if (toolNames.length <= 1) return undefined

	const barrier = toolNames.find((name) => {
		const descriptor = registry.resolve(name)
		// A completed wait returns to this task, so the scheduler can fence it in
		// model order. Terminal and user-suspending tools still require a lone call.
		return descriptor?.capabilities.concurrency === "barrier" && descriptor.name !== "wait_agent"
	})
	if (!barrier) return undefined

	return (
		`${barrier} must be called by itself in a message turn. ` +
		"No tools from this turn were executed. Retry with the control-flow tool alone."
	)
}

function getSchedulerToolIdentity(registry: ToolRegistry, name: string): string {
	const canonicalName = registry.canonicalName(name)
	return canonicalName === "exec_command" ? canonicalName : name
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
	if (toolName === "generate_image") {
		candidates.push(argumentsValue.image)
		if (typeof argumentsValue.path === "string") candidates.push(...getImageOutputPaths(argumentsValue.path))
	}

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
	if (toolName === "apply_patch") {
		candidates.push(
			...(extractMutationPaths({
				type: "tool_use",
				name: "apply_patch",
				params: {},
				partial: false,
				nativeArgs: argumentsValue as ToolUse<"apply_patch">["nativeArgs"],
			}) ?? []),
		)
	}

	return candidates
}

// Only tools with native path validation and approval flows may leave a primary root.
const OUTSIDE_WORKSPACE_TOOLS = new Set([
	"read_file",
	"list_files",
	"search_files",
	"write_to_file",
	"apply_diff",
	"apply_patch",
	"edit",
	"edit_file",
	"search_replace",
	"generate_image",
	"exec_command",
])

function assertPathIdentities(prepared: PreparedCall): void {
	for (const { absolute, canonical } of prepared.pathIdentities ?? []) {
		if (path.relative(canonical, resolvePathWithExistingAncestor(absolute)) !== "") {
			throw new ToolReadDeniedError(
				`Path target changed during execution or approval: ${absolute}. Retry with the current path.`,
			)
		}
	}
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
	private approvalAbortRequested = false
	private executionSignal?: AbortSignal
	private approvalRequestCount = 0
	private approvalDeniedCount = 0
	private approvalCancelledCount = 0
	private supersededAskCount = 0
	private parallelToolCount = 0
	private outputTruncatedCount = 0
	private readonly observedToolCallIds = new Set<string>()
	private readonly repetitionSkippedResults = new WeakSet<ToolSchedulerResult>()
	private readonly effectStartedCallIds = new Set<string>()
	private deferredResultCommit?: { calls: AgentToolCall[]; results: ToolSchedulerResult[] }
	private deferredCommitPromise?: Promise<void>
	private readonly deferredCommittedResultIds = new Set<string>()
	private readonly deferredResultEventIds = new Set<string>()
	private readonly deferredVerificationEventIds = new Set<string>()
	private deferredBatchFinishedEvent?: Extract<AgentTurnEvent, { type: "tool_batch_finished" }>

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

	private resolveScopedPath(candidate: string): string {
		const task = this.toolTask as TaskPathContext | undefined
		if (task && typeof task.cwd === "string" && task.cwd.length > 0) {
			return resolveTaskWorkspacePath(task, candidate)
		}
		return path.resolve(this.executionHost.cwd ?? "", candidate)
	}

	private getApprovalWorkingDirectory(nativeArgs: unknown): string | undefined {
		const task = this.toolTask as TaskPathContext
		const taskRoot = this.executionHost.cwd || task.cwd
		if (!taskRoot) return undefined

		const args = nativeArgs && typeof nativeArgs === "object" ? (nativeArgs as Record<string, unknown>) : {}
		const requestedCwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : "."
		const effectiveCwd = path.resolve(taskRoot, requestedCwd)
		const displayCwd = redactTaskPrivatePaths(task, getTaskDisplayPath(task, effectiveCwd))
		return displayCwd.length > 0 && displayCwd.length <= 4_096 ? displayCwd : undefined
	}

	private resolvePolicyPath(toolName: string, candidate: string): string {
		if (toolName === "exec_command") {
			return path.isAbsolute(candidate)
				? path.resolve(candidate)
				: path.resolve(this.executionHost.cwd ?? "", candidate)
		}
		return this.resolveScopedPath(candidate)
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
		if (item?.mcpReadPrepared) {
			return (
				this.executionMode === "selective-parallel" &&
				capabilities?.parallelMcpRead === true &&
				capabilities.concurrency === "serial" &&
				capabilities.sideEffects === "external" &&
				capabilities.requiresApproval &&
				!capabilities.controlFlow &&
				captured?.parallelMcpRead === true &&
				captured.concurrency === "serial" &&
				captured.sideEffects === "external" &&
				captured.requiresApproval &&
				!captured.controlFlow
			)
		}
		if (item?.commandRead) {
			return (
				!item.commandRead.serialFallback &&
				!!item.commandRead.run &&
				this.canPrepareParallelCommand(item) &&
				!!item.scope
			)
		}
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

	private canPrepareParallelCommand(item: PreparedCall): boolean {
		const descriptor = item.descriptor
		return (
			this.executionMode === "selective-parallel" &&
			descriptor?.capabilities.parallelCommandRead === true &&
			!descriptor.capabilities.controlFlow &&
			this.options.policy?.capabilities[descriptor.name]?.parallelCommandRead === true &&
			!this.options.policy.capabilities[descriptor.name].controlFlow &&
			!!descriptor.prepareParallelCommand
		)
	}

	private canPrepareParallelMcpRead(item: PreparedCall): boolean {
		const descriptor = item.descriptor
		const captured = descriptor && this.options.policy?.capabilities[descriptor.name]
		return (
			this.executionMode === "selective-parallel" &&
			descriptor?.capabilities.parallelMcpRead === true &&
			descriptor.capabilities.concurrency === "serial" &&
			descriptor.capabilities.sideEffects === "external" &&
			descriptor.capabilities.requiresApproval &&
			!descriptor.capabilities.controlFlow &&
			captured?.parallelMcpRead === true &&
			captured.concurrency === "serial" &&
			captured.sideEffects === "external" &&
			captured.requiresApproval &&
			!captured.controlFlow
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
		// A repetition skip closes a call without another attempt. Feeding that
		// receipt back as new evidence can reopen the stop that produced it.
		if (!this.executionHost.recordToolCallForStopping || this.repetitionSkippedResults.has(result)) return
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
			const canonicalName = this.options.registry.canonicalName(result.name)
			const legacyReadArguments =
				call.name === "read_command_output" &&
				call.arguments !== null &&
				typeof call.arguments === "object" &&
				!Array.isArray(call.arguments)
			const argumentsForStopping = legacyReadArguments
				? { ...(call.arguments as Record<string, unknown>), action: "read" }
				: call.arguments
			await this.executionHost.recordToolCallForStopping(
				canonicalName,
				argumentsForStopping,
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
		if (this.options.requirePreparedCommandRead && canonicalizeToolName(item.call.name) === "exec_command") {
			if (!this.canPrepareParallelCommand(item)) {
				item.validationError = "The command no longer qualifies for isolated read execution."
				item.preparationDenied = true
				return
			}
			const result = await this.executeCall(item, true)
			item.preparationDurationMs = result.durationMs
			if (result.status !== "success") {
				item.preparationResult = result
				return
			}
			if (!item.commandRead?.run || item.commandRead.serialFallback) {
				item.validationError = "The command did not remain an isolated read after approval."
				item.preparationDenied = true
				return
			}
			item.scope = item.commandRead.scope
			if (!item.scope || !path.isAbsolute(item.scope)) {
				item.validationError = "The isolated command read did not provide a valid workspace scope."
				item.preparationDenied = true
			}
			return
		}
		if (this.canPrepareParallelCommand(item)) {
			const result = await this.executeCall(item, true)
			item.preparationDurationMs = result.durationMs
			if (result.status !== "success") item.preparationResult = result
			if (item.commandRead) item.scope = item.commandRead.scope
			if (!item.scope || !path.isAbsolute(item.scope)) item.scope = undefined
			return
		}
		if (this.canPrepareParallelMcpRead(item)) {
			const result = await this.executeCall(item, false, true)
			item.preparationDurationMs = result.durationMs
			if (result.status !== "success") {
				item.preparationResult = result
				return
			}
			if (!item.mcpApprovalPrepared) {
				item.validationError = "The MCP read-only call did not settle its approval before execution."
				item.preparationDenied = true
				return
			}
			item.mcpReadPrepared = true
			return
		}
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
		const finalizeCommand = item.finalizeCommand
		item.finalizeCommand = undefined
		if (finalizeCommand) {
			try {
				await finalizeCommand()
			} catch (error) {
				if (!this.isCancelled()) {
					this.executionHost.didToolFailInCurrentTurn = true
					return {
						...result,
						status: "error",
						content: formatFailureResult(this.errorMessage(error), "error"),
					}
				}
			}
		}
		const finalize = item.finalizeRead
		item.finalizeRead = undefined
		if (item.read && result.status === "error") this.executionHost.didToolFailInCurrentTurn = true
		// Cancellation can arrive while a sibling is draining. Keep completed
		// results and committed effects; only unfinished read output is discarded.
		if (!finalize && (item.terminalResultReady || item.descriptor?.capabilities.sideEffects !== "none"))
			return result
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
		if (this.deferredResultCommit || this.deferredCommitPromise) {
			throw new Error("ToolScheduler cannot start another batch while deferred results are pending.")
		}
		this.approvalRequestCount = 0
		this.approvalDeniedCount = 0
		this.approvalCancelledCount = 0
		this.supersededAskCount = 0
		this.parallelToolCount = 0
		this.outputTruncatedCount = 0
		this.observedToolCallIds.clear()
		this.effectStartedCallIds.clear()
		this.effectFenceFailure = undefined
		this.approvalAbortRequested = false
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
		const prepared: PreparedCall[] = []
		for (const [index, call] of calls.entries()) prepared.push(await this.prepareCall(call, index))
		if (this.options.deferResultCommit) {
			for (const item of prepared) {
				const descriptor = item.descriptor
				const descriptorCapabilities = descriptor?.capabilities
				const policyCapabilities = descriptor ? this.options.policy?.capabilities[descriptor.name] : undefined
				const auditedCommandReadAdmission =
					this.options.requirePreparedCommandRead === true &&
					item.call.name === "exec_command" &&
					descriptor?.name === "exec_command" &&
					descriptorCapabilities?.parallelCommandRead === true &&
					!descriptorCapabilities.controlFlow &&
					policyCapabilities?.parallelCommandRead === true &&
					!policyCapabilities.controlFlow
				const approvalFreeReadAdmission =
					item.read !== undefined ||
					auditedCommandReadAdmission ||
					(this.options.readGrant?.enabled === true && descriptor?.prepareParallelRead !== undefined)
				const noEffectEarlyResult =
					this.options.requirePreparedCommandRead === true &&
					(item.validationError !== undefined || item.preparationResult !== undefined)
				if (
					!descriptorCapabilities ||
					(!noEffectEarlyResult &&
						((!auditedCommandReadAdmission && descriptorCapabilities.concurrency !== "parallel") ||
							(!auditedCommandReadAdmission && descriptorCapabilities.sideEffects !== "none") ||
							descriptorCapabilities.controlFlow ||
							(descriptorCapabilities.requiresApproval && !approvalFreeReadAdmission) ||
							(policyCapabilities !== undefined &&
								((!auditedCommandReadAdmission && policyCapabilities.concurrency !== "parallel") ||
									(!auditedCommandReadAdmission && policyCapabilities.sideEffects !== "none") ||
									policyCapabilities.controlFlow ||
									(policyCapabilities.requiresApproval && !approvalFreeReadAdmission)))))
				) {
					throw new Error(
						`Deferred tool results require an audited, approval-free read call. ` +
							`Call ${item.call.id} failed admission (early command candidate=${auditedCommandReadAdmission}, ` +
							`no-effect early result=${noEffectEarlyResult}, descriptor=${descriptor?.name ?? "missing"}, ` +
							`captured command-read capability=${policyCapabilities?.parallelCommandRead === true}).`,
					)
				}
			}
		}
		const results = new Array<ToolSchedulerResult | undefined>(prepared.length)

		if (prepared.length === 0) {
			return this.metrics("completed", [], calls.length, 0, startedAt)
		}

		await this.options.onEvent?.({ type: "tool_batch_started", batchSize: calls.length })

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
			// Preflight and retry-block receipts also carry stopping evidence. Observe
			// them before admitting the next call; executed results are deduplicated.
			if (!this.options.deferResultCommit && cursor > 0 && results[cursor - 1]) {
				try {
					await this.observeToolResult(results[cursor - 1]!, calls[cursor - 1])
				} catch (error) {
					if (!(error instanceof ToolEffectFenceError)) throw error
					return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
				}
			}

			const item = prepared[cursor]
			if (item.preparationResult) {
				results[item.index] = item.preparationResult
				cursor++
				continue
			}
			const retryBlock = this.retryBlockResult(item.call)
			if (retryBlock) {
				results[item.index] = retryBlock
				cursor += 1
				continue
			}
			if (item.validationError || !item.descriptor || !item.toolCall) {
				results[item.index] = resultForError(
					item.call,
					item.validationError ?? "Tool call could not be prepared.",
					item.preparationDenied ? "denied" : "error",
					item.failure,
				)
				cursor += 1
				continue
			}
			if (
				this.executionHost.shouldStopRepeatedToolCall?.(
					getSchedulerToolIdentity(this.options.registry, item.call.name),
					item.toolCall?.nativeArgs ?? item.call.arguments,
				)
			) {
				const result = resultForError(
					item.call,
					`Stopping repeated ${item.call.name} call; use existing evidence or change the approach.`,
				)
				this.repetitionSkippedResults.add(result)
				results[item.index] = result
				cursor += 1
				continue
			}
			try {
				await this.prepareRead(item)
			} catch (error) {
				if (!(error instanceof ToolEffectFenceError)) throw error
				return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
			}
			if (item.preparationResult) continue
			if (item.validationError) {
				results[item.index] = resultForError(
					item.call,
					item.validationError,
					item.preparationDenied ? "denied" : "error",
					item.failure,
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
						candidate.preparationResult ||
						!candidate.descriptor ||
						!candidate.toolCall ||
						!this.isSelectableParallel(candidate) ||
						parallelItems.some((active) => {
							const independentPreparedReads =
								(active.commandRead && candidate.commandRead) ||
								(active.mcpReadPrepared && candidate.mcpReadPrepared)
							return (
								!independentPreparedReads &&
								!!active.scope &&
								!!candidate.scope &&
								scopesOverlap(active.scope, candidate.scope)
							)
						})
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
						if (!this.options.deferResultCommit) {
							await this.observeToolResult(results[readItem.index]!, readItem.call)
						}
					}
				} catch (error) {
					if (!(error instanceof ToolEffectFenceError)) throw error
					return this.failedOutcome(results, calls, error, calls.length, parallelBatchCount, startedAt)
				}
				continue
			}

			// Serial calls, including lifecycle barriers, are exclusive ordered fences:
			// the preceding parallel window has settled above, and this await prevents
			// any later call from starting until the current call has returned.
			try {
				const result = await this.executeCall(item)
				item.terminalResultReady = !item.finalizeRead && result.status !== "cancelled"
				results[item.index] = await this.finalizeRead(item, result)
				if (!this.options.deferResultCommit && !this.isCancelled()) {
					await this.observeToolResult(results[item.index]!, item.call)
				}
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
					const result = await this.executeCall(item)
					item.terminalResultReady = !item.finalizeRead && result.status !== "cancelled"
					results[index] = result
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
		const effectMayHaveStarted = this.effectStartedCallIds.has(sanitizeToolUseId(call.id))
		return {
			callId: call.id,
			name: call.name,
			status: "cancelled",
			content: formatFailureResult(
				effectMayHaveStarted
					? "Tool execution was cancelled after it may have started. Its outcome is unknown; verify the current state before retrying."
					: "Tool execution was cancelled before it started.",
				"cancelled",
			),
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
		if (this.options.deferResultCommit) {
			this.retainDeferredResults(calls, completeResults)
		} else if (this.options.preserveAbortedResults) {
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
		await this.emitBatchFinished(outcome)
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
		// results. A pre-EOF read lane holds them until its assistant boundary commits.
		if (this.options.deferResultCommit) {
			this.retainDeferredResults(calls, completeResults)
		} else {
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
		}
		if (!this.options.deferResultCommit) this.executionHost.userMessageContentReady = true

		const outcome: ToolSchedulerOutcome = {
			...this.metrics("failed", completeResults, batchSize, parallelBatchCount, startedAt),
			failure: {
				kind: "effect_fence",
				callId: failure.call.id,
				message: failure.message,
			},
		}
		await this.emitBatchFinished(outcome)
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

	private async prepareCall(call: AgentToolCall, index: number): Promise<PreparedCall> {
		const prepared: PreparedCall = { index, call }
		const reject = (
			reason: ToolFailureMetadata["reason"],
			scopeKind: ToolFailureMetadata["affectedScope"]["kind"] = "operation",
		) => {
			prepared.failure = createToolFailure({
				reason,
				scopeKind,
				scopeIdentity:
					scopeKind === "operation"
						? [call.name, call.arguments]
						: [call.name, this.executionHost.cwd, this.options.policy],
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: reason === "policy_denied" ? "user-action" : "repair" },
			})
		}

		if (typeof call.id !== "string" || typeof call.name !== "string" || !call.id || !call.name) {
			prepared.validationError = "Tool call is missing a valid ID or name."
			reject("invalid_arguments")
			return prepared
		}

		let descriptor = this.options.registry.resolve(call.name)
		if (!descriptor) {
			prepared.validationError = `Unknown tool "${call.name}". This tool is not registered.`
			reject("capability_unavailable", "capability")
			return prepared
		}

		let canonicalName = this.options.registry.canonicalName(call.name)
		if (!isToolAllowed(this.options.policy, canonicalName)) {
			prepared.validationError = `Tool "${call.name}" is not allowed by the current step policy.`
			reject("policy_denied", "capability")
			prepared.descriptor = descriptor
			return prepared
		}

		const rawArgumentsValue = call.arguments === undefined ? {} : call.arguments
		if (rawArgumentsValue === null || typeof rawArgumentsValue !== "object" || Array.isArray(rawArgumentsValue)) {
			prepared.validationError = `Invalid arguments for tool "${call.name}".`
			reject("invalid_arguments")
			prepared.descriptor = descriptor
			return prepared
		}
		const rawArguments = rawArgumentsValue as Record<string, unknown>
		const mergedArguments =
			canonicalName === "manage_command" && call.name === "read_command_output"
				? { ...rawArguments, action: "read" }
				: rawArguments
		let argumentsValue: Record<string, unknown>
		try {
			argumentsValue = normalizeTaskToolArguments(
				this.toolTask as TaskPathContext,
				canonicalName,
				mergedArguments,
			)
		} catch (error) {
			prepared.validationError = this.errorMessage(error)
			reject("invalid_arguments")
			prepared.descriptor = descriptor
			return prepared
		}
		const requestedArgumentsValue = argumentsValue
		const requestedCanonicalName = canonicalName
		if (canonicalName === "exec_command" && typeof argumentsValue.command === "string") {
			const command = unescapeHtmlEntities(argumentsValue.command)
			if (isCommandDeniedByPolicy(this.options.policy, command)) {
				prepared.validationError = "This command is denied by the current execution policy."
				prepared.preparationDenied = true
				reject("policy_denied", "capability")
				prepared.descriptor = descriptor
				return prepared
			}

			const invocation = extractApplyPatchCommand(command)
			if (invocation) {
				if (invocation.kind === "error") {
					prepared.validationError = invocation.message
					reject("invalid_arguments")
					prepared.descriptor = descriptor
					return prepared
				}
				const patchDescriptor = this.options.registry.resolve("apply_patch")
				if (!patchDescriptor) {
					prepared.validationError = "The apply_patch tool is not registered."
					reject("capability_unavailable", "capability")
					prepared.descriptor = descriptor
					return prepared
				}
				if (!isToolAllowed(this.options.policy, "apply_patch")) {
					prepared.validationError = 'Tool "apply_patch" is not allowed by the current step policy.'
					reject("policy_denied", "capability")
					prepared.descriptor = descriptor
					return prepared
				}
				const taskRoot = this.executionHost.cwd ?? (this.toolTask as TaskPathContext).cwd
				const commandCwd = path.resolve(
					taskRoot,
					typeof argumentsValue.cwd === "string" ? argumentsValue.cwd : ".",
					invocation.workdir ?? ".",
				)
				argumentsValue = normalizeTaskToolArguments(this.toolTask as TaskPathContext, "apply_patch", {
					patch: rebaseApplyPatchPaths(invocation.patch, taskRoot, commandCwd),
				})
				canonicalName = "apply_patch"
				descriptor = patchDescriptor
			}
		}
		if (canonicalName === "apply_patch") {
			const denial = this.options.task?.getTaskToolDenialReason?.("apply_patch", argumentsValue)
			if (denial) {
				prepared.validationError = denial
				prepared.preparationDenied = true
				reject("policy_denied", "workspace")
				prepared.descriptor = descriptor
				return prepared
			}
		}

		let pathArguments: string[]
		try {
			pathArguments = getPathArguments(canonicalName, argumentsValue).filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			)
		} catch (error) {
			prepared.validationError = this.errorMessage(error)
			reject("invalid_arguments")
			prepared.descriptor = descriptor
			return prepared
		}
		const outsideAccess =
			this.options.policy?.execution.outsideWorkspace === "approval" && OUTSIDE_WORKSPACE_TOOLS.has(canonicalName)
		if (canonicalName === "exec_command") {
			const args = argumentsValue
			if (typeof args.command === "string") {
				const taskRoot = this.executionHost.cwd ?? ""
				const roots = this.options.policy?.execution.workspaceRoots
				const commandCwd = path.resolve(taskRoot, typeof args.cwd === "string" ? args.cwd : ".")
				const scope = assessCommandPaths(
					unescapeHtmlEntities(args.command),
					commandCwd,
					roots?.length ? roots : [taskRoot],
				)
				pathArguments.push(...scope.writePaths)
				const outsidePaths = !isPathAllowed(this.options.policy, commandCwd, taskRoot)
					? [...new Set([commandCwd, ...scope.outsidePaths])]
					: scope.outsidePaths
				if (outsidePaths.length || scope.unresolvedWrite) {
					prepared.commandPathApproval = {
						outsidePaths,
						unresolved: scope.unresolvedWrite,
					}
					if (this.options.policy && !outsideAccess) {
						prepared.validationError = "Command paths exceed the task scope or could not be resolved."
						reject("policy_denied", "workspace")
						prepared.descriptor = descriptor
						return prepared
					}
				}
			}
		}
		prepared.requiresExplicitApproval =
			!!prepared.commandPathApproval ||
			(canonicalName !== "exec_command" &&
				outsideAccess &&
				descriptor.capabilities.sideEffects !== "none" &&
				pathArguments.some(
					(candidate) =>
						!isPathAllowed(
							this.options.policy,
							this.resolvePolicyPath(canonicalName, candidate),
							this.executionHost.cwd,
						),
				))
		prepared.pathIdentities = pathArguments.map((candidate) => {
			const absolute = this.resolvePolicyPath(canonicalName, candidate)
			return { absolute, canonical: resolvePathWithExistingAncestor(absolute) }
		})
		for (const candidate of pathArguments) {
			if (
				!outsideAccess &&
				!isPathAllowed(
					this.options.policy,
					this.resolvePolicyPath(canonicalName, candidate),
					this.executionHost.cwd ?? "",
				) &&
				!(
					canonicalName === "read_file" &&
					(await isBundledSkillResource(this.options.bundledSkillExtensionPath, candidate))
				)
			) {
				prepared.validationError = `Path argument "${candidate}" is outside the allowed workspace roots.`
				reject("policy_denied", "workspace")
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
		const interceptedPatch = requestedCanonicalName === "exec_command" && canonicalName === "apply_patch"

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
				if (interceptedPatch) {
					this.options.validateCall(call, {
						...toolCall,
						name: requestedCanonicalName,
						nativeArgs: requestedArgumentsValue,
					})
				}
				this.options.validateCall(
					interceptedPatch ? { ...call, name: canonicalName, arguments: argumentsValue } : call,
					toolCall,
				)
			} else {
				if (interceptedPatch) {
					validateToolUse(
						call.name as never,
						this.options.mode,
						this.options.customModes,
						disabledRequirements,
						requestedArgumentsValue,
						this.options.experiments,
						this.options.includedTools,
					)
				}
				validateToolUse(
					(canonicalName === "apply_patch" ? canonicalName : call.name) as never,
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
			reject("policy_denied", "capability")
		}

		prepared.descriptor = descriptor
		prepared.toolCall = toolCall
		return prepared
	}

	private async executeCall(
		prepared: PreparedCall,
		prepareCommand = false,
		prepareMcpRead = false,
	): Promise<ToolSchedulerResult> {
		const startedAt = performance.now()
		if (this.isCancelled()) {
			return this.cancelledResultFor(prepared.call)
		}
		const retryBlock = this.retryBlockResult(prepared.call)
		if (retryBlock) return retryBlock

		const collector =
			prepared.commandCollector ??
			new ToolResultCollector(
				Math.min(
					prepared.descriptor?.maxOutputChars ?? Number.MAX_SAFE_INTEGER,
					getToolOutputLimit(this.options.policy, prepared.descriptor?.name ?? prepared.call.name),
				),
				prepared.descriptor?.statusSource ?? "structured_output",
			)
		const interceptedPatch =
			prepared.toolCall?.name === "apply_patch" &&
			this.options.registry.canonicalName(prepared.call.name) === "exec_command"
		const approvalToolName = interceptedPatch
			? "apply_patch"
			: this.options.registry.canonicalName(prepared.call.name)
		const approvalArguments = interceptedPatch ? prepared.toolCall?.nativeArgs : prepared.call.arguments
		const startsAuditedCommandRead =
			!prepareCommand && prepared.commandRead?.serialFallback !== true && prepared.commandRead?.run !== undefined
		const requiresEffectStart =
			startsAuditedCommandRead ||
			(!prepareCommand &&
				prepared.descriptor?.capabilities.sideEffects !== undefined &&
				prepared.descriptor.capabilities.sideEffects !== "none" &&
				(!prepared.commandRead || prepared.commandRead.serialFallback))
		const callId = sanitizeToolUseId(prepared.call.id)
		const startEffect = async (): Promise<boolean> => {
			if (!requiresEffectStart) return true
			if (this.effectStartedCallIds.has(callId)) return true
			if (this.isCancelled()) return false
			try {
				await this.options.onEffectStart?.(prepared.call)
				this.effectStartedCallIds.add(callId)
				return !this.isCancelled()
			} catch (error) {
				const failure =
					error instanceof ToolEffectFenceError ? error : new ToolEffectFenceError(prepared.call, error)
				this.effectFenceFailure ??= failure
				this.batchController.abort(failure)
				throw failure
			}
		}
		let executionAdmitted = false
		const recordExecutionFailure = (status: "error" | "denied" | "cancelled") => {
			if (collector.getMetadata().failure) return
			const effectsUnknown =
				executionAdmitted &&
				!prepareCommand &&
				(!prepared.commandRead || prepared.commandRead.serialFallback) &&
				prepared.descriptor?.capabilities.sideEffects !== "none" &&
				status !== "denied"
			collector.setMetadata({
				failure: createToolFailure({
					reason: effectsUnknown
						? "outcome_unknown"
						: status === "cancelled"
							? "cancelled"
							: status === "denied"
								? "policy_denied"
								: "execution_failed",
					scopeKind: "operation",
					scopeIdentity: [this.options.registry.canonicalName(prepared.call.name), prepared.call.arguments],
					effectsStarted: effectsUnknown ? "unknown" : "no",
					outcome: effectsUnknown ? "unknown" : "known",
					recovery: { kind: effectsUnknown ? "verify-outcome" : "repair" },
				}),
			})
		}
		const approvalFeedback = (text: string, images?: string[]) => collector.setApprovalFeedback({ text, images })
		const approvalFailure = (decision: "denied" | "cancelled") =>
			collector.setMetadata({
				failure: createToolFailure({
					reason: decision === "denied" ? "approval_denied" : "cancelled",
					scopeKind: "operation",
					scopeIdentity: [prepared.call.name, prepared.call.arguments],
					effectsStarted: "no",
					outcome: "known",
					recovery: { kind: "user-action" },
				}),
			})
		const recordApprovalCancellation = async (
			requestId: string,
			reason: string,
			options: { timedOut?: boolean; abortBatch?: boolean } = {},
		) => {
			collector.setStatus("cancelled")
			if (options.timedOut) collector.setMetadata({ timedOut: true })
			approvalFailure("cancelled")
			collector.pushApprovalResult(formatFailureResult(reason, "cancelled"))
			this.approvalCancelledCount += 1
			if (options.abortBatch) {
				this.approvalAbortRequested = true
				this.batchController.abort(new Error(reason))
			}
			await this.options.onEvent?.({ type: "approval_result", requestId, decision: "cancelled", reason })
		}
		const requestApproval = async (
			args: Parameters<ToolCallbacks["askApproval"]>,
			responseMode: "boolean" | "structured",
		): Promise<ToolApprovalResponse | undefined> =>
			this.approvalMutex.run(async () => {
				const [type] = args
				if (prepared.mcpReadPrepared && type === "use_mcp_server" && responseMode === "boolean") {
					if (this.isCancelled()) return undefined
					return (await startEffect()) ? { response: "yesButtonClicked" } : undefined
				}
				if (this.isSelectableParallel(prepared)) {
					throw new ToolReadDeniedError("An approval request cannot run in an approval-free parallel lane.")
				}
				const [, partialMessage, originalProgressStatus, forceApproval, callRequiresExplicit] = args
				const progressStatus =
					type === "command" && prepared.commandPathApproval
						? { ...originalProgressStatus, commandPathApproval: prepared.commandPathApproval }
						: originalProgressStatus
				assertPathIdentities(prepared)
				if (
					!prepareCommand &&
					prepared.commandRead?.serialFallback &&
					type === "command" &&
					prepared.commandApproval &&
					prepared.commandApproval.command === partialMessage
				) {
					return prepared.commandApproval.response
				}
				const explicitApproval: [boolean] | [] =
					prepared.requiresExplicitApproval || callRequiresExplicit === true ? [true] : []
				const requiresExplicitApproval = explicitApproval.length > 0
				// Provider call IDs can repeat across turns; a typed approval needs a fresh
				// correlation ID while task and call identity remain explicit fields.
				const requestId = randomUUID()
				this.approvalRequestCount += 1
				const typedApprovalHost =
					responseMode === "boolean"
						? this.executionHost.requestToolApproval?.bind(this.executionHost)
						: undefined
				const approvalSessionKey =
					typedApprovalHost && !requiresExplicitApproval && forceApproval !== true
						? createTaskSessionApprovalKey({
								taskId: this.executionHost.taskId,
								toolName: approvalToolName,
								askType: type,
								description: partialMessage,
								argumentsValue: approvalArguments,
								cwd: this.executionHost.cwd,
								policyDigest: this.options.policy?.digest,
							})
						: undefined
				const proposedAmendment: ToolApprovalRequest["proposedAmendment"] =
					typedApprovalHost &&
					approvalSessionKey &&
					!requiresExplicitApproval &&
					forceApproval !== true &&
					type === "command" &&
					!prepared.commandPathApproval &&
					partialMessage &&
					partialMessage.length <= 4096
						? { kind: "exact_command", command: partialMessage }
						: undefined
				const proposedPersistentAmendment =
					typedApprovalHost &&
					this.executionHost.taskKind === "primary" &&
					type === "command" &&
					typeof this.executionHost.persistCommandApprovalPrefix === "function" &&
					!requiresExplicitApproval &&
					forceApproval !== true &&
					!prepared.commandPathApproval &&
					this.executionHost.cwd !== undefined &&
					redactTaskPrivatePaths(this.toolTask as TaskPathContext, partialMessage ?? "") === partialMessage
						? createPersistentCommandPrefixAmendment(partialMessage)
						: undefined
				const availableDecisions: ToolApprovalRequest["availableDecisions"] = [
					"approve_once",
					...(approvalSessionKey && !proposedAmendment ? ["approve_session" as const] : []),
					...(proposedAmendment ? ["approve_with_amendment" as const] : []),
					...(proposedPersistentAmendment ? ["approve_persistently" as const] : []),
					"deny",
					"abort",
				]
				const approvalWorkingDirectory =
					type === "command" ? this.getApprovalWorkingDirectory(prepared.toolCall?.nativeArgs) : undefined
				const description = describeToolApproval(approvalToolName, type, partialMessage)
				const approvalRequest = typedApprovalHost
					? toolApprovalRequestSchema.parse({
							requestId,
							taskId: this.executionHost.taskId,
							callId: prepared.call.id,
							toolName: approvalToolName,
							askType: type,
							...(description === undefined ? {} : { description }),
							...(approvalWorkingDirectory === undefined ? {} : { cwd: approvalWorkingDirectory }),
							forceApproval: forceApproval === true,
							requiresExplicitApproval,
							...(prepared.commandPathApproval
								? { commandPathApproval: prepared.commandPathApproval }
								: {}),
							availableDecisions,
							...(proposedAmendment ? { proposedAmendment } : {}),
							...(proposedPersistentAmendment ? { proposedPersistentAmendment } : {}),
						})
					: undefined

				if (this.isCancelled()) {
					this.approvalCancelledCount += 1
					collector.setStatus("cancelled")
					collector.pushApprovalResult(formatFailureResult("Tool execution was cancelled.", "cancelled"))
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
					toolName: interceptedPatch ? approvalToolName : prepared.call.name,
				})
				if (typedApprovalHost && approvalSessionKey && hasTaskSessionApproval(approvalSessionKey)) {
					await this.options.onEvent?.({
						type: "approval_result",
						requestId,
						decision: "approved",
						reason: "Approved by an exact task-session grant.",
					})
					return (await startEffect()) ? { response: "yesButtonClicked" } : undefined
				}

				let approval: ToolApprovalResponse | undefined
				let typedDecision: ToolApprovalDecision | undefined
				let approvalEventReason: string | undefined
				try {
					if (typedApprovalHost && approvalRequest) {
						const response = await this.raceCancellation(() =>
							typedApprovalHost(approvalRequest, partialMessage),
						)
						if (response !== undefined) {
							const parsed = toolApprovalDecisionSchema.safeParse(response)
							if (!parsed.success) throw new Error("Tool approval host returned an invalid decision.")
							typedDecision = parsed.data
						}
					} else {
						approval = await this.raceCancellation(async () => {
							if (this.executionHost.askApproval) {
								return this.executionHost.askApproval(
									type,
									partialMessage,
									progressStatus,
									forceApproval || false,
									...explicitApproval,
								)
							}
							if (this.executionHost.ask) {
								return this.executionHost.ask(
									type,
									partialMessage,
									false,
									progressStatus,
									forceApproval || false,
									...explicitApproval,
								)
							}
							throw new Error("Tool execution host does not provide an approval callback.")
						})
					}
					assertPathIdentities(prepared)
				} catch (error) {
					if (error instanceof AskIgnoredError) {
						this.supersededAskCount += 1
						this.approvalCancelledCount += 1
						const status = this.isCancelled() ? "cancelled" : "error"
						collector.setStatus(status)
						collector.pushApprovalResult(
							formatFailureResult(`Approval request was superseded: ${error.message}`, status),
						)
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

				// A host can settle the prompt in the same turn that task cancellation
				// arrives. Cancellation wins over a late denial (and approval), so a
				// stopped tool never reports the user's choice as the terminal outcome.
				if (this.isCancelled()) {
					await recordApprovalCancellation(requestId, "Approval was cancelled while waiting for a decision.")
					return undefined
				}

				if (typedDecision) {
					if (
						typedDecision.decision === "approve_session" &&
						!approvalRequest?.availableDecisions.includes("approve_session")
					) {
						throw new Error("Tool approval host selected an unavailable session grant.")
					}
					if (
						typedDecision.decision === "approve_with_amendment" &&
						(!approvalRequest?.availableDecisions.includes("approve_with_amendment") ||
							approvalRequest.askType !== "command" ||
							typedDecision.amendment.kind !== "exact_command" ||
							typedDecision.amendment.command !== approvalRequest.proposedAmendment?.command)
					) {
						throw new Error("Tool approval host selected an unavailable or mismatched policy amendment.")
					}
					if (
						typedDecision.decision === "approve_persistently" &&
						(!approvalRequest?.availableDecisions.includes("approve_persistently") ||
							approvalRequest.askType !== "command" ||
							typedDecision.amendment.kind !== "command_prefix" ||
							typedDecision.amendment.prefix !== approvalRequest.proposedPersistentAmendment?.prefix ||
							!this.executionHost.persistCommandApprovalPrefix ||
							this.executionHost.taskKind !== "primary")
					) {
						throw new Error(
							"Tool approval host selected an unavailable or mismatched persistent command rule.",
						)
					}

					if (typedDecision.decision === "deny") {
						const feedback = typedDecision.feedback
						if (feedback) {
							await this.executionHost.say("user_feedback", feedback)
							collector.pushApprovalResult(
								formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(feedback)),
							)
						} else {
							collector.pushApprovalResult(formatResponse.toolDenied())
						}
						collector.setStatus("denied")
						approvalFailure("denied")
						this.approvalDeniedCount += 1
						await this.options.onEvent?.({
							type: "approval_result",
							requestId,
							decision: "denied",
							reason: feedback,
						})
						return undefined
					}

					if (typedDecision.decision === "abort") {
						await recordApprovalCancellation(requestId, "Approval was aborted by the user.", {
							abortBatch: true,
						})
						return undefined
					}

					if (typedDecision.decision === "timeout") {
						await recordApprovalCancellation(requestId, "Approval request timed out.", { timedOut: true })
						return undefined
					}

					if (
						typedDecision.decision === "approve_with_amendment" &&
						(!approvalSessionKey || !approvalRequest?.proposedAmendment)
					) {
						throw new Error("Tool approval host selected an unavailable exact-command session grant.")
					}
					if (
						typedDecision.decision === "approve_persistently" &&
						(!approvalRequest?.proposedPersistentAmendment ||
							!this.executionHost.persistCommandApprovalPrefix)
					) {
						throw new Error("Tool approval host selected an unavailable persistent command rule.")
					}
					if (typedDecision.decision === "approve_persistently") {
						if (this.isCancelled()) {
							await recordApprovalCancellation(
								requestId,
								"Approval was cancelled before its persistent command rule was saved.",
							)
							return undefined
						}
						const saved = await this.executionHost.persistCommandApprovalPrefix!(
							typedDecision.amendment.prefix,
						)
						if (!saved) throw new Error("Persistent command approval rule could not be saved.")
					}
					if (
						(typedDecision.decision === "approve_session" ||
							typedDecision.decision === "approve_with_amendment") &&
						approvalSessionKey
					) {
						if (this.isCancelled()) {
							await recordApprovalCancellation(
								requestId,
								"Approval was cancelled before its session grant was saved.",
							)
							return undefined
						}
						if (
							!grantTaskSessionApproval(
								approvalSessionKey,
								this.executionHost.taskId,
								this.executionSignal!,
							)
						) {
							if (this.isCancelled()) {
								await recordApprovalCancellation(
									requestId,
									"Approval was cancelled before its session grant was saved.",
								)
								return undefined
							}
							throw new Error("Tool approval session grant could not be recorded.")
						}
					}
					approval = { response: "yesButtonClicked" }
					approvalEventReason =
						typedDecision.decision === "approve_session"
							? "Approved for this exact request in the task session."
							: typedDecision.decision === "approve_with_amendment"
								? "Approved for this exact command and request in the task session."
								: typedDecision.decision === "approve_persistently"
									? "Approved and saved the command prefix to the persistent allowlist."
									: undefined
				}

				if (!approval) {
					this.approvalCancelledCount += 1
					collector.setStatus("cancelled")
					collector.pushApprovalResult(formatFailureResult("Tool execution was cancelled.", "cancelled"))
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
						approvalFailure(decision)
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
						collector.pushApprovalResult(formatFailureResult("Tool execution was cancelled.", "cancelled"))
						return undefined
					}
					if (decision === "approved" && !(await startEffect())) return undefined
					return approval
				}

				if (response !== "yesButtonClicked") {
					const decision = response === "noButtonClicked" || text ? "denied" : "cancelled"
					if (text) {
						await this.executionHost.say("user_feedback", text, images)
						collector.pushApprovalResult(
							formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images),
						)
					} else if (decision === "denied") {
						collector.pushApprovalResult(formatResponse.toolDenied())
					} else {
						collector.pushApprovalResult(formatFailureResult("Tool execution was cancelled.", "cancelled"))
					}
					collector.setStatus(decision)
					approvalFailure(decision)
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
				await this.options.onEvent?.({
					type: "approval_result",
					requestId,
					decision: "approved",
					...(approvalEventReason ? { reason: approvalEventReason } : {}),
				})
				if (prepareCommand && type === "command" && partialMessage) {
					prepared.commandApproval = { command: partialMessage, response: approval }
				}
				if (!(await startEffect())) return undefined
				if (this.effectFenceFailure) throw this.effectFenceFailure
				return approval
			})

		const callbacks: ToolCallbacks = {
			askApproval: async (...args: Parameters<ToolCallbacks["askApproval"]>) => {
				const approval = await requestApproval(args, "boolean")
				const approved = approval?.response === "yesButtonClicked"
				if (prepareMcpRead && args[0] === "use_mcp_server" && approved) {
					prepared.mcpApprovalPrepared = true
				}
				// Settle through the canonical approval path, then stop this legacy
				// handler before dispatch. The approved call is replayed only after the
				// complete serial preflight for its parallel batch.
				return prepareMcpRead ? false : approved
			},
			askApprovalResponse: async (...args: Parameters<NonNullable<ToolCallbacks["askApprovalResponse"]>>) =>
				requestApproval(args, "structured"),
			handleError: async (action: string, error: Error) => {
				if (error instanceof ToolEffectFenceError) throw error
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
				recordExecutionFailure(cancelled ? "cancelled" : "error")
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
				if (cancelled) {
					collector.push(formatFailureResult("Tool execution was cancelled.", "cancelled"))
				} else {
					await this.executionHost.say("error", `Error ${action}:\n${error.message}`)
					collector.push(formatResponse.toolError(errorString))
				}
			},
			pushToolResult: (content: ToolResponse) => collector.push(content),
			getRemainingOutputChars: () => collector.getRemainingOutputChars(),
			setResultMetadata: (metadata: ToolResultMetadata) => collector.setMetadata(metadata),
			toolCallId: prepared.call.id,
			signal: this.executionSignal,
			resolveCommandTimeoutMs: (requestedTimeoutMs, command) =>
				resolveCommandTimeoutMs(this.options.policy, requestedTimeoutMs ?? 0, command),
		}

		try {
			if (
				this.executionHost.shouldStopRepeatedToolCall?.(
					getSchedulerToolIdentity(this.options.registry, prepared.call.name),
					prepared.toolCall?.nativeArgs ?? prepared.toolCall?.params,
				)
			) {
				collector.setStatus("error")
				collector.push(
					formatResponse.toolError(
						`Stopping repeated ${prepared.call.name} call; use existing evidence or change the approach.`,
					),
				)
				const result: ToolSchedulerResult = {
					callId: prepared.call.id,
					name: prepared.call.name,
					status: "error",
					content: collector.getContent(),
					durationMs: Math.max(0, performance.now() - startedAt),
				}
				this.repetitionSkippedResults.add(result)
				return result
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
				assertPathIdentities(prepared)
				if (
					requiresEffectStart &&
					(prepared.descriptor!.capabilities.requiresApproval !== true || startsAuditedCommandRead) &&
					!(await startEffect())
				)
					return
				if (!prepared.usageRecorded) {
					this.executionHost.recordToolUsage(
						getSchedulerToolIdentity(this.options.registry, prepared.call.name),
					)
					prepared.usageRecorded = true
				}
				executionAdmitted = true
				execution = prepareCommand
					? prepared.descriptor!.prepareParallelCommand!(
							{
								task: this.toolTask,
								call: prepared.toolCall!,
								signal: this.executionSignal,
								callbacks,
							},
							this.options.policy!,
						).then((read) => {
							prepared.commandRead = read
							if (read) prepared.commandCollector = collector
						})
					: prepared.commandRead?.run && !prepared.commandRead.serialFallback
						? prepared.commandRead.run(callbacks).then((finalize) => {
								prepared.finalizeCommand = finalize
							})
						: prepared.read
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
			if (this.effectFenceFailure?.call.id === prepared.call.id) throw this.effectFenceFailure
		} catch (error) {
			if (error instanceof ToolEffectFenceError) throw error
			const cancelled = this.isCancelled()
			const status = cancelled ? "cancelled" : error instanceof ToolReadDeniedError ? "denied" : "error"
			collector.setStatus(status)
			recordExecutionFailure(status)
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
		const admittedProgress = trustedProgressForResult(metadata, status)
		const trustedProgress = collector.isTruncated() ? undefined : admittedProgress
		let opaqueResultFingerprint =
			status === "success" &&
			(metadata.executionStatus ?? metadata.status) === "success" &&
			typeof metadata.opaqueResultFingerprint === "string" &&
			/^[a-f0-9]{64}$/.test(metadata.opaqueResultFingerprint)
				? metadata.opaqueResultFingerprint
				: undefined
		if (collector.isTruncated() && (admittedProgress || opaqueResultFingerprint)) {
			// A host observation may cover content the output policy removed. Retain only
			// uncertainty about the delivered exchange, never progress from unseen state.
			opaqueResultFingerprint = createHash("sha256")
				.update(stringify([prepared.call.name, prepared.call.arguments, collector.getContent()]) ?? "")
				.digest("hex")
		}
		const waitOutcome =
			prepared.call.name === "wait_agent" &&
			status === "success" &&
			executionStatus === "success" &&
			(metadata.waitOutcome === "active" || metadata.waitOutcome === "idle")
				? metadata.waitOutcome
				: undefined
		const rawContent = collector.getContent()
		const effectMayHaveStarted = this.effectStartedCallIds.has(callId)
		const effectOutcomeUnknown =
			effectMayHaveStarted && (status === "cancelled" || metadata.failure?.outcome === "unknown")
		const content = effectOutcomeUnknown
			? (() => {
					const parts = getToolResultParts(rawContent)
					const text = `${parts.text}\n\nThe tool effect may have started, but its outcome is unknown. Verify the current state before retrying.`
					return parts.images.length > 0 ? ([{ type: "text", text }, ...parts.images] as ToolResponse) : text
				})()
			: rawContent
		return {
			callId: prepared.call.id,
			name: prepared.call.name,
			status,
			content,
			executionStatus,
			exitCode: metadata.exitCode,
			...(metadata.commandResult ? { commandResult: metadata.commandResult } : {}),
			truncated: collector.isTruncated(),
			timedOut: metadata.timedOut,
			...(trustedExploration ? { trustedExploration } : {}),
			...(trustedProgress ? { trustedProgress } : {}),
			...(waitOutcome ? { waitOutcome } : {}),
			...(opaqueResultFingerprint ? { opaqueResultFingerprint } : {}),
			...(status !== "success" && metadata.failure ? { failure: metadata.failure } : {}),
			durationMs:
				Math.max(0, performance.now() - startedAt) +
				(prepareCommand ? 0 : (prepared.preparationDurationMs ?? 0)),
		}
	}

	private async commitResults(
		results: Array<ToolSchedulerResult | undefined>,
		calls: AgentToolCall[],
		batchSize: number,
		parallelBatchCount: number,
		startedAt: number,
	): Promise<ToolSchedulerOutcome> {
		if (this.options.deferResultCommit) {
			const completeResults = calls.map(
				(call, index) => results[index] ?? resultForError(call, "Tool execution did not produce a result."),
			)
			this.retainDeferredResults(calls, completeResults)
			const outcome = this.metrics("completed", completeResults, batchSize, parallelBatchCount, startedAt)
			await this.emitBatchFinished(outcome)
			return outcome
		}
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
		await this.emitBatchFinished(outcome)
		return outcome
	}

	/** Commit held results after the host has made the assistant response durable. */
	async commitDeferredResults(options: { deferBatchFinished?: boolean } = {}): Promise<void> {
		if (!this.options.deferResultCommit) {
			throw new Error("ToolScheduler has no deferred result boundary to commit.")
		}
		if (this.deferredCommitPromise) return this.deferredCommitPromise
		const deferred = this.deferredResultCommit
		if (!deferred) return
		const commit = async () => {
			let observationError: unknown
			for (const [index, result] of deferred.results.entries()) {
				const callId = sanitizeToolUseId(result.callId)
				if (this.deferredCommittedResultIds.has(callId)) continue
				try {
					await this.observeToolResult(result, deferred.calls[index])
				} catch (error) {
					observationError ??= error
				}
				const parts = getToolResultParts(result.content)
				const added = this.executionHost.pushToolResultToUserContent({
					type: "tool_result",
					tool_use_id: sanitizeToolUseId(result.callId),
					content: parts.text,
					is_error: result.status === "error" || result.status === "denied" || result.status === "cancelled",
				})
				if (added && parts.images.length > 0) this.executionHost.userMessageContent.push(...parts.images)
				if (!this.deferredResultEventIds.has(callId)) {
					await this.options.onEvent?.({
						type: "tool_result",
						callId: result.callId,
						name: result.name,
						status: result.status,
						output: result.content,
						truncated: result.truncated,
						timedOut: result.timedOut,
					})
					this.deferredResultEventIds.add(callId)
				}
				const commandCategory = getVerificationCategory(deferred.calls[index])
				const verificationStatus =
					result.executionStatus ?? (result.status === "success" ? undefined : result.status)
				if (
					commandCategory &&
					verificationStatus &&
					verificationStatus !== "running" &&
					!this.deferredVerificationEventIds.has(callId)
				) {
					await this.options.onEvent?.({
						type: "verification_result",
						commandCategory,
						toolName: result.name,
						status: verificationStatus,
						durationMs: result.durationMs,
						exitCode: result.exitCode,
						output: getVerificationOutput(result.content),
					})
					this.deferredVerificationEventIds.add(callId)
				}
				this.deferredCommittedResultIds.add(callId)
			}
			this.executionHost.userMessageContentReady = true
			if (!options.deferBatchFinished) await this.finishDeferredBatch()
			this.deferredResultCommit = undefined
			if (observationError) throw observationError
		}
		this.deferredCommitPromise = Promise.resolve().then(commit)
		try {
			await this.deferredCommitPromise
		} catch (error) {
			this.deferredCommitPromise = undefined
			throw error
		}
	}

	/** Publish the deferred batch terminal event after every held result is committed. */
	async finishDeferredBatch(overrides?: {
		status?: ToolSchedulerOutcome["status"]
		batchSize?: number
	}): Promise<void> {
		const event = this.deferredBatchFinishedEvent
		if (!event) return
		await this.options.onEvent?.({
			...event,
			...(overrides?.status ? { status: overrides.status } : {}),
			...(overrides?.batchSize !== undefined ? { batchSize: overrides.batchSize } : {}),
		})
		this.deferredBatchFinishedEvent = undefined
	}

	/** Drop held output when the host rejects or abandons the speculative read batch. */
	discardDeferredResults(): void {
		if (this.deferredCommitPromise) throw new Error("Committed deferred tool results cannot be discarded.")
		this.deferredResultCommit = undefined
		this.deferredBatchFinishedEvent = undefined
	}

	private retainDeferredResults(calls: AgentToolCall[], results: ToolSchedulerResult[]): void {
		if (!this.options.deferResultCommit) return
		this.deferredResultCommit = {
			calls: [...calls],
			results: results.map((result) => {
				const retained = { ...result }
				if (this.repetitionSkippedResults.has(result)) this.repetitionSkippedResults.add(retained)
				return retained
			}),
		}
	}

	private async emitBatchFinished(outcome: ToolSchedulerOutcome): Promise<void> {
		const event: AgentTurnEvent = {
			type: "tool_batch_finished",
			status: outcome.status,
			batchSize: outcome.batchSize,
			parallelBatchCount: outcome.parallelBatchCount,
			parallelToolCount: outcome.parallelToolCount,
			durationMs: outcome.durationMs,
			truncatedResultCount: outcome.outputTruncatedCount,
		}
		if (this.options.deferResultCommit) {
			this.deferredBatchFinishedEvent = event
			return
		}
		await this.options.onEvent?.(event)
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
		return this.executionHost.abort === true || this.options.signal?.aborted === true || this.approvalAbortRequested
	}

	private retryBlockResult(call: AgentToolCall): ToolSchedulerResult | undefined {
		const failure = normalizeToolFailure(
			this.executionHost.getToolRetryBlock?.(this.options.registry.canonicalName(call.name), call.arguments),
		)
		const denied =
			failure?.outcome === "known" && (failure.reason === "policy_denied" || failure.reason === "approval_denied")
		return failure
			? resultForError(call, formatToolFailureGuidance(failure), denied ? "denied" : "error", failure)
			: undefined
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}
}
