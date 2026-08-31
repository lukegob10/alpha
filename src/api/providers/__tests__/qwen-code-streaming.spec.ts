vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn().mockResolvedValue(
			JSON.stringify({
				access_token: "test-access-token",
				refresh_token: "test-refresh-token",
				token_type: "Bearer",
				expiry_date: Date.now() + 3_600_000,
				resource_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			}),
		),
		writeFile: vi.fn(),
	},
}))

const mockCreate = vi.fn()
vi.mock("openai", () => ({
	default: vi.fn().mockImplementation(() => ({
		apiKey: "test-key",
		baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		chat: { completions: { create: mockCreate } },
	})),
}))

import { QwenCodeHandler } from "../qwen-code"

describe("QwenCodeHandler streaming content", () => {
	let handler: QwenCodeHandler

	beforeEach(() => {
		vi.clearAllMocks()
		handler = new QwenCodeHandler({ apiModelId: "qwen3-coder-plus" })
	})

	it("preserves fragmentary content deltas without cumulative de-duplication", async () => {
		mockCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { choices: [{ delta: { content: "a" } }] }
				yield { choices: [{ delta: { content: "and" } }] }
			},
		})

		const text: string[] = []
		for await (const chunk of handler.createMessage("test prompt", [])) {
			if (chunk.type === "text") text.push(chunk.text)
		}

		expect(text.join("")).toBe("aand")
	})

	it("matches thinking tags split across stream chunks", async () => {
		mockCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { choices: [{ delta: { content: "<thi" } }] }
				yield { choices: [{ delta: { content: "nk>foo" } }] }
				yield { choices: [{ delta: { content: "bar</thi" } }] }
				yield { choices: [{ delta: { content: "nk>answer" } }] }
			},
		})

		const reasoning: string[] = []
		const text: string[] = []
		for await (const chunk of handler.createMessage("test prompt", [])) {
			if (chunk.type === "reasoning") reasoning.push(chunk.text)
			if (chunk.type === "text") text.push(chunk.text)
		}

		expect(reasoning.join("")).toBe("foobar")
		expect(text.join("")).toBe("answer")
	})

	it("classifies thinking tags after a nonempty text prefix", async () => {
		mockCreate.mockResolvedValueOnce({
			[Symbol.asyncIterator]: async function* () {
				yield { choices: [{ delta: { content: "prefix:" } }] }
				yield { choices: [{ delta: { content: "<think>reasoning" } }] }
				yield { choices: [{ delta: { content: "</think>suffix" } }] }
			},
		})

		const reasoning: string[] = []
		const text: string[] = []
		for await (const chunk of handler.createMessage("test prompt", [])) {
			if (chunk.type === "reasoning") reasoning.push(chunk.text)
			if (chunk.type === "text") text.push(chunk.text)
		}

		expect(reasoning.join("")).toBe("reasoning")
		expect(text.join("")).toBe("prefix:suffix")
	})
})
