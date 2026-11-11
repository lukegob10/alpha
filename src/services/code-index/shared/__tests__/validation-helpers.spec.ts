import i18next from "../../../../i18n"
import embeddingTranslations from "../../../../i18n/locales/en/embeddings.json"

import { formatEmbeddingError, withValidationErrorHandling } from "../validation-helpers"

describe("embedding validation error contracts", () => {
	beforeAll(() => {
		i18next.addResourceBundle("en", "embeddings", embeddingTranslations, true, true)
	})

	it.each([
		[401, "Authentication failed"],
		[403, "Authentication failed"],
		[404, "Invalid API endpoint"],
		[429, "not available"],
		[503, "Invalid embedder configuration"],
	] as const)("returns actionable configuration guidance for HTTP %s", async (status, message) => {
		const result = await withValidationErrorHandling(async () => {
			throw Object.assign(new Error("Provider rejected the validation request"), { response: { status } })
		}, "vertex")

		expect(result.valid).toBe(false)
		expect(result.error).toContain(message)
	})

	it("retains a provider's actionable configuration error", async () => {
		const result = await withValidationErrorHandling(async () => {
			throw new Error("The embedding deployment is not ready")
		}, "vertex")

		expect(result).toEqual({ valid: false, error: "The embedding deployment is not ready" })
	})

	it("returns connection guidance when the embedding service cannot be reached", async () => {
		const result = await withValidationErrorHandling(async () => {
			throw new Error("ECONNREFUSED")
		}, "vertex")

		expect(result.valid).toBe(false)
		expect(result.error).toContain("Failed to connect")
	})

	it("preserves a custom validator's returned result", async () => {
		const result = { valid: false, error: "Choose an embedding model" }
		await expect(withValidationErrorHandling(async () => result, "vertex")).resolves.toEqual(result)
	})

	it("retains provider status, attempt count and message after retries are exhausted", () => {
		const result = formatEmbeddingError(Object.assign(new Error("Service overloaded"), { status: 503 }), 3)

		expect(result.message).toBe("Failed to create embeddings after 3 attempts: HTTP 503 - Service overloaded")
	})

	it("provides credential guidance for authentication failures", () => {
		const result = formatEmbeddingError(Object.assign(new Error("Invalid credential"), { status: 401 }), 1)

		expect(result.message).toContain("Authentication failed")
		expect(result.message).toContain("API key")
	})
})
