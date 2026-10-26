import * as path from "path"
import * as fs from "fs/promises"

import { resolveImageMentions } from "../resolveImageMentions"

vi.mock("fs/promises", () => ({ realpath: vi.fn() }))

vi.mock("../../tools/helpers/imageHelpers", () => ({
	isSupportedImageFormat: vi.fn((ext: string) =>
		[".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff", ".tif", ".avif"].includes(
			ext.toLowerCase(),
		),
	),
	readImageAsDataUrlWithBuffer: vi.fn(),
	validateImageForProcessing: vi.fn(),
	ImageMemoryTracker: vi.fn().mockImplementation(function () {
		let currentMemory = 0
		return {
			getTotalMemoryUsed: vi.fn(() => currentMemory),
			addMemoryUsage: vi.fn((sizeInMB: number) => {
				currentMemory += sizeInMB
			}),
		}
	}),
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB: 5,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB: 20,
}))

import { validateImageForProcessing, readImageAsDataUrlWithBuffer } from "../../tools/helpers/imageHelpers"

const mockReadImageAsDataUrl = vi.mocked(readImageAsDataUrlWithBuffer)
const mockValidateImage = vi.mocked(validateImageForProcessing)

function imageReceipt(dataUrl: string, buffer: Buffer, sourceExtension = ".png", outputExtension = sourceExtension) {
	return {
		dataUrl,
		buffer,
		sourceExtension,
		outputExtension,
		mimeType: dataUrl.slice("data:".length, dataUrl.indexOf(";")),
	}
}

