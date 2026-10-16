import { constants as bufferConstants } from "node:buffer"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import {
	ConfigurationFiles,
	initializeImageMagick,
	MagickError,
	MagickErrorSeverity,
	MagickColors,
	MagickFormat,
	MagickImage,
	MagickReadSettings,
	ResourceLimits,
} from "@imagemagick/magick-wasm"

import type { ImageDecodeRequest, ImageDecodeResult } from "../core/tools/helpers/imageDecoder"
import { isSvgSourceAllowed } from "./svgPreflight"

const MAX_IMAGE_PIXELS = 16_777_216
const MAX_IMAGE_DIMENSION = 32_768
const MAX_IMAGE_MEMORY_BYTES = 128n * 1024n * 1024n
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024
// ImageMagick's list-length resource bound is exclusive: 2 admits at most one decoded frame.
const IMAGE_LIST_RESOURCE_LIMIT = 2n
const SVG_SCRATCH_PATTERN = "/dev/shm/tmp/magick-" + "[-A-Za-z0-9_]".repeat(32)
const SVG_COLORS = { fileName: "colors.xml", data: "<colormap/>" }
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const PNG_PIXEL_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"])

const formats: Readonly<Record<string, MagickFormat>> = {
	".png": MagickFormat.Png,
	".jpg": MagickFormat.Jpeg,
	".jpeg": MagickFormat.Jpeg,
	".gif": MagickFormat.Gif,
	".webp": MagickFormat.WebP,
	".svg": MagickFormat.Msvg,
	".bmp": MagickFormat.Bmp,
	".ico": MagickFormat.Ico,
	".tiff": MagickFormat.Tiff,
	".tif": MagickFormat.Tiff,
	".avif": MagickFormat.Avif,
}

let initialization: { svg: boolean; promise: Promise<void> } | undefined

class ImageDecodeLimitError extends Error {}
class ImagePreparationError extends Error {}

const resourceLimitSeverities = new Set<number>([
	MagickErrorSeverity.ResourceLimitError,
	MagickErrorSeverity.ResourceLimitWarning,
	MagickErrorSeverity.CacheError,
	MagickErrorSeverity.CacheWarning,
])

function isResourceLimit(error: unknown): boolean {
	return error instanceof MagickError && resourceLimitSeverities.has(error.severity)
}

async function initializeDecoder(wasmBytes: Uint8Array, svg: boolean): Promise<void> {
	const configuration = ConfigurationFiles.default
	configuration.policy.data = `<?xml version="1.0" encoding="UTF-8"?>
<policymap>
	<policy domain="delegate" rights="none" pattern="*" />
	<policy domain="filter" rights="none" pattern="*" />
	<policy domain="path" rights="none" pattern="*" />
	<policy domain="coder" rights="none" pattern="*" />
	<policy domain="coder" rights="read" pattern="{AVIF,BMP,GIF,HEIC,HEIF,ICO,JPEG,MSVG,PNG,SVG,TIFF,WEBP}" />
	<policy domain="resource" name="disk" value="0" />
	<policy domain="resource" name="map" value="0" />
	<policy domain="resource" name="area" value="16777216" />
	<policy domain="resource" name="memory" value="128MiB" />
	<policy domain="resource" name="max-memory-request" value="64MiB" />
	<policy domain="resource" name="max-profile-size" value="1MiB" />
	<policy domain="resource" name="width" value="32768" />
	<policy domain="resource" name="height" value="32768" />
	<policy domain="resource" name="list-length" value="${IMAGE_LIST_RESOURCE_LIMIT}" />
	<policy domain="resource" name="time" value="2" />
</policymap>`
	if (svg) {
		// SVG-only: the studied private scratch read and MVG decode, then in-memory PNG encoding.
		const additions = [
			'\t<policy domain="resource" name="temporary-path" value="/dev/shm/tmp" />',
			`\t<policy domain="path" rights="read" pattern="${SVG_SCRATCH_PATTERN}" />`,
			'\t<policy domain="coder" rights="read" pattern="MVG" />',
			'\t<policy domain="coder" rights="read|write" pattern="PNG" />',
		]
		configuration.policy.data = configuration.policy.data.replace(
			"</policymap>",
			additions.join("\n") + "\n</policymap>",
		)
		// The official colors configuration has an empty active map; compiled named colors remain available.
		await initializeImageMagick(wasmBytes, {
			log: configuration.log,
			policy: configuration.policy,
			*all() {
				yield* configuration.all()
				yield SVG_COLORS
			},
		})
	} else {
		await initializeImageMagick(wasmBytes, configuration)
	}
	ResourceLimits.disk = 0n
	ResourceLimits.area = BigInt(MAX_IMAGE_PIXELS)
	ResourceLimits.memory = MAX_IMAGE_MEMORY_BYTES
	ResourceLimits.maxMemoryRequest = MAX_IMAGE_MEMORY_BYTES / 2n
	ResourceLimits.maxProfileSize = 1024n * 1024n
	ResourceLimits.width = BigInt(MAX_IMAGE_DIMENSION)
	ResourceLimits.height = BigInt(MAX_IMAGE_DIMENSION)
	ResourceLimits.listLength = IMAGE_LIST_RESOURCE_LIMIT
	ResourceLimits.time = 2n
}

