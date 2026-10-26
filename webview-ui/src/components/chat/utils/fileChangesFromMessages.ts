import type { AlphaMessage, AlphaSayTool } from "@alpha-code/types"

import { projectTranscriptTurns, type TranscriptPrompt } from "./transcriptTurns"
import { createMessagePayloadSelector } from "./messagePayload"

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

const fileChangePayload = createMessagePayloadSelector((payload): FileChangePayload | undefined => {
	if (typeof payload?.tool !== "string" || !FILE_EDIT_TOOLS.has(payload.tool)) return undefined
	return payload as FileChangePayload
})

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

		const tool = fileChangePayload(msg)
		if (!tool || (tool.changeStatus !== undefined && tool.changeStatus !== "applied")) {
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
						entry: {
							path: file.path,
							diff: content,
							diffStats: file.diffStats,
							...(typeof file.originalContent === "string"
								? { originalContent: file.originalContent }
								: {}),
							...(typeof file.finalContent === "string" ? { finalContent: file.finalContent } : {}),
							commandExecutionId,
						},
						source,
					})
				}
			}
			continue
		}

		// Single file
		if (typeof tool.path !== "string" || !tool.path) continue
		// Completed edit records store the canonical unified patch in `content`.
		// `diff` is the model's raw edit instruction for apply_diff and may not be
		// renderable as a file diff. Keep the raw value as a compatibility fallback.
		const diff = tool.content ?? tool.diff ?? ""
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
	const pendingPreviewsByPath = new Map<string, number[]>()
	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex]
		if (candidate.source === "ask") {
			const path = normalizedFileChangePath(candidate.entry.path)
			const pendingPreviews = pendingPreviewsByPath.get(path) ?? []
			pendingPreviews.push(candidateIndex)
			pendingPreviewsByPath.set(path, pendingPreviews)
			continue
		}
		if (pendingPreviewsByPath.size === 0) continue
		const path = normalizedFileChangePath(candidate.entry.path)
		const pendingPreviews = pendingPreviewsByPath.get(path)
		if (!pendingPreviews) continue
		// Modern completed-only history has no previews to scan. Legacy previews
		// remain nearest-first, but unrelated paths and consumed previews are skipped.
		for (let pendingIndex = pendingPreviews.length - 1; pendingIndex >= 0; pendingIndex--) {
			const previewIndex = pendingPreviews[pendingIndex]
			if (matchesCompletedEdit(candidates[previewIndex], candidate)) {
				supersededPreviews.add(previewIndex)
				pendingPreviews.splice(pendingIndex, 1)
				if (pendingPreviews.length === 0) pendingPreviewsByPath.delete(path)
				break
			}
		}
	}

	return candidates.flatMap((candidate, index) => (supersededPreviews.has(index) ? [] : [candidate.entry]))
}

/**
 * Uses saved turn attribution, or legacy follow-up boundaries, for applied edits.
 * The end index places each summary below its turn instead of aggregating all
 * edits at the bottom of the conversation.
 */
export function fileChangeTurnsFromMessages(
	messages: AlphaMessage[] | undefined,
	taskKey = "task",
	initialPrompt?: TranscriptPrompt,
): FileChangeTurn[] {
	if (!messages?.length) return []

	const turns: FileChangeTurn[] = []
	for (const turn of projectTranscriptTurns(messages, initialPrompt)) {
		const turnMessages = turn.indices.map((index) => messages[index])
		if (turnMessages.length > 0 && fileChangesFromMessages(turnMessages).length > 0) {
			turns.push({
				key: `${taskKey}:${turn.source === "canonical" ? turn.id : turnMessages[0].ts}`,
				endIndex: turn.indices[turn.indices.length - 1],
				messages: turnMessages,
			})
		}
	}

	return turns
}
