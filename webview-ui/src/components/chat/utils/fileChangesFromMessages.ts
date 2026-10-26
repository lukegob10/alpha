import type { AlphaMessage } from "@alpha-code/types"

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

interface FileChangePayload {
	entries: FileChangeEntry[]
	previewContent?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

const stringField = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function fileChangeEntry(
	payload: Record<string, unknown>,
	diff: string | undefined,
	commandExecutionId: string | undefined,
): FileChangeEntry | undefined {
	if (typeof payload.path !== "string" || !payload.path || !diff) return undefined
	const stats = payload.diffStats
	const diffStats =
		isRecord(stats) &&
		typeof stats.added === "number" &&
		typeof stats.removed === "number" &&
		Number.isFinite(stats.added) &&
		Number.isFinite(stats.removed)
			? { added: stats.added, removed: stats.removed }
			: undefined
	return {
		path: payload.path,
		diff,
		diffStats,
		originalContent: stringField(payload.originalContent),
		finalContent: stringField(payload.finalContent),
		commandExecutionId,
	}
}

const fileChangePayload = createMessagePayloadSelector((payload): FileChangePayload | undefined => {
	if (
		typeof payload?.tool !== "string" ||
		!FILE_EDIT_TOOLS.has(payload.tool) ||
		(payload.changeStatus !== undefined && payload.changeStatus !== "applied")
	) {
		return undefined
	}
	// Saved tool JSON is untrusted. Cache only validated fields used by review;
	// unrelated tool fields and malformed batch members never reach diff rendering.
	const batchDiffs = payload.batchDiffs
	const isBatch = Array.isArray(batchDiffs)
	const files = isBatch ? batchDiffs.filter(isRecord) : [payload]
	const commandExecutionId = stringField(payload.commandExecutionId)
	const entries = files.flatMap((file: Record<string, unknown>) => {
		// Completed records prefer the captured unified patch over legacy edit instructions.
		let diff = stringField(file.content)
		if (diff === undefined) {
			if (isBatch && Array.isArray(file.diffs)) {
				diff = file.diffs
					.flatMap((chunk: unknown) =>
						isRecord(chunk) && typeof chunk.content === "string" ? [chunk.content] : [],
					)
					.join("\n")
			} else if (!isBatch) {
				// Legacy single-file previews can store their patch in `diff`.
				diff = stringField(file.diff)
			}
		}
		const entry = fileChangeEntry(file, diff, commandExecutionId)
		return entry ? [entry] : []
	})
	return { entries, previewContent: isBatch ? undefined : stringField(payload.content) }
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
		if (!tool) continue
		const source = isSayTool ? "say" : "ask"
		for (const entry of tool.entries) {
			candidates.push({
				entry: { ...entry, commandExecutionId: entry.commandExecutionId ?? msg.commandExecutionId },
				source,
				previewContent: isAskTool ? tool.previewContent : undefined,
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
