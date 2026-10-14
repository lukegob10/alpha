import type { ViewImageParams } from "@alpha-code/types"

import { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { readFileTool } from "./ReadFileTool"

export class ViewImageTool extends BaseTool<"view_image"> {
	readonly name = "view_image" as const

	async execute(params: ViewImageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		// Reuse the established protected-path, user-approval, size-limit, and
		// image-result flow. The image-only entry point never returns text files.
		await readFileTool.executeImage(params?.path, task, callbacks)
	}
}

export const viewImageTool = new ViewImageTool()
