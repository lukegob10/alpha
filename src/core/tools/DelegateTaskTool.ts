import {
	normalizeSubagentTaskDrafts,
	type PreparedSubagentGroup,
	type SubagentTaskDraft,
	type SubagentToolResult,
} from "../agent/SubagentDelegation"
import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"

interface BoundedSubagentProvider {
	prepareSubagentGroup(parent: Task, drafts: unknown, toolCallId?: string): Promise<PreparedSubagentGroup>
	runSubagentGroup(
		parent: Task,
		prepared: PreparedSubagentGroup,
		parentSignal: AbortSignal,
	): Promise<SubagentToolResult>
	cancelPreparedSubagentGroup(parent: Task, prepared: PreparedSubagentGroup, reason: string): Promise<void>
}

export class DelegateTaskTool extends BaseTool<"delegate_task"> {
	readonly name = "delegate_task" as const

	async execute(params: { tasks: unknown }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const reject = (message: string) => {
			task.recordToolError("delegate_task", message)
			task.didToolFailInCurrentTurn = true
			callbacks.pushToolResult(`Error: ${message}`)
		}
		const provider = task.providerRef.deref() as (BoundedSubagentProvider & object) | undefined
		if (
			typeof provider?.prepareSubagentGroup !== "function" ||
			typeof provider.runSubagentGroup !== "function" ||
			typeof provider.cancelPreparedSubagentGroup !== "function"
		) {
			reject("bounded sub-agent runner is unavailable")
			return
		}

		let drafts: SubagentTaskDraft[]
		try {
			drafts = normalizeSubagentTaskDrafts(params.tasks)
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}

		let prepared: PreparedSubagentGroup
		try {
			prepared = await provider.prepareSubagentGroup(task, drafts, callbacks.toolCallId)
		} catch (error) {
			reject(error instanceof Error ? error.message : String(error))
			return
		}

		const approved = await callbacks.askApproval(
			"tool",
			JSON.stringify({
				tool: "delegateTask",
				groupId: prepared.group.groupId,
				agents: prepared.group.agents.map(({ nickname, role, objective, writeScope }) => ({
					nickname,
					role,
					objective,
					writeScope,
				})),
			}),
			undefined,
			prepared.requiresExplicitApproval === true,
		)

		if (!approved) {
			await provider.cancelPreparedSubagentGroup(task, prepared, "The user denied this sub-agent group.")
			return
		}

		try {
			const result = await provider.runSubagentGroup(task, prepared, task.getTaskCancellationSignal())
			callbacks.pushToolResult(JSON.stringify(result))
		} catch (error) {
			await callbacks.handleError("delegating sub-agents", error as Error)
		}
	}

	override async handlePartial(): Promise<void> {}
}

export const delegateTaskTool = new DelegateTaskTool()
