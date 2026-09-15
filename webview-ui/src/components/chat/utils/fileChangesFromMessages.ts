import type { ClineMessage, ClineSayTool } from "@alpha-code/types"
import { safeJsonParse } from "@alpha/core"

/** File-edit tool names from ClineSayTool["tool"] plus compatibility aliases. */
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
}

export interface FileChangeTurn {
	/** Stable identity for the turn's panel, even while later messages stream in. */
	key: string
	/** Index of the last rendered message in this turn. */
	endIndex: number
	messages: ClineMessage[]
}

/**
 * Derives a list of file changes from clineMessages for the current conversation.
 * Includes:
 * - type "say" + say "tool" (applied tool results, if any are ever pushed that way)
 * - type "ask" + ask "tool" (tool approval messages; after approval the message stays as ask, so this is where file edits appear in the UI)
 */
export function fileChangesFromMessages(messages: ClineMessage[] | undefined): FileChangeEntry[] {
	if (!messages?.length) return []

	const entries: FileChangeEntry[] = []

	for (const msg of messages) {
		// Tool payload can be in say "tool" (rare) or ask "tool" (how file edits are stored after approval)
		const isSayTool = msg.type === "say" && msg.say === "tool"
		const isAskTool = msg.type === "ask" && msg.ask === "tool"
		if ((!isSayTool && !isAskTool) || !msg.text || msg.partial) continue
		// Only include ask "tool" file edits that the user (or auto-approval) has approved
		if (isAskTool && !msg.isAnswered) continue

		const tool = safeJsonParse<ClineSayTool>(msg.text)
		if (!tool || !FILE_EDIT_TOOLS.has(tool.tool as string)) continue

		// Batch diffs
		if (tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
			for (const file of tool.batchDiffs) {
				if (!file.path) continue
				const content = file.content ?? file.diffs?.map((d) => d.content).join("\n") ?? ""
				if (content) {
					entries.push({
						path: file.path,
						diff: content,
						diffStats: file.diffStats,
					})
				}
			}
			continue
		}

		// Single file
		if (!tool.path) continue
		const diff = tool.diff ?? tool.content ?? ""
		if (diff) {
			entries.push({
				path: tool.path,
				diff,
				diffStats: tool.diffStats,
				originalContent: tool.originalContent,
			})
		}
	}

	return entries
}

/**
 * Splits rendered transcript messages at user follow-ups and returns only turns
 * that contain an applied file edit. The end index lets the transcript place a
 * turn's summary directly below its response instead of aggregating all edits
 * at the bottom of the conversation.
 */
export function fileChangeTurnsFromMessages(messages: ClineMessage[] | undefined, taskKey = "task"): FileChangeTurn[] {
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