describe("resolveImageMentions", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockReadImageAsDataUrl.mockReset()
		vi.mocked(fs.realpath).mockImplementation(async (value) => path.resolve(value.toString()))
		// Default: validation passes
		mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
	})

	it("should append a data URL when a local png mention is present", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("png-bytes")))

		const result = await resolveImageMentions({
			text: "Please look at @/assets/cat.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(
			path.resolve("/workspace", "assets/cat.png"),
			undefined,
			5 * 1024 * 1024,
		)
		expect(result.text).toBe("Please look at @/assets/cat.png")
		expect(result.images).toEqual([dataUrl])
	})

	it("loads image descendants whose names begin with two dots", async () => {
		const buffer = Buffer.from("dotted-image")
		const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, buffer))

		const result = await resolveImageMentions({ text: "@/..images/cat.png", cwd: "/workspace" })

		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(
			path.resolve("/workspace", "..images/cat.png"),
			undefined,
			5 * 1024 * 1024,
		)
		expect(result.images).toEqual([dataUrl])
	})

	it.each(["../outside.png", "../workspace-other/cat.png", "nested/../../outside.png"])(
		"does not load images outside the workspace through %s",
		async (relativePath) => {
			const result = await resolveImageMentions({ text: `@/${relativePath}`, cwd: "/workspace" })

			expect(mockValidateImage).not.toHaveBeenCalled()
			expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
			expect(result.images).toEqual([])
		},
	)

	it("does not treat the workspace directory itself as an image", async () => {
		const result = await resolveImageMentions({ text: "@/../workspace.png", cwd: "/workspace.png" })

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it.each(["linked.png", "linked-directory/image.png"])("rejects an outside symlink through %s", async (name) => {
		const cwd = path.resolve("/workspace")
		const candidate = path.join(cwd, name)
		vi.mocked(fs.realpath).mockImplementation(async (value) =>
			path.resolve(value.toString()) === candidate ? path.resolve("/outside/image.png") : cwd,
		)

		const result = await resolveImageMentions({ text: `@/${name}`, cwd })

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("reads the canonical in-workspace target of an image symlink", async () => {
		const cwd = path.resolve("/workspace")
		const target = path.join(cwd, "assets", "image.png")
		vi.mocked(fs.realpath).mockImplementation(async (value) =>
			path.resolve(value.toString()) === path.join(cwd, "linked.png") ? target : cwd,
		)
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt("data:image/png;base64,YQ==", Buffer.from("a")))

		const result = await resolveImageMentions({ text: "@/linked.png", cwd })

		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(target, undefined, 5 * 1024 * 1024)
		expect(result.images).toEqual(["data:image/png;base64,YQ=="])
	})

	it("admits images under a symlinked workspace root", async () => {
		const cwd = path.resolve("/workspace-alias")
		const realRoot = path.resolve("/workspace")
		vi.mocked(fs.realpath).mockImplementation(async (value) =>
			path.resolve(value.toString()) === cwd ? realRoot : path.join(realRoot, "image.png"),
		)
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt("data:image/png;base64,YQ==", Buffer.from("a")))

		await resolveImageMentions({ text: "@/image.png", cwd })

		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(
			path.join(realRoot, "image.png"),
			undefined,
			5 * 1024 * 1024,
		)
	})

	it("skips images when their canonical target cannot be resolved", async () => {
		vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error("missing target"), { code: "ENOENT" }))

		const result = await resolveImageMentions({ text: "@/missing.png", cwd: "/workspace" })

		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("rechecks ignore policy against the admitted canonical target", async () => {
		const cwd = path.resolve("/workspace")
		const target = path.join(cwd, "private", "image.png")
		vi.mocked(fs.realpath).mockImplementation(async (value) =>
			path.resolve(value.toString()) === cwd ? cwd : target,
		)
		const alphaIgnoreController = { validateAccess: vi.fn((value: string) => value !== target) }

		const result = await resolveImageMentions({ text: "@/linked.png", cwd, alphaIgnoreController })

		expect(alphaIgnoreController.validateAccess).toHaveBeenCalledWith(target)
		expect(mockValidateImage).not.toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should support gif images (matching read_file)", async () => {
		const dataUrl = `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("gif-bytes"), ".gif"))

		const result = await resolveImageMentions({
			text: "See @/animation.gif",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
	})

	it("appends the helper's prepared PNG for an SVG source mention", async () => {
		const buffer = Buffer.from("prepared-svg-png")
		const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, buffer, ".svg", ".png"))

		const result = await resolveImageMentions({
			text: "See @/icon.svg",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([dataUrl])
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(
			path.resolve("/workspace", "icon.svg"),
			undefined,
			5 * 1024 * 1024,
		)
	})

	it("should ignore non-image mentions", async () => {
		const result = await resolveImageMentions({
			text: "See @/src/index.ts",
			images: [],
			cwd: "/workspace",
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip unreadable files (fail-soft)", async () => {
		mockReadImageAsDataUrl.mockRejectedValue(new Error("ENOENT"))

		const result = await resolveImageMentions({
			text: "See @/missing.webp",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should respect alphaIgnoreController", async () => {
		const dataUrl = `data:image/jpeg;base64,${Buffer.from("jpg-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("jpg-bytes"), ".jpg"))
		const alphaIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(false),
		}

		const result = await resolveImageMentions({
			text: "See @/secret.jpg",
			images: [],
			cwd: "/workspace",
			alphaIgnoreController,
		})

		expect(alphaIgnoreController.validateAccess).toHaveBeenCalledWith("secret.jpg")
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should dedupe when mention repeats", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("png-bytes")))

		const result = await resolveImageMentions({
			text: "@/a.png and again @/a.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toHaveLength(1)
	})

	it("keeps the first occurrence order across supplied and mentioned images", async () => {
		const existing = "data:image/png;base64,ZXhpc3Rpbmc="
		const added = "data:image/png;base64,YWRkZWQ="
		mockReadImageAsDataUrl
			.mockResolvedValueOnce(imageReceipt(existing, Buffer.from("existing")))
			.mockResolvedValueOnce(imageReceipt(added, Buffer.from("added")))

		const result = await resolveImageMentions({
			text: "@/existing.png @/added.png",
			images: [existing, existing],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([existing, added])
	})

	it("should skip images when supportsImages is false", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("png-bytes")))

		const result = await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			supportsImages: false,
		})

		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that exceed size limits", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "size_limit",
			notice: "Image too large",
		})

		const result = await resolveImageMentions({
			text: "See @/huge.png",
			images: [],
			cwd: "/workspace",
		})

		expect(mockValidateImage).toHaveBeenCalled()
		expect(mockReadImageAsDataUrl).not.toHaveBeenCalled()
		expect(result.images).toEqual([])
	})

	it("should skip images that would exceed memory limit", async () => {
		mockValidateImage.mockResolvedValue({
			isValid: false,
			reason: "memory_limit",
			notice: "Would exceed memory limit",
		})

		const result = await resolveImageMentions({
			text: "See @/large.png",
			images: [],
			cwd: "/workspace",
		})

		expect(result.images).toEqual([])
	})

	it("should pass custom size limits to validation", async () => {
		const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
		mockReadImageAsDataUrl.mockResolvedValue(imageReceipt(dataUrl, Buffer.from("png-bytes")))

		await resolveImageMentions({
			text: "See @/cat.png",
			images: [],
			cwd: "/workspace",
			maxImageFileSize: 10,
			maxTotalImageSize: 50,
		})

		expect(mockValidateImage).toHaveBeenCalledWith(expect.any(String), true, 10, 50, 0)
		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(expect.any(String), undefined, 10 * 1024 * 1024)
	})

	it.each([
		{ firstFile: "first.png", sourceExtension: ".png" },
		{ firstFile: "first.svg", sourceExtension: ".svg" },
	])(
		"charges actual bytes from $firstFile and retains failed-read allowance",
		async ({ firstFile, sourceExtension }) => {
			const first = Buffer.alloc(768 * 1024)
			const second = Buffer.alloc(512 * 1024)
			const third = Buffer.alloc(128 * 1024)
			const fixtures = new Map([
				[firstFile, imageReceipt("data:image/png;base64,Zmlyc3Q=", first, sourceExtension, ".png")],
				["second.png", imageReceipt("data:image/png;base64,c2Vjb25k", second)],
				["third.png", imageReceipt("data:image/png;base64,dGhpcmQ=", third)],
			])
			mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.1 })
			mockReadImageAsDataUrl.mockImplementation(async (imagePath, _signal, maxBytes) => {
				const fixture = fixtures.get(path.basename(imagePath))
				if (!fixture) throw new Error("Unknown image fixture")
				if (maxBytes !== undefined && fixture.buffer.length > maxBytes) throw new Error("Image grew after stat")
				return fixture
			})

			const result = await resolveImageMentions({
				text: `@/${firstFile} @/second.png @/third.png`,
				cwd: "/workspace",
				maxImageFileSize: 1,
				maxTotalImageSize: 1,
			})

			expect(mockReadImageAsDataUrl).toHaveBeenNthCalledWith(1, expect.any(String), undefined, 1024 * 1024)
			expect(mockReadImageAsDataUrl).toHaveBeenNthCalledWith(2, expect.any(String), undefined, 256 * 1024)
			expect(mockReadImageAsDataUrl).toHaveBeenNthCalledWith(3, expect.any(String), undefined, 256 * 1024)
			expect(mockValidateImage).toHaveBeenNthCalledWith(2, expect.any(String), true, 1, 1, 0.75)
			expect(mockValidateImage).toHaveBeenNthCalledWith(3, expect.any(String), true, 1, 1, 0.75)
			expect(result.images).toEqual([fixtures.get(firstFile)!.dataUrl, fixtures.get("third.png")!.dataUrl])
		},
	)

	it("caps the first read at the smaller remaining total allowance", async () => {
		mockValidateImage.mockResolvedValue({ isValid: true, sizeInMB: 0.01 })
		mockReadImageAsDataUrl.mockRejectedValue(new Error("Image changed after size validation"))

		const result = await resolveImageMentions({
			text: "@/small.png",
			cwd: "/workspace",
			maxImageFileSize: 5,
			maxTotalImageSize: 0.05,
		})

		expect(mockReadImageAsDataUrl).toHaveBeenCalledWith(
			path.resolve("/workspace", "small.png"),
			undefined,
			Math.floor(0.05 * 1024 * 1024),
		)
		expect(result.images).toEqual([])
	})
})
