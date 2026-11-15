import { OpenAiHandler } from "../openai"

describe("OpenAI-compatible Azure endpoint routing", () => {
	afterEach(() => vi.unstubAllGlobals())

	it.each([
		{
			baseURL: "https://fixture.services.ai.azure.com/openai/v1",
			requestURL: "https://fixture.services.ai.azure.com/openai/v1/chat/completions",
			useAzure: false,
		},
		{
			baseURL: "https://fixture.services.ai.azure.com/api/projects/example/openai/v1/",
			requestURL: "https://fixture.services.ai.azure.com/api/projects/example/openai/v1/chat/completions",
			useAzure: false,
		},
		{
			baseURL: "https://fixture.openai.azure.com/openai/v1/",
			requestURL: "https://fixture.openai.azure.com/openai/v1/chat/completions",
			useAzure: true,
		},
		{
			baseURL: "https://fixture.services.ai.azure.com",
			requestURL: "https://fixture.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
			useAzure: false,
		},
	])("uses the configured API route for $baseURL", async ({ baseURL, requestURL, useAzure }) => {
		const fetch = vi.fn(async (_url: string | URL) =>
			Response.json({
				choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
			}),
		)
		vi.stubGlobal("fetch", fetch)
		const handler = new OpenAiHandler({
			openAiBaseUrl: baseURL,
			openAiApiKey: "fixture-key",
			openAiModelId: "fixture-deployment",
			openAiUseAzure: useAzure,
			openAiStreamingEnabled: false,
			azureApiVersion: "2024-05-01-preview",
		})

		const chunks = []
		for await (const chunk of handler.createMessage("System", [{ role: "user", content: "Hello" }])) {
			chunks.push(chunk)
		}
		expect(chunks).toContainEqual({ type: "text", text: "Done" })
		await expect(handler.completePrompt("Hello")).resolves.toBe("Done")
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([requestURL, requestURL])
	})
})
