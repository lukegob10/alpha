import { getNativeOpenAiModelCapabilities } from "../openai-model-capabilities"

describe("native OpenAI model capabilities", () => {
	it.each([
		"gpt-5.4",
		"gpt-5.5",
		"gpt-5.6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-6-astra",
		"gpt-6-luna",
		"gpt-6-sol",
		"gpt-6.1-sol",
	])("keeps the exact supported model's transport and patch capabilities separate (%s)", (modelId) => {
		expect(getNativeOpenAiModelCapabilities(modelId)).toEqual({ responses: true, freeformApplyPatch: true })
	})

	it.each([
		undefined,
		"",
		"https://api.openai.com",
		"https://api.openai.com/",
		"https://api.openai.com/v1",
		"https://api.openai.com/v1/",
		"https://api.openai.com:443/v1",
	])("recognizes only the native API origin and root (%s)", (baseUrl) => {
		expect(getNativeOpenAiModelCapabilities("gpt-6.1-sol", baseUrl)?.responses).toBe(true)
	})

	it.each([
		"http://api.openai.com/v1",
		"https://api.openai.com:8443/v1",
		"https://user:password@api.openai.com/v1",
		"https://compatible.example/v1",
		"https://api.openai.com.compatible.example/v1",
		"https://api.openai.com/v1/chat/completions",
		"https://api.openai.com/v1?compat=true",
		"https://api.openai.com/v1#compatible",
		"invalid-url",
	])("does not infer native capability for a compatible endpoint (%s)", (baseUrl) => {
		expect(getNativeOpenAiModelCapabilities("gpt-6.1-sol", baseUrl)).toBeUndefined()
	})

	it.each(["gpt-6.1-sol-preview", "gpt-6.2-sol", " gpt-6.1-sol ", "GPT-6.1-SOL", "__proto__"])(
		"does not guess capabilities from a model name (%s)",
		(modelId) => {
			expect(getNativeOpenAiModelCapabilities(modelId)).toBeUndefined()
		},
	)

	it("keeps Azure deployments outside native OpenAI capabilities", () => {
		expect(getNativeOpenAiModelCapabilities("gpt-6.1-sol", "https://api.openai.com/v1", true)).toBeUndefined()
	})
})
