import * as vscode from "vscode"

import type { HistoryItem } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AttemptCompletionParams {
	result: string
	command?: string
	outcome?: "completed" | "blocked"
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result, outcome } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval, toolCallId } = callbacks

		if (task.taskKind === "primary" && outcome === "blocked" && result?.trim()) {
			const decision = await task.getCompletionGateDecision()
			const message = `Task remains incomplete and unverified. ${result}${decision.message ? `\n\nMissing evidence: ${decision.message}` : ""}`
			task.suspendAfterCurrentTurn(message)
			pushToolResult(formatResponse.toolError(message))
			return
		}

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		if (task.taskKind === "subagent" && task.subagentRole === "worker" && task.hasActiveCommandExecutions()) {
			const errorMsg =
				"Cannot complete an editing worker while a command is still running. Wait for its terminal result before reporting verification."
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}
			if (await this.rejectCompletionWithPendingParentVerification(task, pushToolResult)) return

			task.consecutiveMistakeCount = 0

			await task.presentCompletionResult(result, undefined, false)

			if (task.taskKind === "subagent") {
				// task.say may yield long enough for a nested child to finish. Recheck
				// the durable completion decision at the final transition boundary.
				if (await this.rejectCompletionWithPendingParentVerification(task, pushToolResult)) {
					await task.retractCompletionResult()
					return
				}
				task.subagentCompletionOutcome = outcome === "blocked" ? "blocked" : "completed"
				await this.commitAcceptedCompletion(task, pushToolResult, toolCallId)
				return
			}

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (!provider) {
					await this.rejectLegacyParentReturn(
						task,
						pushToolResult,
						"Cannot finish the delegated child because its parent handoff provider is unavailable.",
					)
					return
				}

				try {
					const { historyItem } = await provider.getTaskWithId(task.taskId)
					const status = historyItem?.status

					if (status === "completed") {
						// A completed historical child may show its result for review
						// without reopening the parent a second time.
					} else if (status === "active") {
						const delegation = await this.delegateToParent(
							task,
							result,
							provider,
							askFinishSubTaskApproval,
							pushToolResult,
							toolCallId,
						)
						if (delegation === "delegated") {
							return
						}
						if (delegation !== "continue") return
					} else {
						await this.rejectLegacyParentReturn(
							task,
							pushToolResult,
							`Cannot finish the delegated child while task ${task.taskId} has status ${status ?? "unknown"}.`,
						)
						return
					}
				} catch (error) {
					await this.rejectLegacyParentReturn(
						task,
						pushToolResult,
						`Cannot verify the delegated child handoff for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
					)
					return
				}
			}

			const { text, images } = await task.ask("completion_result", "", false)
			const providedFeedback = Boolean(text?.trim()) || Boolean(images?.length)
			const queuedFollowup = providedFeedback ? undefined : task.messageQueueService.dequeueMessage()
			const feedbackText = queuedFollowup?.text ?? text ?? ""
			const feedbackImages = queuedFollowup?.images ?? images ?? []

			if (!feedbackText.trim() && feedbackImages.length === 0) {
				// A background child can finish while the completion prompt is open.
				// Recheck the durable descendant/mailbox gate immediately before the
				// persisted completion transition.
				if (await this.rejectCompletionWithPendingParentVerification(task, pushToolResult)) {
					await task.retractCompletionResult()
					return
				}
				await this.commitAcceptedCompletion(task, pushToolResult, toolCallId)
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.retractCompletionResult()
			await task.say("user_feedback", feedbackText, feedbackImages)

			const toolFeedback = `<user_message>\n${feedbackText}\n</user_message>`
			pushToolResult(formatResponse.toolResult(toolFeedback, feedbackImages))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	private async rejectCompletionWithPendingParentVerification(
		task: Task,
		pushToolResult: AttemptCompletionCallbacks["pushToolResult"],
	): Promise<boolean> {
		const decision = await task.getCompletionGateDecision()
		if (decision.allowed) return false

		const errorMsg =
			decision.message ??
			"Cannot complete while applied Worker changes still require parent review and verification."
		if (decision.modelCanResolveRejection) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")
		} else {
			task.suspendAfterCurrentTurn(errorMsg)
		}
		pushToolResult(formatResponse.toolError(errorMsg))
		return true
	}

	private async rejectLegacyParentReturn(
		task: Task,
		pushToolResult: AttemptCompletionCallbacks["pushToolResult"],
		message: string,
	): Promise<void> {
		console.error(`[AttemptCompletionTool] ${message}`)
		await task.retractCompletionResult()
		pushToolResult(formatResponse.toolError(message))
	}

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: AttemptCompletionCallbacks["pushToolResult"],
		toolCallId?: string,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		if (!toolCallId?.trim()) {
			throw new Error(
				"Cannot return the delegated child because the completion tool call has no durable identifier.",
			)
		}
		const staged = task.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: toolCallId,
			content: "(tool did not return anything)",
		})
		if (!staged) {
			throw new Error("Cannot return the delegated child because its completion result was already recorded.")
		}
		if (!(await task.flushPendingToolResultsToHistory())) {
			task.removePendingToolResult(toolCallId)
			throw new Error("Cannot return the delegated child because its completion result could not be persisted.")
		}

		try {
			await provider.reopenParentFromDelegation({
				parentTaskId: task.parentTaskId!,
				childTaskId: task.taskId,
				completionResultSummary: result,
			})
		} catch (error) {
			try {
				await task.rollbackPersistedToolResult(toolCallId)
			} catch (rollbackError) {
				task.suspendAfterCurrentTurn(
					"The delegated-child handoff could not be committed or rolled back durably. Resume after reviewing task history.",
				)
				throw new AggregateError(
					[error, rollbackError],
					"The delegated-child handoff failed and its completion result could not be rolled back.",
				)
			}
			throw error
		}

		return "delegated"
	}

	private async commitAcceptedCompletion(
		task: Task,
		pushToolResult: AttemptCompletionCallbacks["pushToolResult"],
		toolCallId?: string,
	): Promise<boolean> {
		if (!toolCallId?.trim()) {
			throw new Error("Cannot complete the task because the completion tool call has no durable identifier.")
		}
		const staged = task.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: toolCallId,
			content: "(tool did not return anything)",
		})
		try {
			const finalized = await task.finalizeTaskCompletion(staged ? toolCallId : undefined)
			if (!finalized) {
				if (toolCallId) task.removePendingToolResult(toolCallId)
				const queued = task.messageQueueService.dequeueMessage()
				if (queued) {
					await task.retractCompletionResult()
					await task.say("user_feedback", queued.text, queued.images)
					pushToolResult(
						formatResponse.toolResult(`<user_message>\n${queued.text}\n</user_message>`, queued.images),
					)
					return false
				}
				pushToolResult(formatResponse.toolError("Task completion was not verified and remains incomplete."))
				return false
			}
			pushToolResult("")
			return true
		} catch (error) {
			if (toolCallId) task.removePendingToolResult(toolCallId)
			task.suspendAfterCurrentTurn(
				"Task completion could not be committed durably. Resume after reviewing the task lifecycle and transcript.",
			)
			await task.retractCompletionResult().catch(() => undefined)
			throw error
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.presentCompletionResult(result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.presentCompletionResult(result ?? "", undefined, block.partial)
		}
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
