import { OpenAiHandler } from "../openai"

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }))

vi.mock("openai", () => {
	const constructor = vi.fn(function () {
		return { responses: { create: responsesCreate } }
	})
	return { default: constructor, AzureOpenAI: constructor }
})

describe("OpenAI Responses overload retry advice", () => {
	beforeEach(() => {
		responsesCreate.mockReset()
		vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => vi.restoreAllMocks())

	// Codex 5a7353f0401b970c44cf7d428ef23d74f3c366d5 (2026-10-30):
	// codex-api/src/sse/responses_error_tests.rs requires structured advice for both codes.
	describe.each(["server_is_overloaded", "policy_capacity_unavailable"])("%s", (code) => {
		describe.each(["nonstreaming", "failed-event", "error-event"])("%s", (transport) => {
			it.each([
				{ name: "absent headers", headers: undefined, retryAfterMs: undefined },
				{ name: "empty headers", headers: {}, retryAfterMs: undefined },
				{ name: "invalid advice", headers: { "Retry-After": "invalid" }, retryAfterMs: undefined },
				{ name: "zero delay", headers: { "Retry-After": "0" }, retryAfterMs: 0 },
				{ name: "positive delay", headers: { "Retry-After": "3" }, retryAfterMs: 3_000 },
			])("preserves the retry contract with $name", async ({ headers, retryAfterMs }) => {
				const error = { code, message: "Capacity unavailable. Try again in 12 seconds.", headers }
				const response = { id: "resp_overload", status: "failed", error }
				const event =
					transport === "error-event" ? { type: "error", error } : { type: "response.failed", response }
				responsesCreate.mockResolvedValueOnce(
					transport === "nonstreaming"
						? response
						: {
								async *[Symbol.asyncIterator]() {
									yield event
								},
							},
				)
				const handler = new OpenAiHandler({
					openAiApiKey: "fixture-key",
					openAiModelId: "gpt-6.1-sol",
					openAiBaseUrl: "https://api.openai.com/v1",
					openAiStreamingEnabled: transport !== "nonstreaming",
				})
				let failure: unknown
				try {
					for await (const _chunk of handler.createMessage("", [])) {
						// Admission failures must remain on the task-owned retry boundary.
					}
				} catch (caught) {
					failure = caught
				}

				expect(failure).toMatchObject({
					code,
					retryable: retryAfterMs !== undefined,
					retryCategory: "transport",
				})
				if (retryAfterMs === undefined) expect(failure).not.toHaveProperty("retryAfterMs")
				else expect(failure).toHaveProperty("retryAfterMs", retryAfterMs)
				expect(responsesCreate).toHaveBeenCalledOnce()
			})
		})
	})
})
