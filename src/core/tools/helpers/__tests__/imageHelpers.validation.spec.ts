import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { readImageAsDataUrlWithBuffer } from "../imageHelpers"
import i18next from "../../../../i18n"
import toolTranslations from "../../../../i18n/locales/en/tools.json"

beforeAll(() => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
})

vi.mock("node:worker_threads", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:worker_threads")>()
	const nodePath = await import("node:path")
	class ImageValidationTestWorker extends original.Worker {
		constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
			const workerPath =
				typeof filename === "string" && nodePath.basename(filename) === "validateImage.js"
					? (process.env.ALPHA_TEST_IMAGE_WORKER_PATH ??
						nodePath.resolve(process.cwd(), "dist/workers/validateImage.js"))
					: filename
			super(workerPath, options)
		}
	}
	return { ...original, Worker: ImageValidationTestWorker }
})

const pngBytes = Buffer.from([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
	137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94, 171, 63, 0, 0, 0, 0, 73, 69, 78,
	68, 174, 66, 96, 130,
])

describe("image helper full decode boundary", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-image-helper-validation-"))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
	})

	it.each([
		{ name: "PNG", extension: ".png", bytes: pngBytes.subarray(0, 8) },
		{ name: "JPEG", extension: ".jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
		{ name: "GIF", extension: ".gif", bytes: Buffer.from("GIF89a") },
	])("rejects a signature-only $name before creating a data URL", async ({ extension, bytes }) => {
		const imagePath = path.join(workspace, `signature${extension}`)
		await writeFile(imagePath, bytes)

		await expect(readImageAsDataUrlWithBuffer(imagePath)).rejects.toThrow(/invalid|unsupported/i)
	})

	it.each([
		{ name: "PNG", extension: ".png", bytes: pngBytes.subarray(0, 33) },
		{ name: "JPEG", extension: ".jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]) },
		{ name: "GIF", extension: ".gif", bytes: Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0]) },
	])("rejects a truncated $name with a plausible header", async ({ extension, bytes }) => {
		const imagePath = path.join(workspace, `truncated${extension}`)
		await writeFile(imagePath, bytes)

		await expect(readImageAsDataUrlWithBuffer(imagePath)).rejects.toThrow(/invalid|unsupported/i)
	})

	it("rejects an invalid PNG pixel stream even when dimensions are present", async () => {
		const invalidPixelStream = Buffer.from(pngBytes)
		invalidPixelStream[41] = 0
		const imagePath = path.join(workspace, "corrupt.png")
		await writeFile(imagePath, invalidPixelStream)

		await expect(readImageAsDataUrlWithBuffer(imagePath)).rejects.toThrow(/invalid|unsupported/i)
	})

	it("returns unchanged original bytes for a decodable image", async () => {
		const imagePath = path.join(workspace, "pixel.png")
		await writeFile(imagePath, pngBytes)

		const result = await readImageAsDataUrlWithBuffer(imagePath)

		expect(result.buffer).toEqual(pngBytes)
		expect(result.dataUrl).toBe(`data:image/png;base64,${pngBytes.toString("base64")}`)
		expect(result).toMatchObject({ sourceExtension: ".png", outputExtension: ".png", mimeType: "image/png" })
	})

	it("prepares a literal SVG as PNG through the production helper", async () => {
		const svgBytes = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
		)
		const imagePath = path.join(workspace, "square.svg")
		await writeFile(imagePath, svgBytes)

		const result = await readImageAsDataUrlWithBuffer(imagePath)

		expect(result).toMatchObject({ sourceExtension: ".svg", outputExtension: ".png", mimeType: "image/png" })
		expect(result.buffer.subarray(0, 8)).toEqual(pngBytes.subarray(0, 8))
		expect(result.dataUrl).toBe(`data:image/png;base64,${result.buffer.toString("base64")}`)
		expect(await readFile(imagePath)).toEqual(svgBytes)
	})

	it("decodes the repository animated GIF through the production first-frame policy", async () => {
		const gifBytes = await readFile(path.join(process.cwd(), "assets/docs/demo.gif"))
		const imagePath = path.join(workspace, "animation.gif")
		await writeFile(imagePath, gifBytes)

		const result = await readImageAsDataUrlWithBuffer(imagePath, undefined, gifBytes.length)

		expect(result.buffer.equals(gifBytes)).toBe(true)
		expect(result.dataUrl.startsWith("data:image/gif;base64,")).toBe(true)
		expect(Buffer.from(result.dataUrl.slice(result.dataUrl.indexOf(",") + 1), "base64").equals(gifBytes)).toBe(true)
		expect(result).toMatchObject({ sourceExtension: ".gif", outputExtension: ".gif", mimeType: "image/gif" })
	})

	it.each([".jpeg", ".txt"])("rejects a PNG presented as %s", async (extension) => {
		const imagePath = path.join(workspace, `mismatch${extension}`)
		await writeFile(imagePath, pngBytes)

		await expect(readImageAsDataUrlWithBuffer(imagePath)).rejects.toThrow(/invalid|unsupported/i)
	})

	it("bounds encoded bytes while reading and before decoding", async () => {
		const imagePath = path.join(workspace, "pixel.png")
		await writeFile(imagePath, pngBytes)

		await expect(readImageAsDataUrlWithBuffer(imagePath, undefined, pngBytes.length - 1)).rejects.toThrow(
			/size limit/i,
		)
	})

	it("propagates an already cancelled read without publishing bytes", async () => {
		const controller = new AbortController()
		const reason = new Error("image read cancelled")
		controller.abort(reason)
		const imagePath = path.join(workspace, "pixel.png")
		await writeFile(imagePath, pngBytes)

		await expect(readImageAsDataUrlWithBuffer(imagePath, controller.signal)).rejects.toBe(reason)
	})
})