/** Only pixel-bearing PNG chunks survive; tRNS has pixel alpha meaning, not source XML or profiles. */
function hasOnlyPngPixelChunks(bytes: Uint8Array, width: number, height: number): boolean {
	if (bytes.length <= 57 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return false
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let offset = 8
	let pixels = false
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset)
		const end = offset + 12 + length
		if (end > bytes.length) return false
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
		if (!PNG_PIXEL_CHUNKS.has(type)) return false
		if (offset === 8) {
			if (
				type !== "IHDR" ||
				length !== 13 ||
				view.getUint32(offset + 8) !== width ||
				view.getUint32(offset + 12) !== height
			)
				return false
		} else if (type === "IHDR") return false
		if (type === "IDAT" && length > 0) pixels = true
		if (type === "IEND") return length === 0 && pixels && end === bytes.length
		offset = end
	}
	return false
}

/** Ping bounds allocation; success requires full first-frame decode and SVG output preparation. */
export async function decodeImageContent(
	bytes: Uint8Array,
	extension: string,
	wasmBytes: Uint8Array,
	maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<ImageDecodeResult> {
	const ext = extension.toLowerCase()
	const invalid: ImageDecodeResult = { kind: "invalid", sourceExtension: ext }
	const format = Object.hasOwn(formats, ext) ? formats[ext] : undefined
	if (!format || !(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length === 0) {
		return invalid
	}
	if (
		!Number.isSafeInteger(maxOutputBytes) ||
		maxOutputBytes < 0 ||
		maxOutputBytes >= bufferConstants.MAX_LENGTH ||
		bytes.length > maxOutputBytes
	) {
		return { kind: "failure", sourceExtension: ext, failure: "resource_limit" }
	}
	const svg = ext === ".svg"
	if (svg && !isSvgSourceAllowed(bytes, maxOutputBytes)) return invalid
	// The owner uses one request per worker; direct callers cannot change an initialized policy.
	if (initialization !== undefined && initialization.svg !== svg) throw new ImagePreparationError()
	initialization ??= { svg, promise: initializeDecoder(wasmBytes, svg) }
	await initialization.promise
	const image = MagickImage.create()
	let preparing = false
	try {
		let warning = false
		let resourceLimited = false
		image.onWarning = ({ error }) => {
			warning = true
			resourceLimited ||= isResourceLimit(error)
		}
		// In magick-wasm 0.0.44, omitting frameCount keeps native scenes at scalar "0".
		const settings = new MagickReadSettings({
			format,
			frameIndex: 0,
			...(svg ? { backgroundColor: MagickColors.Transparent } : {}),
		})
		image.ping(bytes, settings)
		if (resourceLimited) throw new ImageDecodeLimitError()
		if (warning) return invalid
		if (image.width <= 0 || image.height <= 0) return invalid
		if (
			image.width > MAX_IMAGE_DIMENSION ||
			image.height > MAX_IMAGE_DIMENSION ||
			image.width * image.height > MAX_IMAGE_PIXELS
		) {
			throw new ImageDecodeLimitError()
		}
		image.read(bytes, settings)
		if (resourceLimited || image.width * image.height > MAX_IMAGE_PIXELS) throw new ImageDecodeLimitError()
		const signature = image.signature
		if (resourceLimited) throw new ImageDecodeLimitError()
		if (warning || image.width <= 0 || image.height <= 0 || !signature) return invalid
		if (!svg) return { kind: "original", sourceExtension: ext }

		preparing = true
		image.strip()
		for (const name of image.attributeNames) image.removeAttribute(name)
		for (const name of image.artifactNames) image.removeArtifact(name)
		for (const suffix of ["include-chunk", "include-chunks", "exclude-chunk", "exclude-chunks", "preserve-iCCP"]) {
			image.settings.removeDefine(`png:${suffix}`)
		}
		image.settings.setDefine("png:exclude-chunk", "all")
		if (resourceLimited) throw new ImageDecodeLimitError()
		if (warning) throw new ImagePreparationError()
		const preparedBytes = image.write(MagickFormat.Png, (data) => {
			if (data.length > maxOutputBytes) throw new ImageDecodeLimitError()
			if (!hasOnlyPngPixelChunks(data, image.width, image.height)) throw new ImagePreparationError()
			// Public write() disposes its native buffer after this callback. Never return that heap view.
			const owned = new Uint8Array(data.length)
			owned.set(data)
			return owned
		})
		if (resourceLimited) throw new ImageDecodeLimitError()
		if (warning) throw new ImagePreparationError()
		return {
			kind: "prepared",
			sourceExtension: ".svg",
			outputExtension: ".png",
			mimeType: "image/png",
			bytes: preparedBytes,
		}
	} catch (error) {
		if (error instanceof ImageDecodeLimitError || isResourceLimit(error)) {
			return { kind: "failure", sourceExtension: ext, failure: "resource_limit" }
		}
		if (preparing || error instanceof ImagePreparationError) {
			return { kind: "failure", sourceExtension: ext, failure: "preparation" }
		}
		if (error instanceof MagickError) return invalid
		throw error
	} finally {
		image.dispose()
	}
}

parentPort?.once("message", async ({ bytes, extension, maxOutputBytes }: ImageDecodeRequest) => {
	try {
		const wasmBytes = await readFile(path.join(__dirname, "magick.wasm"))
		const result = await decodeImageContent(bytes, extension, wasmBytes, maxOutputBytes)
		parentPort?.postMessage(result)
	} catch (error) {
		const failure =
			error instanceof ImageDecodeLimitError
				? "resource_limit"
				: error instanceof ImagePreparationError
					? "preparation"
					: "initialization"
		// Initialization, encoder and cleanup failures are operational; no source-SVG fallback exists.
		parentPort?.postMessage({ kind: "failure", sourceExtension: extension, failure } satisfies ImageDecodeResult)
	}
})
