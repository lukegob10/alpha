import * as fs from "node:fs/promises"
import { HTML_DOCUMENT_LIMITS as limits } from "@alpha-code/types"
import { resolveSourcePath } from "./paths"
import type { SanitizedDocument } from "./sanitize"

/** Inspect headers without decoding pixels or loading a native image library. */
export function rasterInfo(bytes: Buffer): { mime: string; width: number; height: number } {
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR")
			throw new Error("image")
		let end = false
		for (let offset = 8; offset + 12 <= bytes.length; ) {
			const length = bytes.readUInt32BE(offset)
			const kind = bytes.toString("ascii", offset + 4, offset + 8)
			if (length > bytes.length - offset - 12 || kind === "acTL") throw new Error("image")
			offset += length + 12
			if (kind === "IEND") {
				end = length === 0 && offset === bytes.length
				break
			}
		}
		if (!end) throw new Error("image")
		return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
	}
	if (bytes.length > 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
		let dimensions: { mime: string; width: number; height: number } | undefined
		for (let offset = 2; offset + 4 < bytes.length; ) {
			if (bytes[offset++] !== 0xff) break
			while (bytes[offset] === 0xff) offset++
			const marker = bytes[offset++]
			if (offset + 2 > bytes.length) break
			if (marker === 0xda && dimensions) return dimensions
			if (marker === 0xd9) break
			const length = bytes.readUInt16BE(offset)
			if (length < 2 || offset + length > bytes.length) break
			if (marker === 0xc0 || marker === 0xc2) {
				if (length < 8 || dimensions || bytes[offset + 2] !== 8) break
				dimensions = {
					mime: "image/jpeg",
					height: bytes.readUInt16BE(offset + 3),
					width: bytes.readUInt16BE(offset + 5),
				}
			} else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) break
			offset += length
		}
	}
	throw new Error("image")
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** Sequential bounded reads; never widen localResourceRoots or allow remote images. */
export async function hydrateDocumentImages(
	document: SanitizedDocument,
	root: string,
	isCurrent: () => Promise<boolean>,
	unavailable: string,
): Promise<string> {
	let html = document.html
	let totalBytes = 0
	let totalPixels = 0
	for (const [id, image] of document.images) {
		if (!(await isCurrent())) throw new Error("cancelled")
		let replacement = `<span class="image-unavailable">${escape(image.alt)} — ${escape(unavailable)}</span>`
		try {
			const canonical = await resolveSourcePath(root, image.path)
			const handle = await fs.open(canonical, "r")
			let bytes: Buffer
			try {
				if ((await resolveSourcePath(root, image.path)) !== canonical) throw new Error("image")
				const stat = await handle.stat()
				if (!stat.isFile() || stat.size > limits.imageBytes) throw new Error("image")
				const buffer = Buffer.alloc(limits.imageBytes + 1)
				let length = 0
				while (length < buffer.length) {
					const read = await handle.read(buffer, length, buffer.length - length, length)
					if (!read.bytesRead) break
					length += read.bytesRead
				}
				if (length > limits.imageBytes) throw new Error("image")
				bytes = buffer.subarray(0, length)
			} finally {
				await handle.close()
			}
			if (!(await isCurrent())) throw new Error("cancelled")
			if ((await resolveSourcePath(root, image.path)) !== canonical) throw new Error("image")
			const { mime, width, height } = rasterInfo(bytes)
			if (
				!width ||
				!height ||
				width > 4096 ||
				height > 4096 ||
				totalPixels + width * height > limits.imageTotalPixels ||
				totalBytes + bytes.length > limits.imageTotalBytes
			)
				throw new Error("image")
			totalBytes += bytes.length
			totalPixels += width * height
			replacement = `<img alt="${escape(image.alt)}" width="${width}" height="${height}" decoding="async" src="data:${mime};base64,${bytes.toString("base64")}">`
		} catch (error) {
			if (error instanceof Error && error.message === "cancelled") throw error
			// A missing, unsupported or out-of-scope image must not hide the document.
		}
		html = html.replace(`<span data-alpha-image="${id}"></span>`, () => replacement)
	}
	return html
}
