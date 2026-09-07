import path from "path"
import fs from "fs/promises"
import * as vscode from "vscode"
import {
	GenerateImageParams,
	IMAGE_GENERATION_MODEL_IDS,
	IMAGE_GENERATION_MODELS,
	getImageGenerationProvider,
} from "@alpha-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { OpenRouterHandler } from "../../api/providers/openrouter"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"
import {
	captureImageOutputState,
	writeImageOutput,
	ImageOutputWriteError,
	type ImageOutputState,
} from "./imageOutputFile"
import { resolvePathWithExistingAncestor } from "./pathSafety"
import { getImageOutputPaths } from "./imageOutputPaths"

class ImageGenerationCancelledError extends Error {}

export class GenerateImageTool extends BaseTool<"generate_image"> {
	readonly name = "generate_image" as const

	async execute(params: GenerateImageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { prompt, path: relPath, image: inputImagePath } = params
		const { handleError, pushToolResult, askApproval } = callbacks
		const pushFailure = (result: Parameters<ToolCallbacks["pushToolResult"]>[0]) => {
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			pushToolResult(result)
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const isImageGenerationEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.IMAGE_GENERATION,
		)

		if (!isImageGenerationEnabled) {
			pushFailure(
				formatResponse.toolError(
					"Image generation is an experimental feature that must be enabled in settings. Please enable 'Image Generation' in the Experimental Settings section.",
				),
			)
			return
		}

		if (!prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushFailure(await task.sayAndCreateMissingParamError("generate_image", "prompt"))
			return
		}

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushFailure(await task.sayAndCreateMissingParamError("generate_image", "path"))
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushFailure(formatResponse.rooIgnoreError(relPath))
			return
		}

