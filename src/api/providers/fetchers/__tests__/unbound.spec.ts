import axios from "axios"

import { getUnboundModels } from "../unbound"

vi.mock("axios", () => ({
	default: {
		get: vi.fn(),
	},
}))

describe("getUnboundModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns an empty model map when the response payload is not an array", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				error: "unauthorized",
			},
		})

		await expect(getUnboundModels("test-key")).resolves.toEqual({})
	})

	it("parses model arrays from the Unbound response", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				data: [
					{
						id: "provider/model",
						max_output_tokens: 4096,
						context_window: 128_000,
						supports_caching: true,
						supports_vision: true,
						input_price: "0.1",
						output_price: "0.2",
						description: "Test model",
						caching_price: "0.3",
						cached_price: "0.4",
					},
				],
			},
		})

		await expect(getUnboundModels("test-key")).resolves.toEqual({
			"provider/model": expect.objectContaining({
				maxTokens: 4096,
				contextWindow: 128_000,
				supportsPromptCache: true,
				supportsImages: true,
				description: "Test model",
			}),
		})
	})
})
