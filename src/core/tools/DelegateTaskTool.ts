import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import type { InternalTaskDraft, InternalTaskEnvelope } from "../agent/InternalTaskEnvelope"
export class DelegateTaskTool extends BaseTool<"delegate_task"> {
	readonly name = "delegate_task" as const
	async execute(
		params: { envelope?: InternalTaskDraft; tasks?: InternalTaskDraft[] },
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<void> {
		const drafts = params.tasks ?? (params.envelope ? [params.envelope] : [])
		if (drafts.length < 1 || drafts.length > 2) {
			callbacks.pushToolResult("Error: delegate_task requires one or two child-task drafts")
			return
		}
		const provider = task.providerRef.deref() as any
		if (
			typeof provider?.buildInternalTaskEnvelopeForTask !== "function" ||
			typeof provider?.runInternalTaskEnvelope !== "function" ||
			(drafts.length > 1 && typeof provider?.runInternalTaskEnvelopes !== "function")
		) {
			callbacks.pushToolResult("Error: bounded child runner is unavailable")
			return
		}

		let envelopes: InternalTaskEnvelope[]
		try {
			envelopes = drafts.map((draft) => provider.buildInternalTaskEnvelopeForTask(task, draft))
		} catch (error) {
			callbacks.pushToolResult(`Error: ${error instanceof Error ? error.message : String(error)}`)
			return
		}
		if (
			!(await callbacks.askApproval(
				"tool",
				JSON.stringify({ tool: "delegateTask", objectives: envelopes.map((item) => item.objective) }),
			))
		)
			return
		try {
			const results =
				envelopes.length === 1
					? [await provider.runInternalTaskEnvelope(envelopes[0], task.getTaskCancellationSignal())]
					: await provider.runInternalTaskEnvelopes(envelopes, task.getTaskCancellationSignal())
			for (const result of results) {
				if (result.requiresParentVerification) task.requireChildVerification(result.taskId)
			}
			callbacks.pushToolResult(JSON.stringify(envelopes.length === 1 ? results[0] : results))
		} catch (error) {
			await callbacks.handleError("delegating internal task", error as Error)
		}
	}
	override async handlePartial(): Promise<void> {}
}
export const delegateTaskTool = new DelegateTaskTool()
