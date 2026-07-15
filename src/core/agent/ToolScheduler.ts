import { Anthropic } from "@anthropic-ai/sdk"
import { serializeError } from "serialize-error"

import type { ModeConfig } from "@alpha-code/types"

import type { ToolResponse, ToolUse } from "../../shared/tools"
import type { ToolCallbacks, ToolResultMetadata } from "../tools/BaseTool"
import { formatResponse } from "../prompts/responses"
import { getModeBySlug } from "../../shared/modes"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { AskIgnoredError } from "../task/AskIgnoredError"
import type { Task } from "../task/Task"
import { validateToolUse } from "../tools/validateToolUse"
import type { AgentResponse, AgentToolCall } from "./AgentResponse"
import type { AgentTurnEvent } from "./AgentTurnEvents"
import type { ToolDescriptor, ToolRegistry } from "../tools/ToolRegistry"
import {
	getToolOutputLimit,
	isCommandDeniedByPolicy,
	isPathAllowed,
	isToolAllowed,
	resolveCommandTimeoutMs,
	type ToolPolicySnapshot,
} from "./ToolPolicy"

export interface ToolSchedulerOptions {
	task: Task
	registry: ToolRegistry
	mode: string
	customModes?: ModeConfig[]
	experiments?: Record<string, boolean>
	disabledTools?: string[]
	includedTools?: string[]
	policy?: ToolPolicySnapshot
	signal?: AbortSignal
	/** Optional test/host override for mode and disabled-tool validation. */
	validateCall?: (call: AgentToolCall, toolCall: ToolUse<any>) => void
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>
}

export interface ToolSchedulerOutcome {
	status: "completed" | "aborted"
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
}

export interface ToolSchedulerResult {
	callId: string
	name: string
	status: "success" | "error" | "denied" | "cancelled"
	content: ToolResponse
	/** Actual process outcome, when the tool reports one separately from handler completion. */
	executionStatus?: ToolResultMetadata["status"]
	exitCode?: number
	truncated?: boolean
	timedOut?: boolean
	durationMs: number
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
}

