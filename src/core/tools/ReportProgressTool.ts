import type { ReportProgressParams } from "@alpha-code/types"

import type { Task } from "../task/Task"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { recordLifecycleToolError, requireNonEmptyMessage, runAgentLifecycleOperation } from "./AgentLifecycleTool"

export class ReportProgressTool extends BaseTool<"report_progress"> {
	readonly name = "report_progress" as const

	async execute(params: ReportProgressParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		let message: string
		try {
			message = requireNonEmptyMessage((params as ReportProgressParams | undefined)?.message)
		} catch (error) {
			recordLifecycleToolError(this.name, task, callbacks, error)
			return
		}

		await runAgentLifecycleOperation(this.name, "reportAgentProgress", task, callbacks, (provider) =>
			provider.reportAgentProgress(task, message),
		)
	}
}

export const reportProgressTool = new ReportProgressTool()
