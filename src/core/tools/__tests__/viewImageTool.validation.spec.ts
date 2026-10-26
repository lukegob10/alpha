import type { Anthropic } from "@anthropic-ai/sdk"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import type { AgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../ToolRegistry"
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

const pngBytes = Buffer.from([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
	137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94, 171, 63, 0, 0, 0, 0, 73, 69, 78,
	68, 174, 66, 96, 130,
])
const malformedImages = [
	{ name: "signature-only PNG", file: "signature.png", bytes: pngBytes.subarray(0, 8) },
	{ name: "truncated PNG after dimensions", file: "truncated.png", bytes: pngBytes.subarray(0, 33) },
	{ name: "signature-only JPEG", file: "signature.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
	{
		name: "truncated JPEG marker",
		file: "truncated.jpeg",
		bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]),
	},
	{ name: "signature-only GIF", file: "signature.gif", bytes: Buffer.from("GIF89a") },
	{
		name: "truncated GIF after dimensions",
		file: "truncated.gif",
		bytes: Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0]),
	},
]

function response(imagePath: string): AgentResponse {
	const call = {
		type: "tool_call" as const,
		id: "view-image-validation",
		name: "view_image",
		arguments: { path: imagePath },
	}
	return { items: [call], toolCalls: [call], text: "", reasoning: "" }
}

