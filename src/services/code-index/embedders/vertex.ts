import { GoogleGenAI, type GoogleGenAIOptions, type EmbedContentResponse, type ContentEmbedding } from "@google/genai"
import { OAuth2Client, type JWTInput } from "google-auth-library"
import { safeJsonParse } from "@alpha-code/core"
import type { ProviderSettings } from "@alpha-code/types"
import { TelemetryEventName } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"

import { t } from "../../../i18n"
import {
	configureVertexGatewayCaBundle,
	createVertexGatewayRefreshHandler,
	getVertexGatewayHeaders,
	resolveVertexGatewayModelId,
} from "../../../api/providers/vertex-gateway"
import { GEMINI_MAX_ITEM_TOKENS } from "../constants"
import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { formatEmbeddingError, withValidationErrorHandling } from "../shared/validation-helpers"

/**
 * Vertex/GCP Gemini embedder for code indexing.
 *
 * This intentionally follows the regular API Vertex client setup so the indexer
 * uses the active Vertex profile for gateway, OAuth, CA bundle, project, and region.
 */
export class VertexGeminiEmbedder implements IEmbedder {
	private static readonly DEFAULT_MODEL = "gemini-embedding-001"
	private readonly client: GoogleGenAI
	private readonly modelId: string
	private readonly options: ProviderSettings

	constructor(options: ProviderSettings, modelId?: string) {
		if (options.apiProvider !== "vertex" || !options.vertexProjectId || !options.vertexRegion) {
			throw new Error(t("embeddings:serviceFactory.vertexConfigMissing"))
		}

		this.options = options
		this.modelId = modelId || VertexGeminiEmbedder.DEFAULT_MODEL

		const project = options.vertexProjectId
		const location = options.vertexRegion
		const vertexGatewayBaseUrl = options.vertexGatewayBaseUrl?.trim()

		if (vertexGatewayBaseUrl) {
			configureVertexGatewayCaBundle(options.vertexGatewayCaBundlePath)

			const authClient = new OAuth2Client({
				eagerRefreshThresholdMillis: 30_000,
				forceRefreshOnFailure: true,
			})
			authClient.refreshHandler = createVertexGatewayRefreshHandler(options)
			const googleAuthOptions = { authClient } as unknown as NonNullable<GoogleGenAIOptions["googleAuthOptions"]>

			this.client = new GoogleGenAI({
				vertexai: true,
				project,
				location,
				googleAuthOptions,
				httpOptions: {
					baseUrl: vertexGatewayBaseUrl,
					headers: getVertexGatewayHeaders(),
				},
			})
		} else if (options.vertexJsonCredentials) {
			this.client = new GoogleGenAI({
				vertexai: true,
				project,
				location,
				googleAuthOptions: {
					credentials: safeJsonParse<JWTInput>(options.vertexJsonCredentials, undefined),
				},
			})
		} else if (options.vertexKeyFile) {
			this.client = new GoogleGenAI({
				vertexai: true,
				project,
				location,
				googleAuthOptions: { keyFile: options.vertexKeyFile },
			})
		} else {
			this.client = new GoogleGenAI({ vertexai: true, project, location })
		}
	}

	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const selectedModel = model || this.modelId
		const modelToUse = this.resolveModelId(selectedModel)
		const maxItemTokens = this.getMaxItemTokens(selectedModel)
		const embeddings: number[][] = []
		const usage = { promptTokens: 0, totalTokens: 0 }

		for (let i = 0; i < texts.length; i++) {
			const text = texts[i]
			const estimatedTokens = Math.ceil(text.length / 4)

			if (estimatedTokens > maxItemTokens) {
				console.warn(
					t("embeddings:textExceedsTokenLimit", {
						index: i,
						itemTokens: estimatedTokens,
						maxTokens: maxItemTokens,
					}),
				)
				continue
			}

			try {
				const response = await this.client.models.embedContent({
					model: modelToUse,
					contents: text,
				})
				const values = this.extractEmbeddingValues(response)

				if (!values.length) {
					throw new Error(t("embeddings:openai.invalidResponseFormat"))
				}

				embeddings.push(values)

				const tokenCount = response.embeddings?.[0]?.statistics?.tokenCount ?? estimatedTokens
				usage.promptTokens += tokenCount
				usage.totalTokens += tokenCount
			} catch (error) {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "VertexGeminiEmbedder:createEmbeddings",
				})
				throw formatEmbeddingError(error, 1)
			}
		}

		return { embeddings, usage }
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			try {
				const response = await this.createEmbeddings(["test"])

				if (!response.embeddings.length) {
					return {
						valid: false,
						error: t("embeddings:openai.invalidResponseFormat"),
					}
				}

				return { valid: true }
			} catch (error) {
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					location: "VertexGeminiEmbedder:validateConfiguration",
				})
				throw error
			}
		}, "vertex")
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "vertex",
		}
	}

	private resolveModelId(modelId: string): string {
		return resolveVertexGatewayModelId(modelId, this.options.vertexGatewayModelRoutingMap)
	}

	private getMaxItemTokens(modelId: string): number {
		return modelId === "gemini-embedding-2" ? 8192 : GEMINI_MAX_ITEM_TOKENS
	}

	private extractEmbeddingValues(response: EmbedContentResponse): number[] {
		const embedding = response.embeddings?.[0] ?? (response as { embedding?: ContentEmbedding }).embedding
		return embedding?.values ?? []
	}
}
