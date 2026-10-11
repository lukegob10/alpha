import Anthropic from "@anthropic-ai/sdk"

import { parseMentions, ParseMentionsResult, MentionContentBlock } from "./index"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import type { SkillLookup } from "../../services/skills/skillInvocation"
import { getSkillLookupForInput } from "../../services/skills/skillInvocationProvenance"
import type { TicketActivity } from "@alpha-code/types"
import { sanitizeToolUseId } from "../../utils/tool-id"

// Internal aliases for the Anthropic content block subtypes used during processing.
type TextPart = Anthropic.Messages.TextBlockParam
type ImagePart = Anthropic.Messages.ImageBlockParam
type ToolResultPart = Anthropic.Messages.ToolResultBlockParam
type InputOrigin = "human" | "agent"

export interface ProcessUserContentMentionsResult {
	content: Anthropic.Messages.ContentBlockParam[]
	mode?: string // Mode from the first slash command that has one
	blockOrigins?: ReadonlyMap<Anthropic.Messages.ContentBlockParam, InputOrigin>
}

/**
 * Converts MentionContentBlocks to TextPart blocks.
 * Each file/folder mention becomes a separate text block formatted
 * to look like a read_file tool result.
 */
function contentBlocksToTextParts(contentBlocks: MentionContentBlock[]): TextPart[] {
	return contentBlocks.map((block) => ({
		type: "text" as const,
		text: block.content,
	}))
}

/**
 * Process mentions in user content, specifically within task and feedback tags.
 *
 * File/folder @ mentions are now returned as separate text blocks that
 * look like read_file tool results, making it clear to the model that
 * the file has already been read.
 */
