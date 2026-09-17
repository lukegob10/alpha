import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { hydrateDocumentImages, rasterInfo } from "../images"
import { sanitizeDocument } from "../sanitize"

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
	"base64",
)
const document = (body: string) =>
	sanitizeDocument(
		`<html><head><meta name="alpha-document" content="1"><title>Images</title></head><body><main class="alpha-doc" data-alpha-kit="1">${body}</main></body></html>`,
	)
describe("bounded document image hydration", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-image-test-"))
		await fs.writeFile(path.join(root, "screen.png"), png)
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})
	it("embeds scoped raster bytes, safely escapes alt text, and never changes the source", async () => {
		const result = await hydrateDocumentImages(
			document('<img data-image="screen.png" alt="&quot;&gt; &lt;script&gt;">'),
			root,
			async () => true,
			"Unavailable",
		)
		expect(result).toContain('src="data:image/png;base64,')
		expect(result).toContain('width="1" height="1"')
		expect(result).not.toContain("<script>")
		expect(await fs.readFile(path.join(root, "screen.png"))).toEqual(png)
	})
	it("retains the document with fallback for missing or invalid images", async () => {
		await fs.writeFile(path.join(root, "bad.png"), '<svg onload="alert(1)"></svg>')
		const result = await hydrateDocumentImages(
			document('<p>Evidence</p><img data-image="absent.png" alt="Absent"><img data-image="bad.png" alt="Bad">'),
			root,
			async () => true,
			"Unavailable",
		)
		expect(result).toContain("Evidence")
		expect(result.match(/class="image-unavailable"/g)).toHaveLength(2)
		expect(result).not.toContain("data:image")
	})
	it("blocks escaping junctions and cancels before reading stale content", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-image-outside-"))
		try {
			await fs.writeFile(path.join(outside, "private.png"), png)
			await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
			for (const attribute of ["data-image", "src"]) {
				const source = document(`<img ${attribute}="escape/private.png" alt="Private">`)
				expect(source.images.size).toBe(1)
				expect(await hydrateDocumentImages(source, root, async () => true, "Unavailable")).not.toContain(
					"data:image",
				)
				await expect(hydrateDocumentImages(source, root, async () => false, "Unavailable")).rejects.toThrow(
					"cancelled",
				)
			}
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
	it("rejects compressed pixel bombs and oversized bytes", async () => {
		const huge = Buffer.from(png)
		huge.writeUInt32BE(100000, 16)
		await fs.writeFile(path.join(root, "huge.png"), huge)
		await fs.writeFile(path.join(root, "large.png"), Buffer.alloc(1024 * 1024 + 1))
		const source = document('<img data-image="huge.png" alt="Huge"><img data-image="large.png" alt="Large">')
		expect(await hydrateDocumentImages(source, root, async () => true, "Unavailable")).not.toContain("data:image")
	})
	it("recognizes PNG and JPEG headers and rejects animation or truncated chunks", () => {
		expect(rasterInfo(png)).toEqual({ mime: "image/png", width: 1, height: 1 })
		const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 10, 0, 20, 1, 1, 17, 0, 255, 218, 0, 2, 0, 255, 217])
		expect(rasterInfo(jpeg)).toEqual({ mime: "image/jpeg", width: 20, height: 10 })
		const animated = Buffer.from(png)
		animated.write("acTL", 37, "ascii")
		expect(() => rasterInfo(animated)).toThrow("image")
		expect(() => rasterInfo(png.subarray(0, 44))).toThrow("image")
	})
	it("bounds aggregate decoded pixels and drops stale reads before publication", async () => {
		const largePixels = Buffer.from(png)
		largePixels.writeUInt32BE(2048, 16)
		largePixels.writeUInt32BE(2048, 20)
		await fs.writeFile(path.join(root, "pixels.png"), largePixels)
		const source = document(
			'<img data-image="pixels.png" alt="One"><img data-image="pixels.png" alt="Two"><img data-image="pixels.png" alt="Three">',
		)
		const result = await hydrateDocumentImages(source, root, async () => true, "Unavailable")
		expect(result.match(/src="data:image/g)).toHaveLength(2)
		expect(result).toContain("Three — Unavailable")
		let calls = 0
		await expect(
			hydrateDocumentImages(
				document('<img data-image="screen.png" alt="Screen">'),
				root,
				async () => ++calls === 1,
				"Unavailable",
			),
		).rejects.toThrow("cancelled")
	})
})
