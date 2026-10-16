import path from "path"
import * as fs from "fs/promises"
import { constants as bufferConstants } from "buffer"
import { t } from "../../../i18n"
import prettyBytes from "pretty-bytes"
import { prepareImageContent, type PreparedImageContent } from "./imageDecoder"

/**
 * Default maximum allowed image file size in bytes (5MB)
 */
export const DEFAULT_MAX_IMAGE_FILE_SIZE_MB = 5

/**
 * Default maximum total memory usage for all images in a single read operation (20MB)
 * This is a cumulative limit - as each image is processed, its size is added to the total.
 * If including another image would exceed this limit, it will be skipped with a notice.
 * Example: With a 20MB limit, reading 3 images of 8MB, 7MB, and 10MB would process
 * the first two (15MB total) but skip the third to stay under the limit.
 */
export const DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB = 20

/**
 * Supported image formats that can be displayed
 */
export const SUPPORTED_IMAGE_FORMATS = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".bmp",
	".ico",
	".tiff",
	".tif",
	".avif",
] as const

export { IMAGE_MIME_TYPES } from "./imageDecoder"

/**
 * Result of image validation
 */
export interface ImageValidationResult {
	isValid: boolean
	reason?: "size_limit" | "memory_limit" | "unsupported_model"
	notice?: string
	sizeInMB?: number
}

/** Bytes and format admitted for local publication, separate from the source file extension. */
export type ImageReadResult = Pick<PreparedImageContent, "sourceExtension" | "outputExtension" | "mimeType"> & {
	dataUrl: string
	buffer: Buffer
}

/**
 * Result of image processing
 */
export interface ImageProcessingResult extends ImageReadResult {
	sizeInKB: number
	sizeInMB: number
	notice: string
}

async function readImageFileWithinLimit(
	filePath: string,
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<Buffer> {
	signal?.throwIfAborted()
	const byteLimit = Math.floor(maxBytes)
	if (
		!Number.isFinite(maxBytes) ||
		byteLimit < 0 ||
		!Number.isSafeInteger(byteLimit + 1) ||
		byteLimit >= bufferConstants.MAX_LENGTH
	) {
		throw new Error(t("tools:readFile.imageChangedAfterValidation"))
	}

	const fileHandle = await fs.open(filePath, "r")
	let readResult: { buffer: Buffer } | { error: unknown }
	try {
		signal?.throwIfAborted()
		// One extra byte detects growth without reading or allocating the rest of the file.
		const readBuffer = Buffer.alloc(byteLimit + 1)
		let totalBytesRead = 0
		while (totalBytesRead < readBuffer.length) {
			signal?.throwIfAborted()
			const { bytesRead } = await fileHandle.read(
				readBuffer,
				totalBytesRead,
				readBuffer.length - totalBytesRead,
				totalBytesRead,
			)
			signal?.throwIfAborted()
			if (bytesRead === 0) {
				break
			}
			totalBytesRead += bytesRead
		}
		if (totalBytesRead > byteLimit) {
			throw new Error(t("tools:readFile.imageChangedAfterValidation"))
		}
		// A smaller published image must not retain the entire read allowance as backing storage.
		const imageBuffer = Buffer.alloc(totalBytesRead)
		readBuffer.copy(imageBuffer, 0, 0, totalBytesRead)
		readResult = { buffer: imageBuffer }
	} catch (error) {
		readResult = { error }
	}

	try {
		await fileHandle.close()
	} catch (error) {
		// Preserve the read, overflow or cancellation failure if cleanup also fails.
		if ("buffer" in readResult) {
			signal?.throwIfAborted()
			throw error
		}
	}
	if ("error" in readResult) {
		throw readResult.error
	}
	return readResult.buffer
}

/** Reads bounded source bytes and prepares the representation admitted for local image publication. */
export async function readImageAsDataUrlWithBuffer(
	filePath: string,
	signal?: AbortSignal,
	maxBytes = DEFAULT_MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024,
): Promise<ImageReadResult> {
	const fileBuffer = await readImageFileWithinLimit(filePath, signal, maxBytes)
	signal?.throwIfAborted()
	const ext = path.extname(filePath).toLowerCase()
	const prepared = await prepareImageContent(fileBuffer, ext, signal, maxBytes)
	if (!prepared) {
		throw new Error(t("tools:readFile.invalidImage"))
	}
	signal?.throwIfAborted()
	// The preparer owns this exact backing buffer after worker teardown; keep raster buffers by identity.
	const buffer = Buffer.isBuffer(prepared.bytes)
		? prepared.bytes
		: Buffer.from(prepared.bytes.buffer, prepared.bytes.byteOffset, prepared.bytes.byteLength)
	const dataUrl = `data:${prepared.mimeType};base64,${buffer.toString("base64")}`

	return {
		dataUrl,
		buffer,
		sourceExtension: prepared.sourceExtension,
		outputExtension: prepared.outputExtension,
		mimeType: prepared.mimeType,
	}
}

/**
 * Checks if a file extension is a supported image format
 */
export function isSupportedImageFormat(extension: string): boolean {
	return SUPPORTED_IMAGE_FORMATS.includes(extension.toLowerCase() as (typeof SUPPORTED_IMAGE_FORMATS)[number])
}

/** Checks prepared-format/signature compatibility after readImageAsDataUrlWithBuffer completes preparation. */
export function isSupportedImageContent(buffer: Buffer, extension: string): boolean {
	const ext = extension.toLowerCase()
	switch (ext) {
		case ".png":
			return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		case ".jpg":
		case ".jpeg":
			return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
		case ".gif": {
			const signature = buffer.subarray(0, 6).toString("ascii")
			return signature === "GIF87a" || signature === "GIF89a"
		}
		case ".webp":
			return (
				buffer.length >= 12 &&
				buffer.toString("ascii", 0, 4) === "RIFF" &&
				buffer.toString("ascii", 8, 12) === "WEBP"
			)
		case ".bmp":
			return buffer.length >= 2 && buffer.toString("ascii", 0, 2) === "BM"
		case ".ico":
			return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))
		case ".tif":
		case ".tiff":
			return (
				buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
				buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])) ||
				buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2b, 0x00])) ||
				buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2b]))
			)
		case ".avif":
			return (
				buffer.length >= 12 &&
				buffer.toString("ascii", 4, 8) === "ftyp" &&
				["avif", "avis"].includes(buffer.toString("ascii", 8, 12))
			)
		case ".svg":
			return /<svg\b/i.test(buffer.toString("utf8"))
		default:
			return false
	}
}

