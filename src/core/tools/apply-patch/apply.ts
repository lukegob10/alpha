/**
 * Core patch application logic for the apply_patch tool.
 * Transforms file contents using parsed hunks.
 */

import type { Hunk, UpdateFileChunk } from "./parser"
import { seekSequence } from "./seek-sequence"

/**
 * Error during patch application.
 */
export class ApplyPatchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ApplyPatchError"
	}
}

/**
 * Result of applying a patch to a file.
 */
export interface ApplyPatchFileChange {
	type: "add" | "delete" | "update"
	/** Original path of the file */
	path: string
	/** New path if the file was moved/renamed */
	movePath?: string
	/** Original content (for delete/update) */
	originalContent?: string
	/** New content (for add/update) */
	newContent?: string
}

/**
 * Compute the replacements needed to transform originalLines into the new lines.
 * Each replacement is [startIndex, oldLength, newLines].
 */
function computeReplacements(
	originalLines: string[],
	filePath: string,
	chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = []
	let lineIndex = 0

	for (const chunk of chunks) {
		// If a chunk has a change_context, find it first
		if (chunk.changeContext !== null) {
			const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
			if (idx === null) {
				throw new ApplyPatchError(`Failed to find context '${chunk.changeContext}' in ${filePath}`)
			}
			lineIndex = idx + 1
		}

		if (chunk.oldLines.length === 0) {
			// Codex b75d1e89665 locates context but appends pure additions at EOF.
			replacements.push([originalLines.length, 0, chunk.newLines])
			continue
		}

		// Try to find the old_lines in the file
		let pattern = chunk.oldLines
		let newSlice = chunk.newLines
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)

		// If not found and pattern ends with empty string (trailing newline),
		// retry without it
		if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1)
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1)
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
		}

		if (found !== null) {
			// Codex CLI 970111f6 preserves parsed context bytes even when fuzzy
			// matching accepted different whitespace or punctuation in the patch.
			let oldStart = 0
			let newStart = 0
			for (const [oldContext, newContext] of chunk.contextLineIndices ?? []) {
				if (oldContext >= pattern.length || newContext >= newSlice.length) break
				if (oldStart !== oldContext || newStart !== newContext) {
					replacements.push([found + oldStart, oldContext - oldStart, newSlice.slice(newStart, newContext)])
				}
				oldStart = oldContext + 1
				newStart = newContext + 1
			}
			if (oldStart !== pattern.length || newStart !== newSlice.length) {
				replacements.push([found + oldStart, pattern.length - oldStart, newSlice.slice(newStart)])
			}
			lineIndex = found + pattern.length
		} else {
			throw new ApplyPatchError(
				`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n").substring(0, 200)}${chunk.oldLines.join("\n").length > 200 ? "..." : ""}`,
			)
		}
	}

	// Sort replacements by start index
	replacements.sort((a, b) => a[0] - b[0])

	return replacements
}

/**
 * Apply replacements to the original lines, returning the modified content.
 * Replacements must be applied in reverse order to preserve indices.
 */
type SourceLine = { text: string; ending: string }

function applyReplacements(
	lines: SourceLine[],
	replacements: Array<[number, number, string[]]>,
	preferredEnding: string,
): SourceLine[] {
	const result = [...lines]

	// Apply in reverse order so earlier replacements don't shift later indices
	for (let i = replacements.length - 1; i >= 0; i--) {
		const [startIdx, oldLen, newSegment] = replacements[i]!

		// Remove old lines
		result.splice(startIdx, oldLen, ...newSegment.map((text) => ({ text, ending: preferredEnding })))
	}

	return result
}

/**
 * Apply chunks to file content, returning the new content.
 *
 * @param originalContent - The original file content
 * @param filePath - The file path (for error messages)
 * @param chunks - The update chunks to apply
 * @returns The new file content
 */
export function applyChunksToContent(originalContent: string, filePath: string, chunks: UpdateFileChunk[]): string {
	const bom = originalContent.startsWith("\uFEFF") ? "\uFEFF" : ""
	const content = originalContent.slice(bom.length)
	// Keep each untouched line's terminator, as Codex b75d1e89665 does, rather
	// than normalizing the entire file when only one region is being patched.
	const sourceLines: SourceLine[] = []
	for (const match of content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
		if (match[0].length > 0) sourceLines.push({ text: match[1]!, ending: match[2]! })
	}
	const preferredEnding = sourceLines.find((line) => line.ending)?.ending ?? "\n"
	const hasTrailingNewline = sourceLines.at(-1)?.ending !== "" && sourceLines.length > 0
	const replacements = computeReplacements(
		sourceLines.map((line) => line.text),
		filePath,
		chunks,
	)
	const newLines = applyReplacements(sourceLines, replacements, preferredEnding)
	// Intentional byte-preservation difference: unlike Codex, an update does not
	// implicitly terminate an originally unterminated file. An explicit added
	// empty line can still supply that terminator.
	return (
		bom +
		newLines
			.map((line, index) => {
				const ending =
					index === newLines.length - 1 && !hasTrailingNewline ? "" : line.ending || preferredEnding
				return line.text + ending
			})
			.join("")
	)
}

/**
 * Process a single hunk and return the file change.
 *
 * @param hunk - The hunk to process
 * @param readFile - Function to read file contents
 * @returns The file change result
 */
export async function processHunk(
	hunk: Hunk,
	readFile: (path: string) => Promise<string>,
): Promise<ApplyPatchFileChange> {
	switch (hunk.type) {
		case "AddFile":
			return {
				type: "add",
				path: hunk.path,
				newContent: hunk.contents,
			}

		case "DeleteFile": {
			const content = await readFile(hunk.path)
			return {
				type: "delete",
				path: hunk.path,
				originalContent: content,
			}
		}

		case "UpdateFile": {
			const originalContent = await readFile(hunk.path)
			const newContent = applyChunksToContent(originalContent, hunk.path, hunk.chunks)
			return {
				type: "update",
				path: hunk.path,
				movePath: hunk.movePath ?? undefined,
				originalContent,
				newContent,
			}
		}
	}
}

/**
 * Process all hunks in a patch.
 *
 * @param hunks - The hunks to process
 * @param readFile - Function to read file contents
 * @returns Array of file changes
 */
export async function processAllHunks(
	hunks: Hunk[],
	readFile: (path: string) => Promise<string>,
): Promise<ApplyPatchFileChange[]> {
	const changes: ApplyPatchFileChange[] = []

	for (const hunk of hunks) {
		const change = await processHunk(hunk, readFile)
		changes.push(change)
	}

	return changes
}
