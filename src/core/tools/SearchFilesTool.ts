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

interface SearchFilesResult {
	path: string
	regex: string
	filePattern?: string
	isOutsideWorkspace: boolean
	content: string
}

const MAX_SEARCH_QUERIES = 8
const MAX_SEARCH_OUTPUT_CHARS = 16_000
const SEARCH_METADATA_LIMITS = {
	path: 512,
	regex: 1_024,
	filePattern: 256,
} as const
const SEARCH_METADATA_TRUNCATION_NOTICE = "...[truncated]"
const SEARCH_OUTPUT_TRUNCATION_NOTICE =
	"\n[Search output truncated. Refine path, regex, or file_pattern for more specific results.]"

function truncateSearchMetadata(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value
	}

	return `${value.slice(0, maxChars - SEARCH_METADATA_TRUNCATION_NOTICE.length)}${SEARCH_METADATA_TRUNCATION_NOTICE}`
}

function truncateSearchContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content
	}

	if (maxChars <= SEARCH_OUTPUT_TRUNCATION_NOTICE.length) {
		return SEARCH_OUTPUT_TRUNCATION_NOTICE.slice(0, Math.max(0, maxChars))
	}

	return `${content.slice(0, maxChars - SEARCH_OUTPUT_TRUNCATION_NOTICE.length)}${SEARCH_OUTPUT_TRUNCATION_NOTICE}`
}

function renderSearchResults(results: SearchFilesResult[]): string {
	return results.length === 1
		? results[0].content
		: results
				.map(
					(result, index) =>
						`Search ${index + 1}: path=${result.path}, regex=${JSON.stringify(result.regex)}${result.filePattern ? `, file_pattern=${result.filePattern}` : ""}\n${result.content}`,
				)
				.join("\n\n---\n\n")
}

function createSearchMessage(results: SearchFilesResult[]): ClineSayTool {
	return results.length === 1
		? { tool: "searchFiles", ...results[0] }
		: {
				tool: "searchFiles",
				batchSearches: results,
				isOutsideWorkspace: results.some((result) => result.isOutsideWorkspace),
			}
}

function boundSearchResults(results: SearchFilesResult[]): SearchFilesResult[] {
	const measure = (candidate: SearchFilesResult[]) =>
		Math.max(JSON.stringify(createSearchMessage(candidate)).length, renderSearchResults(candidate).length)
	const compacted = results.map((result) => ({
		...result,
		path: truncateSearchMetadata(result.path, SEARCH_METADATA_LIMITS.path),
		regex: truncateSearchMetadata(result.regex, SEARCH_METADATA_LIMITS.regex),
		filePattern: result.filePattern
			? truncateSearchMetadata(result.filePattern, SEARCH_METADATA_LIMITS.filePattern)
			: undefined,
	}))

	if (measure(compacted) <= MAX_SEARCH_OUTPUT_CHARS) {
		return compacted
	}

	let visibleCount = compacted.length
	let visibleResults: SearchFilesResult[] = []
	while (visibleCount > 0) {
		visibleResults = compacted.slice(0, visibleCount).map((result) => ({ ...result, content: "" }))
		if (visibleCount < compacted.length) {
			visibleResults[visibleResults.length - 1].content =
				`[Search output truncated: showing ${visibleCount} of ${compacted.length} searches. ` +
				"Refine path, regex, or file_pattern for more specific results.]"
		}

		if (measure(visibleResults) <= MAX_SEARCH_OUTPUT_CHARS) {
			break
		}
		visibleCount--
	}

	// Per-field metadata caps guarantee that at least one metadata-only result fits.
	// Keep the fallback defensive so malformed external input can never escape the hard cap.
	if (visibleCount === 0) {
		return []
	}

	const droppedSearchNotice = visibleCount < compacted.length ? visibleResults[visibleResults.length - 1].content : ""
	const materialize = (contentLimit: number) =>
		compacted.slice(0, visibleCount).map((result, index) => ({
			...result,
			content: `${index === visibleCount - 1 && droppedSearchNotice ? `${droppedSearchNotice}\n\n` : ""}${truncateSearchContent(result.content, contentLimit)}`,
		}))
	let lower = 0
	let upper = Math.max(...compacted.slice(0, visibleCount).map((result) => result.content.length))
	let best = materialize(0)

	while (lower <= upper) {
		const contentLimit = Math.floor((lower + upper) / 2)
		const candidate = materialize(contentLimit)

		if (measure(candidate) <= MAX_SEARCH_OUTPUT_CHARS) {
			best = candidate
			lower = contentLimit + 1
		} else {
			upper = contentLimit - 1
		}
	}

	return best
}

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
			callbacks.signal?.throwIfAborted()
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
						callbacks.signal,
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

			const boundedResults = boundSearchResults(results)
			const completeMessage = createSearchMessage(boundedResults)

			const didApprove = await askApproval("tool", JSON.stringify(completeMessage))

			if (!didApprove) {
				return
			}

			pushToolResult(renderSearchResults(boundedResults))
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
