import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import type { InternalTaskEnvelope } from "../agent/InternalTaskEnvelope"
export class DelegateTaskTool extends BaseTool<"delegate_task"> {
	readonly name = "delegate_task" as const
	async execute(params: { envelope?: InternalTaskEnvelope }, task: Task, callbacks: ToolCallbacks): Promise<void> {
		if (!params.envelope?.digest) {
			callbacks.pushToolResult("Error: delegate_task requires a validated envelope")
			return
		}
		const provider = task.providerRef.deref() as any
		if (typeof provider?.runInternalTaskEnvelope !== "function") {
			callbacks.pushToolResult("Error: bounded child runner is unavailable")
			return
		}
		if (
			!(await callbacks.askApproval(
				"tool",
				JSON.stringify({ tool: "delegateTask", objective: params.envelope.objective }),
			))
		)
			return
		try {
			callbacks.pushToolResult(
				JSON.stringify(
					await provider.runInternalTaskEnvelope(params.envelope, task.getTaskCancellationSignal()),
				),
			)
		} catch (error) {
			await callbacks.handleError("delegating internal task", error as Error)
		}
	}
	override async handlePartial(): Promise<void> {}
}
export const delegateTaskTool = new DelegateTaskTool()
