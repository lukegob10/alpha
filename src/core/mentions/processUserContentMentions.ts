import Anthropic from "@anthropic-ai/sdk"

import { parseMentions, ParseMentionsResult, MentionContentBlock, type LoadedMentionSkill } from "./index"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import type { SkillLookup } from "../../services/skills/skillInvocation"
import { getSkillLookupForInput } from "../../services/skills/skillInvocationProvenance"
import type { TicketActivity } from "@alpha-code/types"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { finalizeUserContentMentionAttachments } from "./attachmentBudget"

export { finalizeUserContentMentionAttachments }

// Internal aliases for the Anthropic content block subtypes used during processing.
type TextPart = Anthropic.Messages.TextBlockParam
type ImagePart = Anthropic.Messages.ImageBlockParam
type ToolResultPart = Anthropic.Messages.ToolResultBlockParam
type InputOrigin = "human" | "agent"

export interface ProcessUserContentMentionsResult {
	content: Anthropic.Messages.ContentBlockParam[]
	mode?: string // Mode from the first slash command that has one
	loadedSkills?: readonly LoadedMentionSkill[]
	blockOrigins?: ReadonlyMap<Anthropic.Messages.ContentBlockParam, InputOrigin>
	/** Host-owned identities for one deferred batch admission; never persist these handles. */
	deferredAttachmentParts?: ReadonlySet<TextPart>
}

/**
 * Converts MentionContentBlocks to TextPart blocks.
 * Each file/folder mention becomes a separate text block formatted
 * to look like a read_file tool result.
 */
function contentBlocksToTextParts(contentBlocks: MentionContentBlock[], attachmentParts: Set<TextPart>): TextPart[] {
	return contentBlocks.map((block) => {
		const part: TextPart = { type: "text", text: block.content }
		if (block.type === "file" || block.type === "folder") attachmentParts.add(part)
		return part
	})
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
	deferAttachmentBudget = false,
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
	/** The caller owns a larger queued-input batch and finalizes it before persistence/dispatch. */
	deferAttachmentBudget?: boolean
}): Promise<ProcessUserContentMentionsResult> {
	signal?.throwIfAborted()
	// Snapshot every origin before parsing can await or the caller can mutate its map.
	const sourceBlockOrigins = inputBlockOrigins
		? userContent.map((block) => inputBlockOrigins.get(block) ?? "agent")
		: undefined
	const blockOrigins = sourceBlockOrigins ? new Map<Anthropic.Messages.ContentBlockParam, InputOrigin>() : undefined
	const attachmentParts = new Set<TextPart>()
	const commandModes: Array<{ blockIndex: number; contentIndex: number; mode: string }> = []
	const expandedSkills: Array<{ blockIndex: number; contentIndex: number; skill: LoadedMentionSkill }> = []
	const captureParseResult = (result: ParseMentionsResult, blockIndex: number, contentIndex: number) => {
		if (result.mode) {
			commandModes.push({ blockIndex, contentIndex, mode: result.mode })
		}
		for (const skill of result.loadedSkills ?? []) expandedSkills.push({ blockIndex, contentIndex, skill })
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
						captureParseResult(result, blockIndex, 0)

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
							blocks.push(...contentBlocksToTextParts(result.contentBlocks, attachmentParts))
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
							captureParseResult(result, blockIndex, 0)

							// Build content array with file blocks included
							const contentParts: Array<{ type: "text"; text: string }> = [
								{
									type: "text" as const,
									text: result.text,
								},
							]

							// Add file/folder content blocks
							contentParts.push(...contentBlocksToTextParts(result.contentBlocks, attachmentParts))

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
										captureParseResult(result, blockIndex, contentIndex)

										// Build blocks array with file content
										const blocks: Array<{ type: "text"; text: string }> = [
											{
												...contentBlock,
												text: result.text,
											},
										]

										// Add file/folder content blocks
										blocks.push(...contentBlocksToTextParts(result.contentBlocks, attachmentParts))

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
	const loadedSkills: LoadedMentionSkill[] = []
	const loadedSkillPaths = new Set<string>()
	for (const { skill } of expandedSkills.sort(
		(a, b) => a.blockIndex - b.blockIndex || a.contentIndex - b.contentIndex,
	)) {
		if (loadedSkillPaths.has(skill.path)) continue
		loadedSkillPaths.add(skill.path)
		loadedSkills.push(skill)
	}

	const result: ProcessUserContentMentionsResult = {
		content: content as Anthropic.Messages.ContentBlockParam[],
		mode: commandMode,
		...(blockOrigins ? { blockOrigins } : {}),
		deferredAttachmentParts: attachmentParts,
		...(loadedSkills.length ? { loadedSkills } : {}),
	}
	return deferAttachmentBudget ? result : finalizeUserContentMentionAttachments([result])[0]!
}
