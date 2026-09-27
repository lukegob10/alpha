import type { AlphaMessage, AlphaSayTool } from "@alpha-code/types"
import { safeJsonParse } from "@alpha/core"

/** File-edit tool names from AlphaSayTool["tool"] plus compatibility aliases. */
const FILE_EDIT_TOOLS = new Set<string>([
	"editedExistingFile",
	"appliedDiff",
	"newFileCreated",
	"insertContent",
	"searchAndReplace",
	"search_and_replace",
	"search_replace",
	"edit",
	"edit_file",
	"apply_patch",
	"apply_diff",
])

export interface FileChangeEntry {
	path: string
	diff: string
	diffStats?: { added: number; removed: number }
	/** Original file content before first edit (for merged diff display) */
	originalContent?: string
	/** Content captured when the edit completed, before any later workspace changes. */
	finalContent?: string
	commandExecutionId?: string
}

type FileChangePayload = AlphaSayTool & {
	finalContent?: string
	changeStatus?: string
	commandExecutionId?: string
}

interface FileChangeCandidate {
	entry: FileChangeEntry
	source: "ask" | "say"
	/** Full replacement content on a legacy approval preview, when available. */
	previewContent?: string
}

export function normalizedFileChangePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\/+/, "")
}

function matchesCompletedEdit(preview: FileChangeCandidate, completed: FileChangeCandidate): boolean {
	if (normalizedFileChangePath(preview.entry.path) !== normalizedFileChangePath(completed.entry.path)) return false
	if (preview.entry.commandExecutionId && completed.entry.commandExecutionId) {
		return preview.entry.commandExecutionId === completed.entry.commandExecutionId
	}
	if (
		preview.entry.originalContent !== undefined &&
		completed.entry.originalContent !== undefined &&
		preview.entry.originalContent !== completed.entry.originalContent
	) {
		return false
	}
	return (
		preview.entry.diff === completed.entry.diff ||
		(preview.previewContent !== undefined && preview.previewContent === completed.entry.finalContent)
	)
}

export interface FileChangeTurn {
	/** Stable identity for the turn's panel, even while later messages stream in. */
	key: string
	/** Index of the last rendered message in this turn. */
	endIndex: number
	messages: AlphaMessage[]
}

/**
 * Derives a list of file changes from clineMessages for the current conversation.
 * Includes:
 * - type "say" + say "tool" (completed edit records)
 * - type "ask" + ask "tool" (legacy answered approval previews)
 */
export function fileChangesFromMessages(messages: AlphaMessage[] | undefined): FileChangeEntry[] {
	if (!messages?.length) return []

	const candidates: FileChangeCandidate[] = []

	for (const msg of messages) {
		const isSayTool = msg.type === "say" && msg.say === "tool"
		const isAskTool = msg.type === "ask" && msg.ask === "tool"
		if ((!isSayTool && !isAskTool) || !msg.text || msg.partial) continue
		if (isAskTool && !msg.isAnswered) continue

		const tool = safeJsonParse<FileChangePayload>(msg.text)
		if (
			!tool ||
			!FILE_EDIT_TOOLS.has(tool.tool as string) ||
			(tool.changeStatus !== undefined && tool.changeStatus !== "applied")
		) {
			continue
		}
		const source = isSayTool ? "say" : "ask"
		const commandExecutionId = tool.commandExecutionId ?? msg.commandExecutionId

		// Batch diffs
		if (tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
			for (const file of tool.batchDiffs) {
				if (typeof file.path !== "string" || !file.path) continue
				const content = file.content ?? file.diffs?.map((d) => d.content).join("\n") ?? ""
				if (content) {
					candidates.push({
						entry: { path: file.path, diff: content, diffStats: file.diffStats, commandExecutionId },
						source,
					})
				}
			}
			continue
		}

		// Single file
		if (typeof tool.path !== "string" || !tool.path) continue
		const diff = tool.diff ?? tool.content ?? ""
		if (typeof diff === "string" && diff) {
			candidates.push({
				entry: {
					path: tool.path,
					diff,
					diffStats: tool.diffStats,
					originalContent: tool.originalContent,
					finalContent: tool.finalContent,
					commandExecutionId,
				},
				source,
				previewContent: isAskTool ? tool.content : undefined,
			})
		}
	}

	// One completed record replaces at most one matching approval preview. Distinct
	// edits to the same path, including later command executions, remain separate.
	const supersededPreviews = new Set<number>()
	for (let completedIndex = 0; completedIndex < candidates.length; completedIndex++) {
		const completed = candidates[completedIndex]
		if (completed.source !== "say") continue
		for (let previewIndex = completedIndex - 1; previewIndex >= 0; previewIndex--) {
			const preview = candidates[previewIndex]
			if (
				preview.source === "ask" &&
				!supersededPreviews.has(previewIndex) &&
				matchesCompletedEdit(preview, completed)
			) {
				supersededPreviews.add(previewIndex)
				break
			}
		}
	}

	return candidates.flatMap((candidate, index) => (supersededPreviews.has(index) ? [] : [candidate.entry]))
}

/**
 * Splits rendered transcript messages at user follow-ups and returns only turns
 * that contain an applied file edit. The end index lets the transcript place a
 * turn's summary directly below its response instead of aggregating all edits
 * at the bottom of the conversation.
 */
export function fileChangeTurnsFromMessages(messages: AlphaMessage[] | undefined, taskKey = "task"): FileChangeTurn[] {
	if (!messages?.length) return []

	const turns: FileChangeTurn[] = []
	let startIndex = 0

	for (let endIndex = 0; endIndex <= messages.length; endIndex++) {
		const nextMessage = messages[endIndex]
		const isTurnBoundary =
			endIndex === messages.length ||
			(endIndex > startIndex && nextMessage?.type === "say" && nextMessage.say === "user_feedback")

		if (!isTurnBoundary) continue

		const turnMessages = messages.slice(startIndex, endIndex)
		if (turnMessages.length > 0 && fileChangesFromMessages(turnMessages).length > 0) {
			turns.push({
				key: `${taskKey}:${turnMessages[0].ts}`,
				endIndex: endIndex - 1,
				messages: turnMessages,
			})
		}

		startIndex = endIndex
	}

	return turns
}
