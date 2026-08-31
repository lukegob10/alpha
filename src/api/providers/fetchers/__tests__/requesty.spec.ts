import axios from "axios"

import { getRequestyModels } from "../requesty"

vi.mock("axios", () => ({
	default: {
		get: vi.fn(),
	},
}))

describe("getRequestyModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(axios.get).mockResolvedValue({ data: { data: [] } })
	})

	it.each([
		["https://custom.requesty.ai/v1", "https://custom.requesty.ai/v1/models"],
		["https://custom.requesty.ai/v1/", "https://custom.requesty.ai/v1/models"],
		["https://custom.requesty.ai", "https://custom.requesty.ai/v1/models"],
	])("resolves the models endpoint once for base URL %s", async (baseUrl, expectedUrl) => {
		await getRequestyModels(baseUrl, "test-key")

		expect(axios.get).toHaveBeenCalledWith(expectedUrl, {
			headers: { Authorization: "Bearer test-key" },
		})
	})
})
