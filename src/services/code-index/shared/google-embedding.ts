import type { EmbedContentConfig } from "@google/genai"

/** Gemini 2 uses instructed inputs; 001 has an explicit retrieval task type. */
export function googleEmbeddingInput(texts: string[], model: string, purpose: "document" | "query") {
	const config: EmbedContentConfig = {}
	if (model.includes("embedding-2")) {
		return {
			// Explicit Content boundaries prevent Gemini 2 from aggregating separate chunks.
			contents: texts.map((text) => ({
				parts: [
					{
						text:
							purpose === "query"
								? `task: code retrieval | query: ${text}`
								: `title: none | text: ${text}`,
					},
				],
			})),
			config,
		}
	}
	config.taskType = purpose === "query" ? "CODE_RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT"
	return { contents: texts, config }
}