		let inputImageData: string | undefined
		if (inputImagePath) {
			const inputImageFullPath = path.resolve(task.cwd, inputImagePath)

			const inputImageExists = await fileExistsAtPath(inputImageFullPath)
			if (!inputImageExists) {
				await task.say("error", `Input image not found: ${getTaskReadablePath(task, inputImagePath)}`)
				pushFailure(
					formatResponse.toolError(`Input image not found: ${getTaskReadablePath(task, inputImagePath)}`),
				)
				return
			}

			const inputImageAccessAllowed = task.rooIgnoreController?.validateAccess(inputImagePath)
			if (!inputImageAccessAllowed) {
				await task.say("rooignore_error", inputImagePath)
				pushFailure(formatResponse.rooIgnoreError(inputImagePath))
				return
			}

			try {
				const imageBuffer = await fs.readFile(inputImageFullPath)
				const imageExtension = path.extname(inputImageFullPath).toLowerCase().replace(".", "")

				const supportedFormats = ["png", "jpg", "jpeg", "gif", "webp"]
				if (!supportedFormats.includes(imageExtension)) {
					await task.say(
						"error",
						`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
					)
					pushFailure(
						formatResponse.toolError(
							`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
						),
					)
					return
				}

				const mimeType = imageExtension === "jpg" ? "jpeg" : imageExtension
				inputImageData = `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`
			} catch (error) {
				await task.say(
					"error",
					`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
				pushFailure(
					formatResponse.toolError(
						`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
					),
				)
				return
			}
		}

		// Use shared utility for backwards compatibility logic
		const imageProvider = getImageGenerationProvider(
			state?.imageGenerationProvider,
			!!state?.openRouterImageGenerationSelectedModel,
		)

		// Get the selected model
		let selectedModel = state?.openRouterImageGenerationSelectedModel
		let modelInfo = undefined

		// Find the model info matching both value AND provider
		// (since the same model value can exist for multiple providers)
		if (selectedModel) {
			modelInfo = IMAGE_GENERATION_MODELS.find((m) => m.value === selectedModel && m.provider === imageProvider)
			if (!modelInfo) {
				// Model doesn't exist for this provider, use first model for selected provider
				const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
				modelInfo = providerModels[0]
				selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]
			}
		} else {
			// No model selected, use first model for selected provider
			const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
			modelInfo = providerModels[0]
			selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]
		}

		// Validate API key for OpenRouter
		const openRouterApiKey = state?.openRouterImageApiKey

		if (imageProvider === "openrouter" && !openRouterApiKey) {
			const errorMessage = t("tools:generateImage.openRouterApiKeyRequired")
			await task.say("error", errorMessage)
			pushFailure(formatResponse.toolError(errorMessage))
			return
		}

		const assertActive = () => {
			if (task.abort || task.abandoned || callbacks.signal?.aborted) {
				throw new ImageGenerationCancelledError(t("tools:generateImage.cancelledBeforeSave"))
			}
		}
		const pathPolicy = (outputPath: string) => ({
			isOutsideWorkspace:
				isTaskPathOutsideWorkspace(task, path.resolve(task.cwd, outputPath)) ||
				isTaskPathOutsideWorkspace(task, resolvePathWithExistingAncestor(path.resolve(task.cwd, outputPath))),
			isProtected: task.rooProtectedController?.isWriteProtected(outputPath) || false,
		})
		const approvePath = async (outputPath: string, policy: ReturnType<typeof pathPolicy>) => {
			assertActive()
			const approved = await askApproval(
				"tool",
				JSON.stringify({
					tool: "generateImage",
					path: getTaskReadablePath(task, outputPath),
					content: prompt,
					...policy,
					...(inputImagePath && { inputImage: getTaskReadablePath(task, inputImagePath) }),
				}),
				undefined,
				policy.isProtected,
			)
			assertActive()
			if (!approved) callbacks.setResultMetadata?.({ status: "denied" })
			return approved
		}
		let savedPath: string | undefined

		try {
			task.consecutiveMistakeCount = 0

			assertActive()
			// The response decides the suffix. Capture every possible destination
			// before the first approval, retaining failures only for the chosen path.
			const candidates = getImageOutputPaths(relPath)
			const outputStates = new Map<string, ImageOutputState | Error>()
			for (const candidate of candidates) {
				if (!task.rooIgnoreController?.validateAccess(candidate)) continue
				try {
					outputStates.set(
						candidate,
						await captureImageOutputState(
							path.resolve(task.cwd, candidate),
							getTaskReadablePath(task, candidate),
						),
					)
				} catch (error) {
					outputStates.set(candidate, error instanceof Error ? error : new Error(String(error)))
				}
			}
			const initialState = outputStates.get(relPath)
			if (initialState instanceof Error) throw initialState
			let approvedPolicy = pathPolicy(relPath)
			if (!(await approvePath(relPath, approvedPolicy))) return

			const openRouterHandler = new OpenRouterHandler({} as any)
			const result = await openRouterHandler.generateImage(
				prompt,
				selectedModel,
				openRouterApiKey!,
				inputImageData,
			)
			assertActive()

			if (!result.success) {
				await task.say("error", result.error || "Failed to generate image")
				pushFailure(formatResponse.toolError(result.error || "Failed to generate image"))
				return
			}

			if (!result.imageData) {
				const errorMessage = "No image data received"
				await task.say("error", errorMessage)
				pushFailure(formatResponse.toolError(errorMessage))
				return
			}

			const base64Match = result.imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
			if (!base64Match) {
				const errorMessage = "Invalid image format received"
				await task.say("error", errorMessage)
				pushFailure(formatResponse.toolError(errorMessage))
				return
			}

			const imageFormat = base64Match[1]
			const base64Data = base64Match[2]

			const finalPath = candidates.length === 1 ? candidates[0] : candidates[imageFormat === "png" ? 0 : 1]

			const imageBuffer = Buffer.from(base64Data, "base64")
			if (!task.rooIgnoreController?.validateAccess(finalPath)) {
				await task.say("rooignore_error", finalPath)
				pushFailure(formatResponse.rooIgnoreError(finalPath))
				return
			}
			const expectedState = outputStates.get(finalPath)
			if (expectedState instanceof Error) throw expectedState
			if (!expectedState) throw new Error(t("tools:generateImage.destinationUnavailableBeforeGeneration"))
			if (finalPath !== relPath) {
				approvedPolicy = pathPolicy(finalPath)
				if (!(await approvePath(finalPath, approvedPolicy))) return
			}

			const absolutePath = path.resolve(task.cwd, finalPath)
			const directory = path.dirname(absolutePath)
			const assertOutputScope = () => {
				assertActive()
				const currentPolicy = pathPolicy(finalPath)
				if (
					!task.rooIgnoreController?.validateAccess(finalPath) ||
					(currentPolicy.isProtected && !approvedPolicy.isProtected) ||
					currentPolicy.isOutsideWorkspace !== approvedPolicy.isOutsideWorkspace ||
					!arePathsEqual(expectedState.resolvedPath, resolvePathWithExistingAncestor(absolutePath))
				) {
					throw new Error(t("tools:generateImage.destinationPolicyChangedBeforeSave"))
				}
			}
			assertOutputScope()
			await fs.mkdir(directory, { recursive: true })

			await writeImageOutput(
				absolutePath,
				getTaskReadablePath(task, finalPath),
				imageBuffer,
				expectedState,
				assertOutputScope,
				() => {
					savedPath = finalPath
					task.didEditFile = true
					task.recordToolUsage("generate_image")
				},
			)
			await task.fileContextTracker.trackFileContext(finalPath, "roo_edited")

			const fullImagePath = absolutePath

			let imageUri = provider?.convertToWebviewUri?.(fullImagePath) ?? vscode.Uri.file(fullImagePath).toString()

			const cacheBuster = Date.now()
			imageUri = imageUri.includes("?") ? `${imageUri}&t=${cacheBuster}` : `${imageUri}?t=${cacheBuster}`

			await task.say("image", JSON.stringify({ imageUri, imagePath: fullImagePath }))
			pushToolResult(formatResponse.toolResult(getTaskReadablePath(task, finalPath)))
		} catch (error) {
			if (error instanceof ImageOutputWriteError) task.didEditFile = true
			if (savedPath !== undefined) {
				callbacks.setResultMetadata?.({ status: "success" })
				pushToolResult(
					formatResponse.toolResult(
						t("tools:generateImage.postSaveProcessingFailed", {
							path: getTaskReadablePath(task, savedPath),
							message: error instanceof Error ? error.message : String(error),
						}),
					),
				)
				return
			}
			if (error instanceof ImageGenerationCancelledError) {
				callbacks.setResultMetadata?.({ status: "cancelled" })
				pushToolResult(formatResponse.toolError(error.message))
				return
			}
			task.didToolFailInCurrentTurn = true
			callbacks.setResultMetadata?.({ status: "error" })
			await handleError("generating image", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"generate_image">): Promise<void> {
		return
	}
}

export const generateImageTool = new GenerateImageTool()
