import nock from "nock"

import { OpenAiCodexHandler } from "../openai-codex"

vi.mock("../../../services/chatgpt/ChatGptAuthService", () => ({
	ChatGptAuthService: {
		getInstance: () => ({
			authorizeRequest: async () => ({ accessToken: "alpha-oauth-token", signal: new AbortController().signal }),
		}),
	},
}))

afterEach(() => vi.unstubAllEnvs())

it.each(["task", "auxiliary"] as const)(
	"sends app-owned %s requests without ambient API account headers through the actual SDK",
	async (kind) => {
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-api-organization")
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-api-project")
		const output = {
			type: "message",
			id: "msg_one",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "wire answer", annotations: [] }],
		}
		const scope = nock("https://api.openai.com", {
			reqheaders: { authorization: "Bearer alpha-oauth-token" },
			badheaders: ["openai-organization", "openai-project"],
		})
			.post("/v1/responses", (body) => {
				expect(body).toMatchObject({
					model: "gpt-6.1-sol",
					stream: true,
					store: false,
					reasoning: { effort: "medium" },
					input:
						kind === "task"
							? [
									{ role: "developer", content: "Instructions" },
									{ role: "user", content: "Hello" },
								]
							: [{ role: "user", content: "Hello" }],
				})
				expect(body).not.toHaveProperty("max_output_tokens")
				expect(body).not.toHaveProperty("temperature")
				return true
			})
			.reply(
				200,
				`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_wire", status: "completed", output: [output], usage: { input_tokens: 12, output_tokens: 3 } } })}\n\n`,
				{ "Content-Type": "text/event-stream" },
			)
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		if (kind === "task") {
			const chunks = []
			for await (const chunk of handler.createMessage("Instructions", [{ role: "user", content: "Hello" }]))
				chunks.push(chunk)
			expect(chunks).toContainEqual(expect.objectContaining({ type: "text", text: "wire answer" }))
			expect(chunks).toContainEqual(
				expect.objectContaining({ type: "outcome", status: "completed", terminal: true }),
			)
		} else {
			await expect(handler.completePrompt("Hello")).resolves.toBe("wire answer")
		}
		expect(scope.isDone()).toBe(true)
	},
)
