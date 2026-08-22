import type { BrowserToolArgs, BrowserToolName } from "@alpha-code/types"

import { formatResponse } from "../prompts/responses"
import type { Task } from "../task/Task"
import { invokeVSCodeBrowserTool } from "../../services/browser/VSCodeBrowserTools"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, type ToolCallbacks } from "./BaseTool"

type BrowserActionStatus = "running" | "completed" | "error" | "cancelled"

function browserActionMessage(
	name: BrowserToolName,
	params: Partial<BrowserToolArgs[BrowserToolName]>,
	status: BrowserActionStatus,
) {
	const values = params as Record<string, unknown>
	return JSON.stringify({
		tool: "browserAction",
		action: name,
		status,
		pageId: typeof values.pageId === "string" ? values.pageId : undefined,
		url: typeof values.url === "string" ? values.url : undefined,
		element:
			typeof values.element === "string"
				? values.element
				: typeof values.fromElement === "string" && typeof values.toElement === "string"
					? `${values.fromElement} → ${values.toElement}`
					: undefined,
		code: typeof values.code === "string" ? values.code : undefined,
	})
}

export class VSCodeBrowserTool<TName extends BrowserToolName> extends BaseTool<TName> {
	constructor(readonly name: TName) {
		super()
	}

	async execute(params: BrowserToolArgs[TName], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, setResultMetadata, signal } = callbacks

		await task.say("tool", browserActionMessage(this.name, params, "running"), undefined, true)

		try {
			const result = await invokeVSCodeBrowserTool(this.name, params, signal)
			task.consecutiveMistakeCount = 0
			setResultMetadata?.({ status: "success" })
			await task.say("tool", browserActionMessage(this.name, params, "completed"), undefined, false)
			pushToolResult(result)
		} catch (error) {
			const cancelled = signal?.aborted === true
			setResultMetadata?.({ status: cancelled ? "cancelled" : "error" })
			await task.say(
				"tool",
				browserActionMessage(this.name, params, cancelled ? "cancelled" : "error"),
				undefined,
				false,
			)

			if (cancelled) {
				pushToolResult(formatResponse.toolError("The VS Code browser action was cancelled."))
				return
			}

			await handleError(`using VS Code integrated browser tool ${this.name}`, error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<TName>): Promise<void> {
		const params = (block.nativeArgs ?? {}) as Partial<BrowserToolArgs[TName]>
		await task.say("tool", browserActionMessage(this.name, params, "running"), undefined, true).catch(() => {})
	}
}

export const openBrowserPageTool = new VSCodeBrowserTool("open_browser_page")
export const listBrowserPagesTool = new VSCodeBrowserTool("list_browser_pages")
export const readPageTool = new VSCodeBrowserTool("read_page")
export const screenshotPageTool = new VSCodeBrowserTool("screenshot_page")
export const navigatePageTool = new VSCodeBrowserTool("navigate_page")
export const clickElementTool = new VSCodeBrowserTool("click_element")
export const typeInPageTool = new VSCodeBrowserTool("type_in_page")
export const hoverElementTool = new VSCodeBrowserTool("hover_element")
export const dragElementTool = new VSCodeBrowserTool("drag_element")
export const handleDialogTool = new VSCodeBrowserTool("handle_dialog")
export const runPlaywrightCodeTool = new VSCodeBrowserTool("run_playwright_code")

const vscodeBrowserTools = {
	open_browser_page: openBrowserPageTool,
	list_browser_pages: listBrowserPagesTool,
	read_page: readPageTool,
	screenshot_page: screenshotPageTool,
	navigate_page: navigatePageTool,
	click_element: clickElementTool,
	type_in_page: typeInPageTool,
	hover_element: hoverElementTool,
	drag_element: dragElementTool,
	handle_dialog: handleDialogTool,
	run_playwright_code: runPlaywrightCodeTool,
} as const

export function getVSCodeBrowserTool(name: BrowserToolName): VSCodeBrowserTool<BrowserToolName> {
	return vscodeBrowserTools[name] as VSCodeBrowserTool<BrowserToolName>
}
