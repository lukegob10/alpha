import { describe, expect, it } from "vitest"
import {
	EMBEDDING_MODEL_PROFILES,
	getDefaultModelId,
	getModelDimension,
	getModelScoreThreshold,
} from "../embeddingModels"

describe("Google embedding model profiles", () => {
	it("contains supported Vertex and Gemini models", () => {
		expect(Object.keys(EMBEDDING_MODEL_PROFILES).sort()).toEqual(["gemini", "vertex"])
		expect(EMBEDDING_MODEL_PROFILES.gemini).toEqual({
			"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
			"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
		})
		expect(EMBEDDING_MODEL_PROFILES.vertex).toMatchObject({
			"gemini-embedding-001": { dimension: 3072, scoreThreshold: 0.4 },
			"gemini-embedding-2": { dimension: 3072, scoreThreshold: 0.4 },
			"text-embedding-005": { dimension: 768, scoreThreshold: 0.4 },
			"text-multilingual-embedding-002": { dimension: 768, scoreThreshold: 0.4 },
		})
	})

	it("resolves dimensions and thresholds for Vertex models", () => {
		expect(getModelDimension("vertex", "gemini-embedding-001")).toBe(3072)
		expect(getModelDimension("vertex", "text-embedding-005")).toBe(768)
		expect(getModelDimension("vertex", "unknown-model")).toBeUndefined()
		expect(getModelScoreThreshold("vertex", "gemini-embedding-001")).toBe(0.4)
		expect(getModelScoreThreshold("vertex", "unknown-model")).toBeUndefined()
		expect(getModelDimension("gemini", "gemini-embedding-2")).toBe(3072)
		expect(getModelScoreThreshold("gemini", "gemini-embedding-001")).toBe(0.4)
	})

	it("uses the stable Vertex default model", () => {
		expect(getDefaultModelId("vertex")).toBe("gemini-embedding-001")
	})
})
