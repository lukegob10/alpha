import * as path from "path"
import * as fs from "fs/promises"

import { mentionRegexGlobal, unescapeSpaces } from "../../shared/context-mentions"
import {
	isSupportedImageFormat,
	readImageAsDataUrlWithBuffer,
	validateImageForProcessing,
	ImageMemoryTracker,
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
} from "../tools/helpers/imageHelpers"

const MAX_IMAGES_PER_MESSAGE = 20

export interface ResolveImageMentionsOptions {
	text: string
	images?: string[]
	cwd: string
	alphaIgnoreController?: { validateAccess: (filePath: string) => boolean }
	/** Whether the current model supports images. Defaults to true. */
	supportsImages?: boolean
	/** Maximum size per image file in MB. Defaults to 5MB. */
	maxImageFileSize?: number
	/** Maximum total size of all images in MB. Defaults to 20MB. */
	maxTotalImageSize?: number
}

export interface ResolveImageMentionsResult {
	text: string
	images: string[]
}

function isPathWithinCwd(absPath: string, cwd: string): boolean {
	const rel = path.relative(cwd, absPath)
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function isImagePathMention(mention: string): boolean {
	if (!mention.startsWith("/")) return false
	const relPath = unescapeSpaces(mention.slice(1))
	return isSupportedImageFormat(path.extname(relPath).toLowerCase())
}

/** True when the text mentions a local image file. Plain text and other mentions are false. */
export function textHasImageMention(text: string): boolean {
	if (!text.includes("@")) return false
	mentionRegexGlobal.lastIndex = 0
	for (const match of text.matchAll(mentionRegexGlobal)) {
		const mention = match[1]
		if (mention && isImagePathMention(mention)) return true
	}
	return false
}

/**
 * Resolves local image file mentions like `@/path/to/image.png` found in `text` into `data:image/...;base64,...`
 * and appends them to the outgoing `images` array.
 *
 * Behavior matches the read_file tool:
 * - Supports the same image formats: png, jpg, jpeg, gif, webp, svg, bmp, ico, tiff, avif
 * - Respects per-file size limits (default 5MB)
 * - Respects total memory limits (default 20MB)
 * - Skips images if model doesn't support them
 * - Respects `.alphaignore` via `alphaIgnoreController.validateAccess` when provided
 */
export async function resolveImageMentions({
	text,
	images,
	cwd,
	alphaIgnoreController,
	supportsImages = true,
	maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
}: ResolveImageMentionsOptions): Promise<ResolveImageMentionsResult> {
	const existingImages = Array.isArray(images) ? images : []
	if (existingImages.length >= MAX_IMAGES_PER_MESSAGE) {
		return { text, images: existingImages.slice(0, MAX_IMAGES_PER_MESSAGE) }
	}

	// If model doesn't support images, skip image processing entirely
	if (!supportsImages) {
		return { text, images: existingImages }
	}

	const mentions = Array.from(text.matchAll(mentionRegexGlobal))
		.map((m) => m[1])
		.filter(Boolean)
	if (mentions.length === 0) {
		return { text, images: existingImages }
	}

	const imageMentions = mentions.filter((mention) => isImagePathMention(mention))

	if (imageMentions.length === 0) {
		return { text, images: existingImages }
	}

	const imageMemoryTracker = new ImageMemoryTracker()
	const newImages: string[] = []

	for (const mention of imageMentions) {
		if (existingImages.length + newImages.length >= MAX_IMAGES_PER_MESSAGE) {
			break
		}

		const relPath = unescapeSpaces(mention.slice(1))
		const absPath = path.resolve(cwd, relPath)
		if (!isPathWithinCwd(absPath, cwd)) {
			continue
		}

		if (alphaIgnoreController && !alphaIgnoreController.validateAccess(relPath)) {
			continue
		}

		// Validate image size limits (matches read_file behavior)
		try {
			const [realCwd, realPath] = await Promise.all([fs.realpath(cwd), fs.realpath(absPath)])
			if (!isPathWithinCwd(realPath, realCwd)) continue
			if (alphaIgnoreController && !alphaIgnoreController.validateAccess(realPath)) continue
			// Read the admitted target so a later alias change cannot redirect the read.
			const validationResult = await validateImageForProcessing(
				realPath,
				supportsImages,
				maxImageFileSize,
				maxTotalImageSize,
				imageMemoryTracker.getTotalMemoryUsed(),
			)

			if (!validationResult.isValid) {
				// Skip this image due to size/memory limits, but continue processing others
				continue
			}

			const { dataUrl, buffer } = await readImageAsDataUrlWithBuffer(
				realPath,
				undefined,
				Math.floor(
					Math.min(maxImageFileSize, maxTotalImageSize - imageMemoryTracker.getTotalMemoryUsed()) *
						1024 *
						1024,
				),
			)
			newImages.push(dataUrl)

			imageMemoryTracker.addMemoryUsage(buffer.length / (1024 * 1024))
		} catch {
			// Fail-soft: skip unreadable/missing files.
			continue
		}
	}

	const merged = [...new Set([...existingImages, ...newImages])].slice(0, MAX_IMAGES_PER_MESSAGE)
	return { text, images: merged }
}
