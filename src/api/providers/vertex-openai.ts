import type { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { GoogleAuth, type JWTInput } from "google-auth-library"
import { safeJsonParse } from "@alpha-code/core"
import { resolveVertexOpenAiModelInfo } from "@alpha-code/types"
import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import type { ApiStream } from "../transform/stream"
import { awaitSingleCompletion, throwIfSingleCompletionAborted } from "../transform/single-completion"
import { OpenAiHandler } from "./openai"
import { DEFAULT_HEADERS } from "./constants"
import { assertNativeVertexSettings } from "./utils/native-vertex-settings"
import { applyModelToolPreferences } from "./utils/router-tool-preferences"
import { getApiRequestTimeout } from "./utils/timeout-config"

/**
 * Native Google OpenAI-compatible partner endpoints use the same Google credentials as Claude and Gemini.
 * Google endpoint/auth contract checked 2026-11-03:
 * https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/generativeaionvertexai-gemini-chat-completions-non-streaming
 */
export class VertexOpenAiHandler extends OpenAiHandler {
	override readonly streamCapabilities = { cancellation: false, lifecycle: true } as const
	private readonly auth: GoogleAuth
	private activeToken?: string
	private readonly baseUrl: string

	constructor(options: ApiHandlerOptions) {
		assertNativeVertexSettings(options)
		const modelId = options.apiModelId?.trim()
		const project = (options.projectId ?? options.vertexProjectId)?.trim()
		const location = (options.location ?? options.vertexRegion)?.trim()
		if (!modelId || !project || !location) throw new Error("Vertex requires a project, location, and model ID.")
		if (!/^[a-z0-9-]+$/.test(location)) throw new Error("Invalid Vertex location.")
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
		const baseUrl = `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi`
		super({
			...options,
			openAiBaseUrl: baseUrl,
			openAiApiKey: "google-credentials-pending",
			openAiModelId: modelId,
			openAiCustomModelInfo: resolveVertexOpenAiModelInfo(modelId),
			openAiStreamingEnabled: options.vertexStreamingEnabled ?? true,
			openAiHeaders: undefined,
			openAiUseAzure: false,
			openAiR1FormatEnabled: false,
			openAiHostHeader: undefined,
		})
		this.baseUrl = baseUrl
		this.auth = new GoogleAuth({
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
			...(options.vertexJsonCredentials
				? { credentials: safeJsonParse<JWTInput>(options.vertexJsonCredentials, undefined) }
				: options.vertexKeyFile
					? { keyFile: options.vertexKeyFile }
					: {}),
		})
	}

	override getModel() {
		const model = super.getModel()
		const toolIdentity = { provider: "vertex", id: model.id }
		return { ...model, info: applyModelToolPreferences(toolIdentity, model.info), toolIdentity }
	}

	private async prepareClient(metadata?: ApiHandlerSingleCompletionMetadata): Promise<void> {
		throwIfSingleCompletionAborted(metadata)
		const token = await awaitSingleCompletion(this.auth.getAccessToken(), metadata)
		throwIfSingleCompletionAborted(metadata)
		if (!token) throw new Error("Google Cloud credentials did not return an access token.")
		if (token === this.activeToken) return
		this.client = new OpenAI({
			baseURL: this.baseUrl,
			apiKey: token,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: getApiRequestTimeout(),
			maxRetries: 0,
		})
		this.activeToken = token
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		await this.prepareClient(metadata)
		yield* super.createMessage(systemPrompt, messages, metadata)
	}

	override async completePrompt(prompt: string, metadata?: ApiHandlerSingleCompletionMetadata): Promise<string> {
		await this.prepareClient(metadata)
		return super.completePrompt(prompt, metadata)
	}
}
