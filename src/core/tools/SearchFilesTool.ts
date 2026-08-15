import path from "path"

import { type ClineSayTool } from "@alpha-code/types"

import { Task } from "../task/Task"
import { regexSearchFiles } from "../../services/ripgrep"
import type { NativeToolArgs, ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"

type SearchFilesParams = NativeToolArgs["search_files"]

interface SearchFilesQuery {
	path: string
	regex: string
	file_pattern?: string | null
}

const MAX_SEARCH_QUERIES = 8

export class SearchFilesTool extends BaseTool<"search_files"> {
	readonly name = "search_files" as const

	async execute(params: SearchFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const queries = "queries" in params ? params.queries : [params]

		if (queries.length === 0 || queries.length > MAX_SEARCH_QUERIES) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(`search_files requires between 1 and ${MAX_SEARCH_QUERIES} queries.`)
			return
		}

		const missingPath = queries.find((query) => !query.path)
		if (missingPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "path"))
			return
		}

		const missingRegex = queries.find((query) => !query.regex)
		if (missingRegex) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "regex"))
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const results = await Promise.all(
				queries.map(async (query) => {
					const absolutePath = path.resolve(task.cwd, query.path)
					const filePattern = query.file_pattern || undefined
					const content = await regexSearchFiles(
						task.cwd,
						absolutePath,
						query.regex,
						filePattern,
						task.rooIgnoreController,
					)

					return {
						path: getTaskReadablePath(task, query.path),
						regex: query.regex,
						filePattern,
						isOutsideWorkspace: isTaskPathOutsideWorkspace(task, absolutePath),
						content,
					}
				}),
			)

			const completeMessage: ClineSayTool =
				results.length === 1
					? { tool: "searchFiles", ...results[0] }
					: {
							tool: "searchFiles",
							batchSearches: results,
							isOutsideWorkspace: results.some((result) => result.isOutsideWorkspace),
						}

			const didApprove = await askApproval("tool", JSON.stringify(completeMessage))

			if (!didApprove) {
				return
			}

			pushToolResult(
				results.length === 1
					? results[0].content
					: results
							.map(
								(result, index) =>
									`Search ${index + 1}: path=${result.path}, regex=${JSON.stringify(result.regex)}${result.filePattern ? `, file_pattern=${result.filePattern}` : ""}\n${result.content}`,
							)
							.join("\n\n---\n\n"),
			)
		} catch (error) {
			await handleError("searching files", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"search_files">): Promise<void> {
		const nativeArgs = block.nativeArgs
		const firstQuery: Partial<SearchFilesQuery> | undefined =
			nativeArgs && "queries" in nativeArgs ? nativeArgs.queries[0] : nativeArgs
		const relDirPath = firstQuery?.path ?? block.params.path
		const regex = firstQuery?.regex ?? block.params.regex
		const filePattern = firstQuery?.file_pattern ?? block.params.file_pattern

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getTaskReadablePath(task, relDirPath ?? ""),
			regex: regex ?? "",
			filePattern: filePattern ?? "",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const searchFilesTool = new SearchFilesTool()
