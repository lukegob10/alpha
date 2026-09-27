import { describe, expect, it } from "vitest"

import { alphaMessageSchema } from "../message.js"
import { modelInfoSchema } from "../model.js"
import { getVscodeLlmModelInfo } from "../providers/vscode-llm.js"

describe("async user input contracts", () => {
	it("retains experimental tool names from the model catalog", () => {
		const model = modelInfoSchema.parse({
			contextWindow: 128_000,
			supportsPromptCache: false,
			experimental_supported_tools: ["request_user_input_async"],
		})

		expect(model.experimental_supported_tools).toEqual(["request_user_input_async"])
	})

	it("advertises async questions only for the exact supported VS Code model entry", () => {
		expect(
			getVscodeLlmModelInfo({ vendor: "copilot", family: "gpt-6-astra" })?.experimental_supported_tools,
		).toEqual(["request_user_input_async"])

		for (const family of ["gpt-6-luna", "gpt-6-sol", "claude-sonnet-5", "gemini-3.7-flash"]) {
			expect(getVscodeLlmModelInfo({ vendor: "copilot", family })?.experimental_supported_tools).toBeUndefined()
		}
	})

	it("requires a typed payload on the nonblocking question card", () => {
		const card = {
			ts: 1,
			type: "say",
			say: "async_user_input",
			asyncUserInput: {
				questions: [
					{ title: "Which environment should I use?", options: ["Staging", "Production"] },
					{ title: "What deadline should I use?" },
				],
			},
		} as const

		expect(alphaMessageSchema.parse(card)).toEqual(card)
		expect(alphaMessageSchema.safeParse({ ts: 1, type: "say", say: "async_user_input" }).success).toBe(false)
		expect(
			alphaMessageSchema.safeParse({
				ts: 1,
				type: "say",
				say: "text",
				asyncUserInput: { questions: [{ title: "Which environment?" }] },
			}).success,
		).toBe(false)
	})
})
