import { createRequire } from "node:module"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	ConfigurationFiles,
	initializeImageMagick,
	MagickFormat,
	MagickImage,
	MagickReadSettings,
} from "@imagemagick/magick-wasm"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { processImageFile, readImageAsDataUrlWithBuffer } from "../imageHelpers"
import i18next from "../../../../i18n"
import toolTranslations from "../../../../i18n/locales/en/tools.json"

vi.mock("node:worker_threads", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:worker_threads")>()
	const nodePath = await import("node:path")
	class ImagePreparationTestWorker extends original.Worker {
		constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
			const workerPath =
				typeof filename === "string" && nodePath.basename(filename) === "validateImage.js"
					? (process.env.ALPHA_TEST_IMAGE_WORKER_PATH ??
						nodePath.resolve(process.cwd(), "dist/workers/validateImage.js"))
					: filename
			super(workerPath, options)
		}
	}
	return { ...original, Worker: ImagePreparationTestWorker }
})

const literalSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'
const transparentSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="1" height="2" fill="red"/></svg>'
// Exact prior L08 fixture. This test requires rejection, rather than accepting native safe omission.
const oldL08 =
	'<!DOCTYPE svg [<!ENTITY alpha SYSTEM "file:///xml/alpha-svg-canary.svg">]>' +
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">' +
	'<rect width="2" height="2" fill="red"/>&alpha;</svg>'
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

beforeAll(async () => {
	i18next.addResourceBundle("en", "tools", toolTranslations, true, true)
	const require = createRequire(import.meta.url)
	const wasmBytes = await readFile(require.resolve("@imagemagick/magick-wasm/magick.wasm"))
	const log = ConfigurationFiles.default.log
	const policy = {
		fileName: "policy.xml",
		data: `<policymap>
<policy domain="delegate" rights="none" pattern="*"/>
<policy domain="filter" rights="none" pattern="*"/>
<policy domain="path" rights="none" pattern="*"/>
<policy domain="coder" rights="none" pattern="*"/>
<policy domain="coder" rights="read" pattern="PNG"/>
<policy domain="resource" name="disk" value="0"/>
<policy domain="resource" name="map" value="0"/>
<policy domain="resource" name="width" value="16"/>
<policy domain="resource" name="height" value="16"/>
<policy domain="resource" name="area" value="256"/>
<policy domain="resource" name="memory" value="16MiB"/>
<policy domain="resource" name="max-memory-request" value="8MiB"/>
<policy domain="resource" name="max-profile-size" value="1MiB"/>
<policy domain="resource" name="list-length" value="2"/>
<policy domain="resource" name="time" value="2"/>
</policymap>`,
	}
	await initializeImageMagick(wasmBytes, {
		log,
		policy,
		*all() {
			yield log
			yield policy
		},
	})
})

// Inspect only the bounded PNG emitted by the production helper, using the installed public decoder.
// No SVG policy exception or codec acceptance mock is used by this suite.
function inspectPng(bytes: Buffer) {
	const image = MagickImage.create(bytes, new MagickReadSettings({ format: MagickFormat.Png, frameIndex: 0 }))
	try {
		return {
			width: image.width,
			height: image.height,
			pixels: image.getPixels((pixels) =>
				Array.from(pixels.toByteArray(0, 0, image.width, image.height, "RGBA") ?? []),
			),
		}
	} finally {
		image.dispose()
	}
}

describe("SVG preparation through the real public image helper", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-svg-preparation-"))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
	})

	it("publishes an owned PNG with the original literal SVG's red pixels and dimensions", async () => {
		const imagePath = path.join(workspace, "square.svg")
		const source = Buffer.from(literalSvg)
		await writeFile(imagePath, source)

		const result = await readImageAsDataUrlWithBuffer(imagePath)

		expect(result).toMatchObject({ sourceExtension: ".svg", outputExtension: ".png", mimeType: "image/png" })
		expect(result.buffer.subarray(0, 8)).toEqual(pngSignature)
		expect(result.buffer.buffer.byteLength).toBe(result.buffer.length)
		expect(result.dataUrl).toBe(`data:image/png;base64,${result.buffer.toString("base64")}`)
		expect(result.buffer.includes(Buffer.from("<svg"))).toBe(false)
		expect(inspectPng(result.buffer)).toEqual({
			width: 2,
			height: 2,
			pixels: [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
		})
		expect(await readFile(imagePath)).toEqual(source)
	})

	it("preserves transparent pixels instead of flattening the prepared drawing onto an opaque background", async () => {
		const imagePath = path.join(workspace, "transparent.svg")
		await writeFile(imagePath, transparentSvg)

		const result = await readImageAsDataUrlWithBuffer(imagePath)
		const decoded = inspectPng(result.buffer)

		expect(decoded.width).toBe(4)
		expect(decoded.height).toBe(2)
		expect(decoded.pixels).toHaveLength(32)
		expect(decoded.pixels.slice(0, 4)).toEqual([255, 0, 0, 255])
		expect(decoded.pixels.slice(16, 20)).toEqual([255, 0, 0, 255])
		expect(decoded.pixels[15]).toBe(0)
		expect(decoded.pixels[31]).toBe(0)
	})

	it("reports and charges the prepared PNG bytes through processImageFile", async () => {
		const imagePath = path.join(workspace, "square.svg")
		await writeFile(imagePath, literalSvg)

		const result = await processImageFile(imagePath)

		expect(result).toMatchObject({ sourceExtension: ".svg", outputExtension: ".png", mimeType: "image/png" })
		expect(result.sizeInKB).toBe(Math.round(result.buffer.length / 1024))
		expect(result.sizeInMB).toBe(result.buffer.length / 1024 ** 2)
		expect(result.dataUrl).toBe(`data:image/png;base64,${result.buffer.toString("base64")}`)
	})

	it("rejects the unchanged L08 DTD/entity source without publishing the original SVG", async () => {
		const imagePath = path.join(workspace, "local-entity.svg")
		await writeFile(imagePath, oldL08)

		await expect(readImageAsDataUrlWithBuffer(imagePath)).rejects.toThrow(/invalid|unsupported/i)
		expect(await readFile(imagePath, "utf8")).toBe(oldL08)
	})

	it("rejects SVG whose bounded prepared PNG exceeds the admitted source/output allowance", async () => {
		// The shortest valid drawing is admitted as input; the encoded PNG must independently fit.
		const tinySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
		const source = Buffer.from(tinySvg)
		const imagePath = path.join(workspace, "tiny.svg")
		await writeFile(imagePath, source)

		await expect(readImageAsDataUrlWithBuffer(imagePath, undefined, source.length)).rejects.toThrow(/limit|size/i)
		expect(await readFile(imagePath)).toEqual(source)
	})
})