export async function processUserContentMentions({
	userContent,
	cwd,
	fileContextTracker,
	alphaIgnoreController,
	showRooIgnoredFiles = false,
	includeDiagnosticMessages = true,
	maxDiagnosticMessages = 50,
	skillsManager,
	inputOrigin = "human",
	inputBlockOrigins,
	humanFeedbackToolResultIds,
	currentMode = "code",
	onTicketActivity,
	signal,
}: {
	userContent: Anthropic.Messages.ContentBlockParam[]
	cwd: string
	fileContextTracker: FileContextTracker
	alphaIgnoreController?: any
	showRooIgnoredFiles?: boolean
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	skillsManager?: SkillLookup
	/** Host-owned message provenance; markup in external text cannot supply it. */
	inputOrigin?: InputOrigin
	/** Host-owned block provenance; missing entries in a supplied map are agent input. */
	inputBlockOrigins?: ReadonlyMap<Anthropic.Messages.ContentBlockParam, InputOrigin>
	/** Successful feedback calls matched against the host's accepted assistant history. */
	humanFeedbackToolResultIds?: ReadonlySet<string>
	currentMode?: string
	onTicketActivity?: (activity: TicketActivity) => Promise<void>
	signal?: AbortSignal
}): Promise<ProcessUserContentMentionsResult> {
	signal?.throwIfAborted()
	// Snapshot every origin before parsing can await or the caller can mutate its map.
	const sourceBlockOrigins = inputBlockOrigins
		? userContent.map((block) => inputBlockOrigins.get(block) ?? "agent")
		: undefined
	const blockOrigins = sourceBlockOrigins ? new Map<Anthropic.Messages.ContentBlockParam, InputOrigin>() : undefined
	const commandModes: Array<{ blockIndex: number; contentIndex: number; mode: string }> = []
	const captureCommandMode = (mode: string | undefined, blockIndex: number, contentIndex: number) => {
		if (mode) {
			commandModes.push({ blockIndex, contentIndex, mode })
		}
	}

	// Process userContent array, which contains text and image parts.
	// We need to apply parseMentions() to TextPart's text that contains "<user_message>".
	const content = (
		await Promise.all(
			userContent.map(async (block, blockIndex) => {
				const shouldProcessMentions = (text: string) => text.includes("<user_message>")

				if (block.type === "text") {
					if (shouldProcessMentions(block.text)) {
						const textSkillLookup = getSkillLookupForInput(
							skillsManager,
							(sourceBlockOrigins?.[blockIndex] ?? inputOrigin) === "human",
						)
						const result = await parseMentions(
							block.text,
							cwd,
							fileContextTracker,
							alphaIgnoreController,
							showRooIgnoredFiles,
							includeDiagnosticMessages,
							maxDiagnosticMessages,
							textSkillLookup,
							currentMode,
							onTicketActivity,
							signal,
						)
						captureCommandMode(result.mode, blockIndex, 0)

						// Build the blocks array:
						// 1. User's text (with @ mentions replaced by clean paths)
						// 2. File/folder content blocks (formatted like read_file results)
						// 3. Slash command help (if any)
						const blocks: Array<TextPart | ImagePart> = [
							{
								...block,
								text: result.text,
							},
						]

						// Add file/folder content as separate blocks
						if (result.contentBlocks.length > 0) {
							blocks.push(...contentBlocksToTextParts(result.contentBlocks))
						}

						if (result.slashCommandHelp) {
							blocks.push({
								type: "text" as const,
								text: result.slashCommandHelp,
							})
						}
						return blocks
					}

					return block
				} else if (block.type === "tool_result") {
					const feedbackSkillLookup = getSkillLookupForInput(
						skillsManager,
						block.is_error !== true &&
							(humanFeedbackToolResultIds?.has(sanitizeToolUseId(block.tool_use_id)) ?? false),
					)
					if (typeof block.content === "string") {
						if (shouldProcessMentions(block.content)) {
							const result = await parseMentions(
								block.content,
								cwd,
								fileContextTracker,
								alphaIgnoreController,
								showRooIgnoredFiles,
								includeDiagnosticMessages,
								maxDiagnosticMessages,
								feedbackSkillLookup,
								currentMode,
								onTicketActivity,
								signal,
							)
							captureCommandMode(result.mode, blockIndex, 0)

							// Build content array with file blocks included
							const contentParts: Array<{ type: "text"; text: string }> = [
								{
									type: "text" as const,
									text: result.text,
								},
							]

							// Add file/folder content blocks
							for (const contentBlock of result.contentBlocks) {
								contentParts.push({
									type: "text" as const,
									text: contentBlock.content,
								})
							}

							if (result.slashCommandHelp) {
								contentParts.push({
									type: "text" as const,
									text: result.slashCommandHelp,
								})
							}

							return {
								...block,
								content: contentParts,
							}
						}

						return block
					} else if (Array.isArray(block.content)) {
						const parsedContent = (
							await Promise.all(
								block.content.map(async (contentBlock, contentIndex) => {
									if (contentBlock.type === "text" && shouldProcessMentions(contentBlock.text)) {
										const result = await parseMentions(
											contentBlock.text,
											cwd,
											fileContextTracker,
											alphaIgnoreController,
											showRooIgnoredFiles,
											includeDiagnosticMessages,
											maxDiagnosticMessages,
											feedbackSkillLookup,
											currentMode,
											onTicketActivity,
											signal,
										)
										captureCommandMode(result.mode, blockIndex, contentIndex)

										// Build blocks array with file content
										const blocks: Array<{ type: "text"; text: string }> = [
											{
												...contentBlock,
												text: result.text,
											},
										]

										// Add file/folder content blocks
										for (const cb of result.contentBlocks) {
											blocks.push({
												type: "text" as const,
												text: cb.content,
											})
										}

										if (result.slashCommandHelp) {
											blocks.push({
												type: "text" as const,
												text: result.slashCommandHelp,
											})
										}
										return blocks
									}

									return contentBlock
								}),
							)
						).flat()

						return { ...block, content: parsedContent }
					}

					return block
				}

				// Legacy backward compat: tool_result / tool-result blocks from older formats
				// are passed through unchanged (tool results are now in separate RooToolMessages).
				return block
			}),
		)
	).flatMap((processed, blockIndex) => {
		const blocks = Array.isArray(processed) ? processed : [processed]
		if (blockOrigins && sourceBlockOrigins) {
			for (const [index, block] of blocks.entries()) {
				blockOrigins.set(block, index === 0 ? sourceBlockOrigins[blockIndex] : "agent")
			}
		}
		return blocks
	})
	signal?.throwIfAborted()
	const commandMode = commandModes.sort((a, b) => a.blockIndex - b.blockIndex || a.contentIndex - b.contentIndex)[0]
		?.mode

	return {
		content: content as Anthropic.Messages.ContentBlockParam[],
		mode: commandMode,
		...(blockOrigins ? { blockOrigins } : {}),
	}
}
