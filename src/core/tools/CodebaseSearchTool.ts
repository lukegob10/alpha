import { Task } from "../task/Task"
import { CodeIndexManager } from "../../services/code-index/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import type { CodebaseSearchResult } from "@alpha-code/types"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface CodebaseSearchParams {
	query: string
	path?: string
}

export class CodebaseSearchTool extends BaseTool<"codebase_search"> {
	readonly name = "codebase_search" as const

	async execute(params: CodebaseSearchParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { query, path: directoryPrefix } = params

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("codebase_search", new Error("Could not determine workspace path."))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("codebase_search", "query"))
			return
		}

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = CodeIndexManager.getInstance(context, workspacePath)

			if (!manager) {
				throw new Error("CodeIndexManager is not available.")
			}

			if (!manager.isFeatureEnabled) {
				throw new Error("Code Indexing is disabled in the settings.")
			}
			if (!manager.isFeatureConfigured) {
				throw new Error(t("embeddings:searchNotConfigured"))
			}

			const search = await manager.searchIndexWithDiagnostics(query, directoryPrefix)
			const jsonResult: CodebaseSearchResult = {
				query,
				results: [],
				diagnostics: search.diagnostics,
			}

			search.results.forEach((result) => {
				if (!result.payload) return
				if (!("filePath" in result.payload)) return

				const relativePath = result.payload.filePath

				jsonResult.results.push({
					filePath: relativePath,
					score: result.score,
					scoreType: result.scoreType,
					semanticScore: result.semanticScore,
					lexicalScore: result.lexicalScore,
					startLine: result.payload.startLine,
					endLine: result.payload.endLine,
					context: result.payload.context,
					codeChunk: result.payload.codeChunk.trim(),
				})
			})

			const payload = { tool: "codebaseSearch", content: jsonResult }
			await task.say("codebase_search_result", JSON.stringify(payload))
			const partial = [
				search.diagnostics.semanticStatus,
				search.diagnostics.lexicalStatus,
				search.diagnostics.freshStatus,
			].some((status) => status && status !== "complete")
			const incompleteIndex = search.diagnostics.indexFreshness && search.diagnostics.indexFreshness !== "current"
			const coverage = partial
				? "Search coverage is partial because a retrieval channel timed out or failed. Use read_file or search_files to verify missing evidence.\n"
				: incompleteIndex
					? "The code index is incomplete. Semantic coverage of recent changes may lag; use read_file or search_files to verify missing evidence.\n"
					: ""
			if (jsonResult.results.length === 0) {
				pushToolResult(`${coverage}No relevant code snippets found for the query: "${query}"`)
				return
			}

			const output = `${coverage}Query: ${query}
Results (hybrid rank scores are not confidence probabilities):

${jsonResult.results
	.map(
		(result) => `File path: ${result.filePath}
Hybrid rank score: ${result.score}
Lines: ${result.startLine}-${result.endLine}
Context: ${result.context ?? ""}
Code Chunk: ${result.codeChunk}
`,
	)
	.join("\n")}`

			pushToolResult(output)
		} catch (error: any) {
			await handleError("codebase_search", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"codebase_search">): Promise<void> {
		const query: string | undefined = block.params.query
		const directoryPrefix: string | undefined = block.params.path

		const sharedMessageProps = {
			tool: "codebaseSearch",
			query: query,
			path: directoryPrefix,
			isOutsideWorkspace: false,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const codebaseSearchTool = new CodebaseSearchTool()
