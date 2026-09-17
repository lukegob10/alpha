import { GoogleGenAI } from "@google/genai"
import type { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces/embedder"
import { INITIAL_RETRY_DELAY_MS, MAX_BATCH_RETRIES } from "../constants"
import { t } from "../../../i18n"
import { googleEmbeddingInput } from "../shared/google-embedding"
import { validateEmbeddingBatch } from "../shared/embedding-input"
import { withValidationErrorHandling } from "../shared/validation-helpers"

/** Native Gemini transport preserves the query/document task contract. */
export class GeminiEmbedder implements IEmbedder {
	private readonly client: GoogleGenAI
	private readonly modelId: string
	constructor(apiKey: string, modelId?: string) {
		if (!apiKey) throw new Error(t("embeddings:validation.apiKeyRequired"))
		this.modelId = !modelId || modelId === "text-embedding-004" ? "gemini-embedding-001" : modelId
		this.client = new GoogleGenAI({ apiKey })
	}

	async createEmbeddings(
		texts: string[],
		model?: string,
		purpose: "document" | "query" = "document",
	): Promise<EmbeddingResponse> {
		const selectedModel = model || this.modelId
		const result: EmbeddingResponse & { usage: { promptTokens: number; totalTokens: number } } = {
			embeddings: [],
			usage: { promptTokens: 0, totalTokens: 0 },
		}
		for (let offset = 0; offset < texts.length; offset += 32) {
			const batch = texts.slice(offset, offset + 32)
			for (let attempt = 0; ; attempt++) {
				try {
					const input = googleEmbeddingInput(batch, selectedModel, purpose)
					const response = await this.client.models.embedContent({
						model: selectedModel,
						...input,
					})
					const embeddings = response.embeddings?.map((item) => item.values ?? []) ?? []
					validateEmbeddingBatch(embeddings, batch.length)
					result.embeddings.push(...embeddings)
					const tokens =
						response.embeddings?.reduce((sum, item, index) => {
							const content = input.contents[index]
							const text = typeof content === "string" ? content : content.parts[0].text
							return sum + (item.statistics?.tokenCount ?? Math.ceil(text.length / 4))
						}, 0) ?? 0
					result.usage.promptTokens += tokens
					result.usage.totalTokens += tokens
					break
				} catch (error) {
					const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0
					if (attempt + 1 >= MAX_BATCH_RETRIES || (status !== 429 && (status < 500 || status > 599)))
						throw error
					await new Promise((resolve) => setTimeout(resolve, INITIAL_RETRY_DELAY_MS * 2 ** attempt))
				}
			}
		}
		return result
	}

	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			await this.createEmbeddings(["test"])
			return { valid: true }
		}, "gemini")
	}

	get embedderInfo(): EmbedderInfo {
		return { name: "gemini" }
	}
}
