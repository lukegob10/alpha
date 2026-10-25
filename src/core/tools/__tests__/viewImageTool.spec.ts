import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { viewImageToolSchema } from "../../prompts/tools/native-tools/view_image"
import i18next from "../../../i18n"
import toolTranslations from "../../../i18n/locales/en/tools.json"

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

const pngBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
	"base64",
)
const pngBase64 = pngBytes.toString("base64")

describe("view_image registry adapter", () => {
	let workspace: string | undefined

	afterEach(async () => {
		if (workspace) await rm(workspace, { recursive: true, force: true })
		workspace = undefined
	})

	function task(options: { alphaIgnoreAllowed?: boolean; supportsImages?: boolean } = {}) {
		const say = vi.fn().mockResolvedValue(undefined)
		const trackFileContext = vi.fn().mockResolvedValue(undefined)
		const task = {
			cwd: workspace,
			api: { getModel: () => ({ info: { supportsImages: options.supportsImages ?? true } }) },
			alphaIgnoreController: { validateAccess: vi.fn(() => options.alphaIgnoreAllowed ?? true) },
			fileContextTracker: { trackFileContext },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
			say,
			askKind: "primary",
			abort: false,
			didRejectTool: false,
			didToolFailInCurrentTurn: false,
		} as unknown as Task
		return { task, say, trackFileContext }
	}

	function callbacks() {
		return {
			askApproval: vi.fn().mockResolvedValue(true),
			askApprovalResponse: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
	}

	it("dispatches through the registry and returns the actual local image bytes after approval", async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-"))
		await writeFile(path.join(workspace, "pixel.png"), pngBytes)
		const registry = new ToolRegistry({ supportsImages: true })
		const descriptor = registry.resolve("view_image")
		const execution = task()
		const toolCallbacks = callbacks()
		const call = NativeToolCallParser.parseToolCall({
			id: "view-image-call",
			name: "view_image",
			arguments: JSON.stringify({ path: "pixel.png" }),
		})

		expect(descriptor?.schema.type === "function" ? descriptor.schema.function.name : undefined).toBe("view_image")
		expect(call?.type).toBe("tool_use")
		expect(descriptor?.capabilities).toMatchObject({
			sideEffects: "none",
			requiresApproval: true,
		})
		if (!descriptor || call?.type !== "tool_use") throw new Error("view_image was not registered and parsed")
		await descriptor.execute({
			task: execution.task,
			call,
			callbacks: toolCallbacks,
		})

		expect(toolCallbacks.askApprovalResponse).toHaveBeenCalledOnce()
		expect(execution.trackFileContext).toHaveBeenCalledWith("pixel.png", "read_tool")
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledWith([
			expect.objectContaining({ type: "text", text: expect.stringContaining("File: pixel.png") }),
			{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
		])
		expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: "success", trustedProgress: expect.objectContaining({ kind: "read" }) }),
		)
	})

	it("keeps protected image paths on the existing deny path without reading them", async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-"))
		await writeFile(path.join(workspace, "private.png"), pngBytes)
		const registry = new ToolRegistry({ supportsImages: true })
		const execution = task({ alphaIgnoreAllowed: false })
		const toolCallbacks = callbacks()

		await registry.resolve("view_image")!.execute({
			task: execution.task,
			call: {
				type: "tool_use",
				id: "view-private-image",
				name: "view_image",
				params: { path: "private.png" },
				partial: false,
				nativeArgs: { path: "private.png" },
			},
			callbacks: toolCallbacks,
		})

		expect(execution.say).toHaveBeenCalledWith("rooignore_error", "private.png")
		expect(toolCallbacks.askApprovalResponse).not.toHaveBeenCalled()
		expect(execution.trackFileContext).not.toHaveBeenCalled()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ status: "denied" }))
	})

	it.each(["before execution", "during approval"] as const)(
		"keeps the captured image capability when the live model changes %s",
		async (when) => {
			workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-"))
			await writeFile(path.join(workspace, "pixel.png"), pngBytes)
			const registry = new ToolRegistry({ supportsImages: true })
			const model = { supportsImages: true }
			const execution = task(model)
			const toolCallbacks = callbacks()
			if (when === "before execution") model.supportsImages = false
			else
				toolCallbacks.askApprovalResponse.mockImplementation(async () => {
					model.supportsImages = false
					return { response: "yesButtonClicked" }
				})

			await registry.resolve("view_image")!.execute({
				task: execution.task,
				call: {
					type: "tool_use",
					id: "view-captured-image",
					name: "view_image",
					params: { path: "pixel.png" },
					partial: false,
					nativeArgs: { path: "pixel.png" },
				},
				callbacks: toolCallbacks,
			})

			expect(toolCallbacks.askApprovalResponse).toHaveBeenCalledOnce()
			expect(toolCallbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith([
				expect.objectContaining({ type: "text", text: expect.stringContaining("File: pixel.png") }),
				{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
			])
			expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith(
				expect.objectContaining({ status: "success" }),
			)
		},
	)

	it("rejects a retained image schema when the captured model does not support images", async () => {
		const registry = new ToolRegistry({ supportsImages: false, nativeTools: [viewImageToolSchema] })
		const execution = task({ supportsImages: true })
		const toolCallbacks = callbacks()

		await registry.resolve("view_image")!.execute({
			task: execution.task,
			call: {
				type: "tool_use",
				id: "view-text-only-model",
				name: "view_image",
				params: { path: "pixel.png" },
				partial: false,
				nativeArgs: { path: "pixel.png" },
			},
			callbacks: toolCallbacks,
		})

		expect(toolCallbacks.askApprovalResponse).not.toHaveBeenCalled()
		expect(execution.trackFileContext).not.toHaveBeenCalled()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			"Error: the current model does not support image input.",
		)
		expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "error" })
	})

	it("rejects non-image paths and remains absent from text-only registries", async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-"))
		const imageRegistry = new ToolRegistry({ supportsImages: true })
		const toolCallbacks = callbacks()
		const execution = task()

		await imageRegistry.resolve("view_image")!.execute({
			task: execution.task,
			call: {
				type: "tool_use",
				id: "view-text-file",
				name: "view_image",
				params: { path: "notes.txt" },
				partial: false,
				nativeArgs: { path: "notes.txt" },
			},
			callbacks: toolCallbacks,
		})

		expect(toolCallbacks.askApprovalResponse).not.toHaveBeenCalled()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledWith("Error: view_image only supports local image files.")
		expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }))
		expect(new ToolRegistry({ supportsImages: false }).resolve("view_image")).toBeUndefined()
	})

	it("rejects image paths whose contents are not images after approval", async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-"))
		await writeFile(path.join(workspace, "fake.png"), "not image content")
		const registry = new ToolRegistry({ supportsImages: true })
		const toolCallbacks = callbacks()

		await registry.resolve("view_image")!.execute({
			task: task().task,
			call: {
				type: "tool_use",
				id: "view-fake-image",
				name: "view_image",
				params: { path: "fake.png" },
				partial: false,
				nativeArgs: { path: "fake.png" },
			},
			callbacks: toolCallbacks,
		})

		expect(toolCallbacks.askApprovalResponse).toHaveBeenCalledOnce()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(toolCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("unable to process image: invalid or unsupported image data"),
		)
		expect(toolCallbacks.setResultMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }))
	})
})
