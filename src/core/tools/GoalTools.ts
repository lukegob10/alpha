import { z } from "zod"
import { taskGoalObjectiveSchema, taskGoalTokenBudgetSchema, type AlphaSayTool, type TaskGoal } from "@alpha-code/types"

import type { Task } from "../task/Task"
import type { ToolExecutionContext } from "./ToolRegistry"

const createGoalArgsSchema = z
	.object({ objective: taskGoalObjectiveSchema, token_budget: taskGoalTokenBudgetSchema.optional() })
	.strict()
const getGoalArgsSchema = z.object({}).strict()
const updateGoalArgsSchema = z.object({ status: z.enum(["complete", "blocked", "paused"]) }).strict()

export interface GoalToolResponse {
	goal: TaskGoal | null
	remainingTokens: number | null
	completionBudgetReport: string | null
}

export function goalToolResponse(goal: TaskGoal | undefined, reportCompletion = false): GoalToolResponse {
	return {
		goal: goal ?? null,
		remainingTokens: goal?.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
		completionBudgetReport:
			reportCompletion && goal?.status === "complete" && goal.tokenBudget !== undefined
				? `Goal completed. Final token usage: ${goal.tokensUsed} of ${goal.tokenBudget}.`
				: null,
	}
}

function throwIfCancelled(task: Task, signal?: AbortSignal): void {
	signal?.throwIfAborted()
	if (task.abort || task.getTaskLifetimeCancellationSignal().aborted) throw new Error("Goal operation cancelled.")
}

/** Goal state uses the task's serialized controller; models cannot access host resume or clear operations. */
export async function executeGoalTool({ task, call, callbacks, signal }: ToolExecutionContext): Promise<void> {
	if (call.partial) return
	signal ??= callbacks.signal
	const result = (value: GoalToolResponse) => {
		callbacks.setResultMetadata?.({ status: "success" })
		callbacks.pushToolResult(JSON.stringify(value))
	}
	const stopped = (status: "denied" | "cancelled", message: string) => {
		callbacks.setResultMetadata?.({ status })
		callbacks.pushToolResult(JSON.stringify({ status, message }))
	}
	try {
		throwIfCancelled(task, signal)
		if (task.taskKind !== "primary" || task.parentTaskId || task.orchestrationParentTaskId) {
			stopped("denied", "Goal tools are available to a primary root task only.")
			return
		}

		const approve = async (operation: "create" | "pause", goal: { objective: string; tokenBudget?: number }) => {
			const approved = await callbacks.askApproval(
				"tool",
				JSON.stringify({
					tool: "goal",
					goalActivity: {
						operation,
						objective: goal.objective,
						...(goal.tokenBudget === undefined ? {} : { tokenBudget: goal.tokenBudget }),
					},
				} satisfies AlphaSayTool),
				undefined,
				true,
				true,
			)
			throwIfCancelled(task, signal)
			if (!approved) stopped("denied", "The goal change was declined.")
			return approved
		}

		switch (call.name) {
			case "get_goal": {
				getGoalArgsSchema.parse(call.nativeArgs)
				const goal = await task.getGoal()
				throwIfCancelled(task, signal)
				result(goalToolResponse(goal))
				return
			}
			case "create_goal": {
				const args = createGoalArgsSchema.parse(call.nativeArgs)
				const existing = await task.getGoal()
				throwIfCancelled(task, signal)
				if (existing && existing.status !== "complete") throw new Error("This task has an unfinished goal.")
				const input = {
					objective: args.objective,
					...(args.token_budget === undefined ? {} : { tokenBudget: args.token_budget }),
				}
				if (!(await approve("create", input))) return
				const goal = await task.createGoal(
					input,
					{
						source: "tool",
						approved: true,
						expectedGoalId: existing?.goalId ?? null,
						...(existing ? { expectedVersion: existing.version } : {}),
					},
					signal,
				)
				result(goalToolResponse(goal))
				return
			}
			case "update_goal": {
				const { status } = updateGoalArgsSchema.parse(call.nativeArgs)
				const before = await task.getGoal()
				throwIfCancelled(task, signal)
				if (!before) throw new Error("This task has no goal to update.")
				if (status === "paused" && !(await approve("pause", before))) return
				const goal = await task.updateGoalStatus(
					status,
					{
						source: "tool",
						...(status === "paused" ? { approved: true } : {}),
						expectedGoalId: before.goalId,
						expectedControlVersion: before.controlVersion,
					},
					signal,
				)
				result(goalToolResponse(goal, status === "complete"))
				return
			}
			default:
				throw new Error("Unknown goal tool.")
		}
	} catch (error) {
		if (task.abort || signal?.aborted || task.getTaskLifetimeCancellationSignal().aborted) {
			stopped("cancelled", "Goal operation cancelled.")
			return
		}
		callbacks.setResultMetadata?.({ status: "error" })
		await callbacks.handleError("managing goal", error instanceof Error ? error : new Error(String(error)))
	}
}
