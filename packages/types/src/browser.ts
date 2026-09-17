/**
 * VS Code integrated-browser tools that Alpha can bridge through the
 * Language Model Tool API. These names intentionally match VS Code's public
 * `vscode.lm.tools` registrations.
 */
export const browserToolNames = [
	"open_browser_page",
	"list_browser_pages",
	"read_page",
	"screenshot_page",
	"navigate_page",
	"click_element",
	"type_in_page",
	"hover_element",
	"drag_element",
	"handle_dialog",
	"run_playwright_code",
] as const

export type BrowserToolName = (typeof browserToolNames)[number]

export interface OpenBrowserPageParams {
	url?: string
	forceNew?: boolean
}

export interface BrowserPageParams {
	pageId: string
}

export interface ScreenshotPageParams extends BrowserPageParams {
	ref?: string
	selector?: string
	element?: string
	scrollIntoViewIfNeeded?: boolean
}

export interface NavigatePageParams extends BrowserPageParams {
	type?: "url" | "back" | "forward" | "reload"
	url?: string
}

export interface ClickElementParams extends BrowserPageParams {
	ref?: string
	selector?: string
	element: string
	dblClick?: boolean
	button?: "left" | "right" | "middle"
}

export interface TypeInPageParams extends BrowserPageParams {
	text?: string
	submit?: boolean
	key?: string
	ref?: string
	selector?: string
	element?: string
}

export interface HoverElementParams extends BrowserPageParams {
	ref?: string
	selector?: string
	element: string
}

export interface DragElementParams extends BrowserPageParams {
	fromRef?: string
	fromSelector?: string
	fromElement: string
	toRef?: string
	toSelector?: string
	toElement: string
}

export interface HandleDialogParams extends BrowserPageParams {
	acceptModal?: boolean
	promptText?: string
	selectFiles?: string[]
}

export interface RunPlaywrightCodeParams extends BrowserPageParams {
	code?: string
	deferredResultId?: string
	timeoutMs?: number
}

export type BrowserToolArgs = {
	open_browser_page: OpenBrowserPageParams
	list_browser_pages: Record<string, never>
	read_page: BrowserPageParams
	screenshot_page: ScreenshotPageParams
	navigate_page: NavigatePageParams
	click_element: ClickElementParams
	type_in_page: TypeInPageParams
	hover_element: HoverElementParams
	drag_element: DragElementParams
	handle_dialog: HandleDialogParams
	run_playwright_code: RunPlaywrightCodeParams
}