describe("view_image decode validation", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-view-image-validation-"))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
	})

	function execution(
		options: { approved?: boolean; ignored?: boolean; maxImageFileSize?: number; maxTotalImageSize?: number } = {},
	) {
		const history: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam> = []
		const ask = vi.fn(async () => ({
			response: options.approved === false ? "noButtonClicked" : "yesButtonClicked",
		}))
		const trackFileContext = vi.fn(async () => {})
		const pushToolResultToUserContent = vi.fn((result: Anthropic.ToolResultBlockParam) => {
			if (history.some((part) => part.type === "tool_result" && part.tool_use_id === result.tool_use_id))
				return false
			history.push(result)
			return true
		})
		const task = {
			cwd: workspace,
			taskId: "view-image-validation-task",
			api: { getModel: () => ({ info: { supportsImages: true } }) },
			alphaIgnoreController: { validateAccess: vi.fn(() => !options.ignored) },
			fileContextTracker: { trackFileContext },
			providerRef: {
				deref: () => ({
					getState: async () => ({
						maxImageFileSize: options.maxImageFileSize ?? 5,
						maxTotalImageSize: options.maxTotalImageSize ?? 20,
					}),
				}),
			},
			ask,
			say: vi.fn(async () => {}),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			userMessageContent: history,
			askKind: "primary",
			abort: false,
			didRejectTool: false,
			didToolFailInCurrentTurn: false,
			pushToolResultToUserContent,
		} as unknown as Task
		const registry = new ToolRegistry({ supportsImages: true })
		const scheduler = new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} })
		return { task, scheduler, history, ask, trackFileContext, pushToolResultToUserContent }
	}

	it.each(malformedImages)("rejects $name once before publishing any image", async ({ file, bytes }) => {
		await writeFile(path.join(workspace, file), bytes)
		const run = execution()

		const outcome = await run.scheduler.run(response(file))

		expect(run.ask).toHaveBeenCalledOnce()
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId: "view-image-validation", status: "error" })
		expect(JSON.stringify(outcome.results[0].content)).toMatch(/invalid|unsupported|does not match/i)
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(run.history).toHaveLength(1)
		expect(run.history[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "view-image-validation",
			is_error: true,
		})
		expect(JSON.stringify(run.history)).not.toContain('"type":"image"')
		expect(run.trackFileContext).not.toHaveBeenCalled()
		expect(run.task.didToolFailInCurrentTurn).toBe(true)
	})

	it("returns actual bytes for a decodable image after approval", async () => {
		await writeFile(path.join(workspace, "pixel.png"), pngBytes)
		const run = execution()

		const outcome = await run.scheduler.run(response("pixel.png"))

		expect(outcome.results[0]).toMatchObject({
			status: "success",
			trustedProgress: expect.objectContaining({ kind: "read" }),
		})
		expect(run.ask).toHaveBeenCalledOnce()
		expect(run.trackFileContext).toHaveBeenCalledWith("pixel.png", "read_tool")
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(outcome.results[0].content).toContainEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") },
		})
	})

	it("publishes prepared PNG inside the single paired SVG receipt after approval", async () => {
		const source =
			'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'
		await writeFile(path.join(workspace, "square.svg"), source)
		const run = execution()

		const outcome = await run.scheduler.run(response("square.svg"))

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({
			callId: "view-image-validation",
			status: "success",
			trustedProgress: expect.objectContaining({ kind: "read" }),
		})
		expect(run.ask).toHaveBeenCalledOnce()
		expect(run.trackFileContext).toHaveBeenCalledExactlyOnceWith("square.svg", "read_tool")
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(run.history).toHaveLength(1)
		expect(run.history[0]).toMatchObject({ type: "tool_result", tool_use_id: "view-image-validation" })
		const content = outcome.results[0].content
		expect(Array.isArray(content)).toBe(true)
		if (!Array.isArray(content)) throw new Error("Expected ordered image tool content")
		const image = content.find((part) => part.type === "image")
		expect(image).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } })
		if (image?.type !== "image" || image.source.type !== "base64") throw new Error("Expected prepared PNG")
		expect(Buffer.from(image.source.data, "base64").subarray(0, 8)).toEqual(pngBytes.subarray(0, 8))
		expect(JSON.stringify(run.history)).not.toContain("image/svg+xml")
		expect(JSON.stringify(run.history)).not.toContain(Buffer.from(source).toString("base64"))
		expect(await readFile(path.join(workspace, "square.svg"), "utf8")).toBe(source)
	})

	it("publishes one error receipt and no raw image for the original L08 entity fixture", async () => {
		const source =
			'<!DOCTYPE svg [<!ENTITY alpha SYSTEM "file:///xml/alpha-svg-canary.svg">]>' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">' +
			'<rect width="2" height="2" fill="red"/>&alpha;</svg>'
		await writeFile(path.join(workspace, "local-entity.svg"), source)
		const run = execution()

		const outcome = await run.scheduler.run(response("local-entity.svg"))

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId: "view-image-validation", status: "error" })
		expect(outcome.results[0].trustedProgress).toBeUndefined()
		expect(run.ask).toHaveBeenCalledOnce()
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(run.history).toHaveLength(1)
		expect(run.history[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "view-image-validation",
			is_error: true,
		})
		expect(JSON.stringify(run.history)).not.toContain('"type":"image"')
		expect(run.trackFileContext).not.toHaveBeenCalled()
	})

	it.each([
		{ limit: "individual", settings: { maxImageFileSize: 0.000001 } },
		{ limit: "total", settings: { maxTotalImageSize: 0.000001 } },
	])("returns one error receipt when the image exceeds the $limit size limit", async ({ settings }) => {
		await writeFile(path.join(workspace, "pixel.png"), pngBytes)
		const run = execution(settings)

		const outcome = await run.scheduler.run(response("pixel.png"))

		expect(run.ask).toHaveBeenCalledOnce()
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId: "view-image-validation", status: "error" })
		expect(JSON.stringify(outcome.results[0].content)).toMatch(/large|limit/i)
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(run.history).toHaveLength(1)
		expect(run.history[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "view-image-validation",
			is_error: true,
		})
		expect(JSON.stringify(run.history)).not.toContain('"type":"image"')
		expect(outcome.results[0].trustedProgress).toBeUndefined()
		expect(run.trackFileContext).not.toHaveBeenCalled()
		expect(run.task.didToolFailInCurrentTurn).toBe(true)
	})

	it("keeps protected paths on the deny path before approval", async () => {
		await writeFile(path.join(workspace, "private.png"), pngBytes)
		const run = execution({ ignored: true })

		const outcome = await run.scheduler.run(response("private.png"))

		expect(outcome.results[0].status).toBe("denied")
		expect(run.ask).not.toHaveBeenCalled()
		expect(run.trackFileContext).not.toHaveBeenCalled()
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(JSON.stringify(run.history)).not.toContain('"type":"image"')
	})

	it("does not validate or publish an image after approval is declined", async () => {
		await writeFile(path.join(workspace, "signature.png"), pngBytes.subarray(0, 8))
		const run = execution({ approved: false })

		const outcome = await run.scheduler.run(response("signature.png"))

		expect(outcome.results[0].status).toBe("denied")
		expect(run.ask).toHaveBeenCalledOnce()
		expect(run.trackFileContext).not.toHaveBeenCalled()
		expect(run.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(JSON.stringify(run.history)).not.toContain('"type":"image"')
	})
})
