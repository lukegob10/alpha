import type { BrowserToolArgs, BrowserToolName } from "@alpha-code/types"

import { formatResponse } from "../prompts/responses"
import type { Task } from "../task/Task"
import {
	invokeVSCodeBrowserTool,
	validateVSCodeBrowserToolInvocation,
	VSCodeBrowserToolCancellation,
	VSCodeBrowserToolPreflightError,
} from "../../services/browser/VSCodeBrowserTools"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { createToolFailure } from "./ToolFailure"

type BrowserActionStatus = "running" | "completed" | "error" | "cancelled"

function browserActionMessage(
	name: BrowserToolName,
	params: Partial<BrowserToolArgs[BrowserToolName]>,
	status?: BrowserActionStatus,
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
		selectFiles:
			status === undefined && name === "handle_dialog" && Array.isArray(values.selectFiles)
				? values.selectFiles
				: undefined,
	})
}

export class VSCodeBrowserTool<TName extends BrowserToolName> extends BaseTool<TName> {
	constructor(readonly name: TName) {
		super()
	}

	async execute(params: BrowserToolArgs[TName], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult, setResultMetadata, signal } = callbacks
		let settleActivity: ((text: string) => Promise<void>) | undefined
		let status: Exclude<BrowserActionStatus, "running"> = "error"
		try {
			signal?.throwIfAborted()
			validateVSCodeBrowserToolInvocation(this.name, params)
			// A file chooser can hand local filesystem contents to a web page.
			const selectsFiles =
				this.name === "handle_dialog" && "selectFiles" in params && !!params.selectFiles?.length
			// Alpha admits and journals the effect before VS Code applies its own confirmation policy.
			if (
				!(await callbacks.askApproval(
					"tool",
					browserActionMessage(this.name, params),
					undefined,
					undefined,
					selectsFiles,
				))
			)
				return
			signal?.throwIfAborted()
			try {
				settleActivity = await task.beginBrowserToolActivity(
					browserActionMessage(this.name, params, "running"),
					callbacks.toolCallId,
				)
			} catch {
				console.warn("[VSCodeBrowserTool] Could not record running browser activity.")
			}

			// The task can lose ownership while the activity row is being saved or published.
			if (!task.canDispatchBrowserTool() || signal?.aborted) {
				status = "cancelled"
				setResultMetadata?.({
					status,
					failure: createToolFailure({
						reason: "cancelled",
						scopeKind: "operation",
						scopeIdentity: [this.name, params],
						effectsStarted: "no",
						outcome: "known",
						recovery: { kind: "none" },
					}),
				})
				pushToolResult(formatResponse.toolError("The VS Code browser action was cancelled."))
				return
			}

			const result = await invokeVSCodeBrowserTool(this.name, params, signal)
			signal?.throwIfAborted()
			task.consecutiveMistakeCount = 0
			status = "completed"
			setResultMetadata?.({ status: "success" })
			pushToolResult(result)
		} catch (error) {
			const hostCancelled = error instanceof VSCodeBrowserToolCancellation
			if (signal?.aborted || hostCancelled) {
				status = "cancelled"
				setResultMetadata?.({
					status: "cancelled",
					...(hostCancelled
						? {
								failure: createToolFailure({
									reason: "outcome_unknown",
									scopeKind: "operation",
									scopeIdentity: [this.name, params],
									effectsStarted: "unknown",
									outcome: "unknown",
									recovery: { kind: "verify-outcome" },
								}),
							}
						: {}),
				})
				pushToolResult(formatResponse.toolError("The VS Code browser action was cancelled."))
				return
			}
			const preflightFailure = error instanceof VSCodeBrowserToolPreflightError ? error : undefined
			const unavailable = preflightFailure?.reason === "capability_unavailable"
			setResultMetadata?.({
				status: "error",
				...(preflightFailure
					? {
							failure: createToolFailure({
								reason: preflightFailure.reason,
								scopeKind: unavailable ? "capability" : "operation",
								scopeIdentity: unavailable ? this.name : [this.name, params],
								effectsStarted: "no",
								outcome: "known",
								recovery: { kind: unavailable ? "user-action" : "repair" },
							}),
						}
					: {}),
			})
			await handleError(
				`using VS Code integrated browser tool ${this.name}`,
				error instanceof Error ? error : new Error(String(error)),
			)
		} finally {
			if (settleActivity) {
				try {
					await settleActivity(
						browserActionMessage(this.name, params, signal?.aborted ? "cancelled" : status),
					)
				} catch {
					console.warn("[VSCodeBrowserTool] Could not publish terminal browser activity.")
				}
			}
		}
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
