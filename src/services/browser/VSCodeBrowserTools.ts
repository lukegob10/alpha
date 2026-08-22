import type { Anthropic } from "@anthropic-ai/sdk"
import { browserToolNames, type BrowserToolArgs, type BrowserToolName } from "@alpha-code/types"
import * as vscode from "vscode"

import { isLanguageModelDataPartLike, isLanguageModelTextPartLike } from "../../api/transform/vscode-lm-format"
import type { ToolResponse } from "../../shared/tools"

const browserToolNameSet = new Set<string>(browserToolNames)
const supportedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"] as const)
type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

const openBrowserToolName = "open_browser_page"
const toolAutoApproveSection = "chat.tools.global"
const toolAutoApproveKey = "autoApprove"
const toolAutoApproveTestModeContext = "vscode.chat.tools.global.autoApprove.testMode"

let openBrowserInvocationTail = Promise.resolve()

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
	return supportedImageMimeTypes.has(value as SupportedImageMimeType)
}

export function getAvailableVSCodeBrowserToolNames(): BrowserToolName[] {
	try {
		return vscode.lm.tools
			.map((tool) => tool.name)
			.filter((name): name is BrowserToolName => browserToolNameSet.has(name))
	} catch {
		return []
	}
}

export function isVSCodeBrowserToolAvailable(name: BrowserToolName): boolean {
	return getAvailableVSCodeBrowserToolNames().includes(name)
}

function dataPartToToolContent(
	part: vscode.LanguageModelDataPart,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
	if (isSupportedImageMimeType(part.mimeType)) {
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: part.mimeType,
				data: Buffer.from(part.data).toString("base64"),
			},
		}
	}

	if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
		return { type: "text", text: new TextDecoder().decode(part.data) }
	}

	return {
		type: "text",
		text: `[VS Code browser tool returned ${part.data.byteLength} bytes of ${part.mimeType} data]`,
	}
}

export function convertVSCodeToolResult(result: vscode.LanguageModelToolResult): ToolResponse {
	const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []

	for (const part of result.content) {
		if (isLanguageModelTextPartLike(part)) {
			content.push({ type: "text", text: part.value })
			continue
		}

		if (isLanguageModelDataPartLike(part)) {
			content.push(dataPartToToolContent(part))
			continue
		}

		content.push({
			type: "text",
			text: typeof part === "string" ? part : JSON.stringify(part),
		})
	}

	if (content.length === 0) return "(VS Code browser tool returned no content)"
	if (content.length === 1 && content[0].type === "text") return content[0].text
	return content
}

function isConfigurationRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isToolAutoApproved(value: unknown, toolName: string): boolean {
	return value === true || (isConfigurationRecord(value) && value[toolName] === true)
}

function areConfigurationValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (!isConfigurationRecord(left) || !isConfigurationRecord(right)) return false

	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.is(left[key], right[key]))
}

function getConfigurationTarget(
	inspection: ReturnType<vscode.WorkspaceConfiguration["inspect"]>,
): vscode.ConfigurationTarget {
	if (inspection?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder
	if (inspection?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace
	return vscode.ConfigurationTarget.Global
}

function getConfigurationTargetValue(
	inspection: ReturnType<vscode.WorkspaceConfiguration["inspect"]>,
	target: vscode.ConfigurationTarget,
): unknown {
	switch (target) {
		case vscode.ConfigurationTarget.WorkspaceFolder:
			return inspection?.workspaceFolderValue
		case vscode.ConfigurationTarget.Workspace:
			return inspection?.workspaceValue
		default:
			return inspection?.globalValue
	}
}

async function serializeOpenBrowserInvocation<T>(operation: () => PromiseLike<T>): Promise<T> {
	const previous = openBrowserInvocationTail
	let release!: () => void
	openBrowserInvocationTail = new Promise<void>((resolve) => {
		release = resolve
	})

	await previous
	try {
		return await operation()
	} finally {
		release()
	}
}

async function invokeOpenBrowserWithoutConfirmation<T>(operation: () => PromiseLike<T>): Promise<T> {
	return serializeOpenBrowserInvocation(async () => {
		const configuration = vscode.workspace.getConfiguration(toolAutoApproveSection)
		if (isToolAutoApproved(configuration.get(toolAutoApproveKey), openBrowserToolName)) {
			return operation()
		}

		// Extension-initiated language-model tool calls cannot carry a public approval token. VS Code 1.131
		// nevertheless supports a per-tool auto-approval map internally, so scope that compatibility path to
		// open_browser_page and restore the user's setting as soon as this invocation settles.
		let target: vscode.ConfigurationTarget | undefined
		let previousValue: unknown
		let temporaryValue: Record<string, unknown> | undefined
		let contextAttempted = false
		let updateAttempted = false

		const restore = async () => {
			try {
				if (updateAttempted && target !== undefined && temporaryValue !== undefined) {
					const currentValue = getConfigurationTargetValue(configuration.inspect(toolAutoApproveKey), target)
					if (areConfigurationValuesEqual(currentValue, temporaryValue)) {
						await configuration.update(toolAutoApproveKey, previousValue, target)
					}
				}
			} catch (error) {
				console.warn("[VSCodeBrowserTools] Failed to restore VS Code browser approval setting", error)
			} finally {
				if (contextAttempted) {
					try {
						await vscode.commands.executeCommand("setContext", toolAutoApproveTestModeContext, false)
					} catch (error) {
						console.warn("[VSCodeBrowserTools] Failed to clear VS Code browser approval context", error)
					}
				}
			}
		}

		try {
			contextAttempted = true
			await vscode.commands.executeCommand("setContext", toolAutoApproveTestModeContext, true)

			const inspection = configuration.inspect(toolAutoApproveKey)
			target = getConfigurationTarget(inspection)
			previousValue = getConfigurationTargetValue(inspection, target)
			temporaryValue = {
				...(isConfigurationRecord(previousValue) ? previousValue : {}),
				[openBrowserToolName]: true,
			}
			updateAttempted = true
			await configuration.update(toolAutoApproveKey, temporaryValue, target)
		} catch (error) {
			await restore()
			console.warn(
				"[VSCodeBrowserTools] Browser-only auto-approval is unavailable; using VS Code's normal confirmation flow",
				error,
			)
			return operation()
		}

		try {
			return await operation()
		} finally {
			await restore()
		}
	})
}

export async function invokeVSCodeBrowserTool<TName extends BrowserToolName>(
	name: TName,
	input: BrowserToolArgs[TName],
	signal?: AbortSignal,
): Promise<ToolResponse> {
	if (!isVSCodeBrowserToolAvailable(name)) {
		const available = getAvailableVSCodeBrowserToolNames()
		const suffix = available.length > 0 ? ` Available browser tools: ${available.join(", ")}.` : ""
		throw new Error(
			`VS Code's integrated-browser tool "${name}" is unavailable. Update VS Code and enable the workbench.browser.enableChatTools setting.${suffix}`,
		)
	}

	const cancellation = new vscode.CancellationTokenSource()
	const onAbort = () => cancellation.cancel()
	if (signal?.aborted) cancellation.cancel()
	else signal?.addEventListener("abort", onAbort, { once: true })

	try {
		const invoke = () =>
			vscode.lm.invokeTool(
				name,
				{
					input: input as object,
					toolInvocationToken: undefined,
				},
				cancellation.token,
			)
		const result =
			name === openBrowserToolName ? await invokeOpenBrowserWithoutConfirmation(invoke) : await invoke()
		return convertVSCodeToolResult(result)
	} finally {
		signal?.removeEventListener("abort", onAbort)
		cancellation.dispose()
	}
}