function resultForError(call: AgentToolCall, message: string): ToolSchedulerResult {
	return {
		callId: call.id,
		name: call.name,
		status: "error",
		content: formatResponse.toolError(message),
		durationMs: 0,
	}
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
	private approvalRequestCount = 0
	private approvalDeniedCount = 0
	private approvalCancelledCount = 0
	private supersededAskCount = 0
	private parallelToolCount = 0
	private outputTruncatedCount = 0

	constructor(private readonly options: ToolSchedulerOptions) {}

	async run(response: AgentResponse | AgentToolCall[]): Promise<ToolSchedulerOutcome> {
		this.approvalRequestCount = 0
		this.approvalDeniedCount = 0
		this.approvalCancelledCount = 0
		this.supersededAskCount = 0
		this.parallelToolCount = 0
		this.outputTruncatedCount = 0
		const startedAt = performance.now()
		const calls = Array.isArray(response)
			? response
			: response.items.filter((item): item is AgentToolCall => item.type === "tool_call")
		const prepared = calls.map((call, index) => this.prepareCall(call, index))
		const results = new Array<ToolSchedulerResult | undefined>(prepared.length)

		if (prepared.length === 0) {
			return this.metrics("completed", [], calls.length, 0, startedAt)
		}

		await this.options.onEvent?.({ type: "tool_batch_started", batchSize: calls.length })

		if (this.isCancelled()) {
			return this.metrics("aborted", [], calls.length, 0, startedAt)
		}

		const barrier = prepared.find((item) => item.descriptor?.capabilities.concurrency === "barrier")
		if (barrier && prepared.length > 1) {
			const message =
				`${barrier.call.name} must be called by itself in a message turn. ` +
				"No tools from this turn were executed. Retry with the control-flow tool alone."
			for (const item of prepared) {
				results[item.index] = resultForError(item.call, message)
			}
			return this.commitResults(results, calls, calls.length, 0, startedAt)
		}

		let cursor = 0
		let parallelBatchCount = 0
		while (cursor < prepared.length) {
			if (this.isCancelled()) {
				return this.metrics("aborted", [], calls.length, parallelBatchCount, startedAt)
			}

			const item = prepared[cursor]
			if (item.validationError || !item.descriptor || !item.toolCall) {
				results[item.index] = resultForError(
					item.call,
					item.validationError ?? "Tool call could not be prepared.",
				)
				cursor += 1
				continue
			}

			if (item.descriptor.capabilities.concurrency === "parallel") {
				parallelBatchCount += 1
				const parallelItems: PreparedCall[] = []
				while (cursor < prepared.length) {
					const candidate = prepared[cursor]
					if (
						candidate.validationError ||
						!candidate.descriptor ||
						!candidate.toolCall ||
						candidate.descriptor.capabilities.concurrency !== "parallel"
					) {
						break
					}
					parallelItems.push(candidate)
					cursor += 1
				}
				this.parallelToolCount += parallelItems.length

				const settled = await Promise.allSettled(parallelItems.map((candidate) => this.executeCall(candidate)))
				settled.forEach((outcome, offset) => {
					const candidate = parallelItems[offset]
					results[candidate.index] =
						outcome.status === "fulfilled"
							? outcome.value
							: resultForError(
									candidate.call,
									`Tool execution failed: ${this.errorMessage(outcome.reason)}`,
								)
				})
				continue
			}

			results[item.index] = await this.executeCall(item)
			cursor += 1
		}

		return this.commitResults(results, calls, calls.length, parallelBatchCount, startedAt)
	}

	private prepareCall(call: AgentToolCall, index: number): PreparedCall {
		const prepared: PreparedCall = { index, call }

		if (!call.id || !call.name) {
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

		for (const key of ["path", "file_path", "cwd", "directory"]) {
			const candidate = (argumentsValue as Record<string, unknown>)[key]
			if (
				typeof candidate === "string" &&
				candidate &&
				!isPathAllowed(this.options.policy, candidate, this.options.task.cwd)
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
			return {
				callId: prepared.call.id,
				name: prepared.call.name,
				status: "cancelled",
				content: formatResponse.toolError("Tool execution was cancelled."),
				durationMs: 0,
			}
		}

		const collector = new ToolResultCollector(
			Math.min(
				prepared.descriptor?.maxOutputChars ?? Number.MAX_SAFE_INTEGER,
				getToolOutputLimit(this.options.policy, prepared.call.name),
			),
		)
		const approvalFeedback = (text: string, images?: string[]) => collector.setApprovalFeedback({ text, images })

		const callbacks: ToolCallbacks = {
			askApproval: async (...args: Parameters<ToolCallbacks["askApproval"]>) =>
				this.approvalMutex.run(async () => {
					const [type, partialMessage, progressStatus, forceApproval] = args
					const requestId = `${this.options.task.taskId}:${prepared.call.id}`
					this.approvalRequestCount += 1

					if (this.isCancelled()) {
						this.approvalCancelledCount += 1
						collector.setStatus("cancelled")
						collector.push(formatResponse.toolError("Tool execution was cancelled."))
						await this.options.onEvent?.({
							type: "approval_result",
							requestId,
							decision: "cancelled",
							reason: "Task aborted before approval",
						})
						return false
					}

					await this.options.onEvent?.({
						type: "approval_request",
						requestId,
						callId: prepared.call.id,
						toolName: prepared.call.name,
					})

					let approval: Awaited<ReturnType<Task["ask"]>>
					try {
						approval = await this.options.task.ask(
							type,
							partialMessage,
							false,
							progressStatus,
							forceApproval || false,
						)
					} catch (error) {
						if (error instanceof AskIgnoredError) {
							this.supersededAskCount += 1
							this.approvalCancelledCount += 1
							collector.setStatus(this.isCancelled() ? "cancelled" : "error")
							collector.push(
								formatResponse.toolError(`Approval request was superseded: ${error.message}`),
							)
							await this.options.onEvent?.({
								type: "approval_result",
								requestId,
								decision: "cancelled",
								reason: error.message,
							})
							return false
						}
						throw error
					}

					const { response, text, images } = approval

					if (response !== "yesButtonClicked") {
						if (text) {
							await this.options.task.say("user_feedback", text, images)
							collector.push(
								formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images),
							)
						} else {
							collector.push(formatResponse.toolDenied())
						}
						const decision = response === "noButtonClicked" || text ? "denied" : "cancelled"
						collector.setStatus(decision === "denied" ? "denied" : "cancelled")
						if (decision === "denied") {
							this.approvalDeniedCount += 1
						} else {
							this.approvalCancelledCount += 1
						}
						await this.options.onEvent?.({
							type: "approval_result",
							requestId,
							decision,
							reason: text,
						})
						return false
					}

					if (text) {
						await this.options.task.say("user_feedback", text, images)
						approvalFeedback(text, images)
					}
					await this.options.onEvent?.({ type: "approval_result", requestId, decision: "approved" })
					return true
				}),
			handleError: async (action: string, error: Error) => {
				if (error instanceof AskIgnoredError) {
					this.supersededAskCount += 1
					collector.setStatus(this.isCancelled() ? "cancelled" : "error")
					collector.push(formatResponse.toolError(`Tool approval was superseded: ${error.message}`))
					return
				}
				const cancelled = this.isCancelled()
				if (!cancelled) {
					this.options.task.didToolFailInCurrentTurn = true
				}
				collector.setStatus(cancelled ? "cancelled" : "error")
				const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
				if (cancelled) {
					collector.push(formatResponse.toolError("Tool execution was cancelled."))
				} else {
					await this.options.task.say("error", `Error ${action}:\n${error.message}`)
					collector.push(formatResponse.toolError(errorString))
				}
			},
			pushToolResult: (content: ToolResponse) => collector.push(content),
			setResultMetadata: (metadata: ToolResultMetadata) => collector.setMetadata(metadata),
			toolCallId: prepared.call.id,
			signal: this.options.signal,
			resolveCommandTimeoutMs: (requestedTimeoutMs, command) =>
				resolveCommandTimeoutMs(this.options.policy, requestedTimeoutMs ?? 0, command),
		}

		try {
			if (
				this.options.task.shouldStopRepeatedToolCall?.(
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
			await this.options.onEvent?.({
				type: "progress",
				callId: prepared.call.id,
				text: `Running ${prepared.call.name}`,
			})
			this.options.task.recordToolUsage(prepared.call.name as never)
			await prepared.descriptor!.execute({
				task: this.options.task,
				call: prepared.toolCall!,
				signal: this.options.signal,
				callbacks,
			})
		} catch (error) {
			const cancelled = this.isCancelled()
			collector.setStatus(cancelled ? "cancelled" : "error")
			collector.push(
				formatResponse.toolError(
					cancelled
						? "Tool execution was cancelled."
						: `Error executing ${prepared.call.name}: ${this.errorMessage(error)}`,
				),
			)
		}

		if (collector.isTruncated()) {
			this.outputTruncatedCount += 1
		}

		return {
			callId: prepared.call.id,
			name: prepared.call.name,
			status: collector.getStatus(),
			content: collector.getContent(),
			executionStatus: collector.getMetadata().status,
			exitCode: collector.getMetadata().exitCode,
			truncated: collector.isTruncated(),
			timedOut: collector.getMetadata().timedOut,
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
			return this.metrics("aborted", [], batchSize, parallelBatchCount, startedAt)
		}

		const committed: ToolSchedulerResult[] = []
		for (let index = 0; index < results.length; index += 1) {
			if (this.isCancelled()) {
				return this.metrics("aborted", committed, batchSize, parallelBatchCount, startedAt)
			}

			const result = results[index] ?? resultForError(calls[index], "Tool execution did not produce a result.")
			const parts = getToolResultParts(result.content)
			const added = this.options.task.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(result.callId),
				content: parts.text,
				is_error: result.status === "error" || result.status === "denied" || result.status === "cancelled",
			})
			if (added && parts.images.length > 0) {
				this.options.task.userMessageContent.push(...parts.images)
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
			this.options.task.recordToolCallForStopping?.(
				result.name,
				calls[index].arguments,
				result.status,
				commandCategory,
			)
			const verificationStatus =
				result.executionStatus ?? (result.status === "success" ? undefined : result.status)
			if (commandCategory && verificationStatus) {
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

		this.options.task.userMessageContentReady = true
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
		return this.options.task.abort || this.options.signal?.aborted === true
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}
}
