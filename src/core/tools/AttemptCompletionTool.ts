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
	getParentCompletionDecision?(task: Task): Promise<{ allowed: boolean; message?: string }>
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
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

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
				pushToolResult("")
				await this.emitTaskCompleted(task)
				return
			}

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (status === "completed") {
							// Subtask already completed - skip delegation flow entirely
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								await this.emitTaskCompleted(task)
							}
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							console.error(
								`[AttemptCompletionTool] Unexpected child task status "${status}" for task ${task.taskId}. ` +
									`Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						console.error(
							`[AttemptCompletionTool] Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. ` +
								`Skipping delegation.`,
						)
						// Fall through to normal completion ask flow
					}
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
				pushToolResult("")
				await this.emitTaskCompleted(task)
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", feedbackText, feedbackImages)

			const toolFeedback = `<user_message>\n${feedbackText}\n</user_message>`
			pushToolResult(formatResponse.toolResult(toolFeedback, feedbackImages))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	private async rejectCompletionWithPendingParentVerification(
		task: Task,
		pushToolResult: (result: string) => void,
	): Promise<boolean> {
		const provider = task.providerRef?.deref() as DelegationProvider | undefined

		let decision: { allowed: boolean; message?: string }
		if (!provider?.getParentCompletionDecision) {
			decision = {
				allowed: false,
				message:
					"Cannot verify Worker completion obligations because the durable completion decision is unavailable.",
			}
		} else {
			try {
				decision = await provider.getParentCompletionDecision(task)
			} catch (error) {
				decision = {
					allowed: false,
					message: `Cannot verify Worker completion obligations right now: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
		}
		if (decision.allowed) return false

		const errorMsg =
			decision.message ??
			"Cannot complete while applied Worker changes still require parent review and verification."
		task.consecutiveMistakeCount++
		task.recordToolError("attempt_completion")
		pushToolResult(formatResponse.toolError(errorMsg))
		return true
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
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary: result,
		})

		return "delegated"
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

	private async emitTaskCompleted(task: Task): Promise<void> {
		await task.finalizeTaskCompletion()
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