/**
 * Validates if an image can be processed based on size limits and model support
 */
export async function validateImageForProcessing(
	fullPath: string,
	supportsImages: boolean,
	maxImageFileSize: number,
	maxTotalImageSize: number,
	currentTotalMemoryUsed: number,
): Promise<ImageValidationResult> {
	// Check if model supports images
	if (!supportsImages) {
		return {
			isValid: false,
			reason: "unsupported_model",
			notice: "Image file detected but current model does not support images. Skipping image processing.",
		}
	}

	const imageStats = await fs.stat(fullPath)
	const imageSizeInMB = imageStats.size / (1024 * 1024)

	// Check individual file size limit
	if (imageStats.size > maxImageFileSize * 1024 * 1024) {
		const imageSizeFormatted = prettyBytes(imageStats.size)
		return {
			isValid: false,
			reason: "size_limit",
			notice: t("tools:readFile.imageTooLarge", {
				size: imageSizeFormatted,
				max: maxImageFileSize,
			}),
			sizeInMB: imageSizeInMB,
		}
	}

	// Check total memory limit
	if (currentTotalMemoryUsed + imageSizeInMB > maxTotalImageSize) {
		const currentMemoryFormatted = prettyBytes(currentTotalMemoryUsed * 1024 * 1024)
		const fileMemoryFormatted = prettyBytes(imageStats.size)
		return {
			isValid: false,
			reason: "memory_limit",
			notice: `Image skipped to avoid size limit (${maxTotalImageSize}MB). Current: ${currentMemoryFormatted} + this file: ${fileMemoryFormatted}. Try fewer or smaller images.`,
			sizeInMB: imageSizeInMB,
		}
	}

	return {
		isValid: true,
		sizeInMB: imageSizeInMB,
	}
}

/**
 * Processes an image file and returns the result
 */
export async function processImageFile(
	fullPath: string,
	signal?: AbortSignal,
	maxBytes?: number,
): Promise<ImageProcessingResult> {
	const image = await readImageAsDataUrlWithBuffer(fullPath, signal, maxBytes)
	const imageSizeInKB = Math.round(image.buffer.length / 1024)
	const imageSizeInMB = image.buffer.length / (1024 * 1024)
	const noticeText = t("tools:readFile.imageWithSize", { size: imageSizeInKB })

	return {
		...image,
		sizeInKB: imageSizeInKB,
		sizeInMB: imageSizeInMB,
		notice: noticeText,
	}
}

/**
 * Memory tracker for image processing
 */
export class ImageMemoryTracker {
	private totalMemoryUsed: number = 0

	/**
	 * Gets the current total memory used in MB
	 */
	getTotalMemoryUsed(): number {
		return this.totalMemoryUsed
	}

	/**
	 * Adds to the total memory used
	 */
	addMemoryUsage(sizeInMB: number): void {
		this.totalMemoryUsed += sizeInMB
	}

	/**
	 * Resets the memory tracker
	 */
	reset(): void {
		this.totalMemoryUsed = 0
	}
}
