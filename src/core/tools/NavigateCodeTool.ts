import { realpath } from "node:fs/promises"
import path from "node:path"
import * as vscode from "vscode"

import type { AlphaSayTool, NavigateCodeParams } from "@alpha-code/types"
import { t } from "../../i18n"
import { awaitEnvironmentRead } from "../environment/EnvironmentContext"
import { formatResponse } from "../prompts/responses"
import type { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { getPathRelativeToRoot } from "./pathSafety"
import { getTaskDisplayPath, getTaskReadablePath } from "./taskPathPresentation"

const MAX_LOCATIONS = 50
const MAX_CANDIDATES = 256
type SymbolLocation = vscode.Location | vscode.LocationLink

/** Both the requested name and its real target must belong to this task's workspace. */
async function allowedFile(task: Task, realRoot: string, file: string): Promise<string | undefined> {
	const relative = getPathRelativeToRoot(task.cwd, file) ?? getPathRelativeToRoot(realRoot, file)
	if (!relative || !task.alphaIgnoreController?.validateAccess(relative)) return undefined
	const target = await realpath(file).catch(() => undefined)
	const realRelative = target && getPathRelativeToRoot(realRoot, target)
	return realRelative && (realRelative === relative || task.alphaIgnoreController.validateAccess(realRelative))
		? target
		: undefined
}

export class NavigateCodeTool extends BaseTool<"navigate_code"> {
	readonly name = "navigate_code" as const

	async execute(
		{ operation, path: requestedPath, line, column }: NavigateCodeParams,
		task: Task,
		callbacks: ToolCallbacks,
	) {
		const { signal, pushToolResult } = callbacks
		signal?.throwIfAborted()
		const file = path.resolve(task.cwd, requestedPath)
		const root = await realpath(task.cwd)
		const source = await allowedFile(task, root, file)
		const denied = (reason?: string) => {
			callbacks.setResultMetadata?.({ status: "denied" })
			pushToolResult(reason ? formatResponse.toolDeniedWithFeedback(reason) : formatResponse.toolDenied())
		}
		signal?.throwIfAborted()
		const inaccessible = "Navigation requires an accessible file in the task workspace."
		if (!source) return denied(inaccessible)

		const review: AlphaSayTool = {
			tool: "readFile",
			path: getTaskReadablePath(task, requestedPath),
			content: getTaskDisplayPath(task, file),
			reason: t(`tools:navigateCode.${operation}`),
			startLine: line,
			isOutsideWorkspace: false,
		}
		const approved = await callbacks.askApproval("tool", JSON.stringify(review))
		signal?.throwIfAborted()
		if (!approved) return denied()
		if ((await allowedFile(task, root, file)) !== source) return denied(inaccessible)

		signal?.throwIfAborted()
		const uri = vscode.Uri.file(source)
		const document = await awaitEnvironmentRead(Promise.resolve(vscode.workspace.openTextDocument(uri)), signal)
		const position = new vscode.Position(line - 1, column - 1)
		if (!position.isEqual(document.validatePosition(position))) {
			callbacks.setResultMetadata?.({ status: "error" })
			pushToolResult(
				formatResponse.toolError("Position is outside the document. Supply a one-based line and column."),
			)
			return
		}

		const command =
			operation === "definition" ? "vscode.executeDefinitionProvider" : "vscode.executeReferenceProvider"
		const matches = await awaitEnvironmentRead(
			Promise.resolve(vscode.commands.executeCommand<SymbolLocation[]>(command, document.uri, position)),
			signal,
		)
		const locations: Array<{ path: string; line: number; column: number }> = []
		const seen = new Set<string>()
		const files = new Map<string, string | undefined>()
		const budget = Math.min(16_000, callbacks.getRemainingOutputChars?.() ?? Infinity)
		let length = JSON.stringify({ locations: [], truncated: false }).length
		let truncated = false
		for (const [index, match] of (matches ?? []).entries()) {
			signal?.throwIfAborted()
			if (index >= MAX_CANDIDATES) {
				truncated = true
				break
			}
			const target = "targetUri" in match ? match.targetUri : match.uri
			if (target.scheme !== "file" || target.query || target.fragment) continue
			if (!files.has(target.fsPath)) files.set(target.fsPath, await allowedFile(task, root, target.fsPath))
			const canonical = files.get(target.fsPath)
			if (!canonical) continue
			const start = ("targetUri" in match ? (match.targetSelectionRange ?? match.targetRange) : match.range).start
			const location = {
				path: getPathRelativeToRoot(root, canonical)!,
				line: start.line + 1,
				column: start.character + 1,
			}
			const key = JSON.stringify(location)
			if (seen.has(key)) continue
			length += key.length + 1
			if (locations.length === MAX_LOCATIONS || length > budget) {
				truncated = true
				break
			}
			seen.add(key)
			locations.push(location)
		}
		signal?.throwIfAborted()
		if ((await allowedFile(task, root, file)) !== source) return denied(inaccessible)
		signal?.throwIfAborted()
		if (truncated) callbacks.setResultMetadata?.({ truncated })
		pushToolResult(JSON.stringify({ locations, truncated }))
	}
}

export const navigateCodeTool = new NavigateCodeTool()
