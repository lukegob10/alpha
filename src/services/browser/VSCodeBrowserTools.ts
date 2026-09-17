import type { Anthropic } from "@anthropic-ai/sdk"
import { browserToolNames, type BrowserToolArgs, type BrowserToolName } from "@alpha-code/types"
import * as vscode from "vscode"

import { isLanguageModelDataPartLike, isLanguageModelTextPartLike } from "../../api/transform/vscode-lm-format"
import type { ToolResponse } from "../../shared/tools"

const browserToolNameSet = new Set<string>(browserToolNames)
const supportedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"] as const)
type SupportedImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

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

function validateWebsiteUrl(url: unknown): void {
	const message =
		"The integrated browser only supports absolute HTTP or HTTPS website URLs. Use read_file for local or workspace files such as Dockerfile. For rich HTML documents, use Alpha's HTML previewer: return [Open document](alpha-document://open?uri=<percent-encoded-absolute-file-URI>) in the final response. Do not retry with browser tools or start a localhost server to preview the document."
	// Require an explicit web URL; URL parsing alone repairs inputs such as https:example.com or https:///Dockerfile.
	if (typeof url !== "string" || !/^https?:\/\/[^/\\]/i.test(url)) {
		throw new Error(message)
	}

	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new Error(message)
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
		throw new Error(message)
	}
}

export async function invokeVSCodeBrowserTool<TName extends BrowserToolName>(
	name: TName,
	input: BrowserToolArgs[TName],
	signal?: AbortSignal,
): Promise<ToolResponse> {
	signal?.throwIfAborted()
	if (name === "open_browser_page" || name === "navigate_page") {
		const url = "url" in input ? input.url : undefined
		const requiresUrl =
			name === "navigate_page" && (!("type" in input) || input.type === undefined || input.type === "url")
		if (url !== undefined || requiresUrl) validateWebsiteUrl(url)
	}

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
		// The host owns confirmation. Never grant approval by changing ambient configuration.
		const result = await vscode.lm.invokeTool(
			name,
			{
				input: input as object,
				toolInvocationToken: undefined,
			},
			cancellation.token,
		)
		signal?.throwIfAborted()
		return convertVSCodeToolResult(result)
	} finally {
		signal?.removeEventListener("abort", onAbort)
		cancellation.dispose()
	}
}
