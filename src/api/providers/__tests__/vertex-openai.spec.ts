import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import OpenAI from "openai"
import { GoogleAuth } from "google-auth-library"
import { VertexOpenAiHandler } from "../vertex-openai"

const { token, create } = vi.hoisted(() => ({ token: vi.fn(), create: vi.fn() }))
vi.mock("google-auth-library", () => ({
	GoogleAuth: vi.fn(function () {
		return { getAccessToken: token }
	}),
}))
vi.mock("openai", () => ({
	default: vi.fn(function () {
		return { chat: { completions: { create } } }
	}),
}))
const options = { apiModelId: "partner-model", projectId: "project", location: "us-central1" }
beforeEach(() => {
	vi.clearAllMocks()
	token.mockResolvedValue("google-access-token")
	create.mockResolvedValue({ choices: [{ message: { content: "answer" } }] })
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("native Vertex OpenAI partner adapter", () => {
	it("does not send ambient OpenAI account headers through the real SDK", async () => {
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-openai-organization")
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-openai-project")
		const handler = new VertexOpenAiHandler(options)
		const { default: ActualOpenAI } = await vi.importActual<typeof import("openai")>("openai")
		vi.mocked(OpenAI).mockImplementationOnce(function (options) {
			return new ActualOpenAI(options)
		})
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
			return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), {
				headers: { "content-type": "application/json" },
			})
		})
		vi.stubGlobal("fetch", fetch)

		await expect(handler.completePrompt("hello")).resolves.toBe("answer")
		expect(fetch).toHaveBeenCalledOnce()
		const [url, request] = fetch.mock.calls[0]!
		const headers = new Headers(request?.headers)
		expect(url).toBe(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/project/locations/us-central1/endpoints/openapi/chat/completions",
		)
		expect(headers.get("authorization")).toBe("Bearer google-access-token")
		expect(headers.has("openai-organization")).toBe(false)
		expect(headers.has("openai-project")).toBe(false)
	})

	it.each([-1, 25])("enforces a deadline %d ms from now during credential acquisition", async (remainingMs) => {
		vi.useFakeTimers()
		let resolveCredentials!: (value: string) => void
		const credentials = new Promise<string>((resolve) => {
			resolveCredentials = resolve
		})
		token.mockReturnValue(credentials)
		const handler = new VertexOpenAiHandler({ ...options, vertexStreamingEnabled: false })
		const rejected = vi.fn()
		const stream = handler.createMessage("System", [{ role: "user", content: "hello" }], {
			taskId: "fixture",
			deadline: Date.now() + remainingMs,
			deadlineScope: "compaction_deadline",
		})
		const pending = stream.next().catch(rejected)
		try {
			await vi.advanceTimersByTimeAsync(Math.max(0, remainingMs))
			expect(rejected).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					code: "ProviderTimeout",
					timeoutScope: "compaction_deadline",
					retryable: false,
				}),
			)
			expect(token).toHaveBeenCalledTimes(remainingMs < 0 ? 0 : 1)
		} finally {
			resolveCredentials("late-token")
			await pending
			await stream.return(undefined)
		}
		expect(OpenAI).toHaveBeenCalledOnce()
		expect(create).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["us-central1", "global"])("uses Google's %s endpoint and ADC", async (location) => {
		const handler = new VertexOpenAiHandler({
			...options,
			location,
			openAiApiKey: "unrelated-key",
			openAiBaseUrl: "https://unrelated.test",
		})
		await expect(handler.completePrompt("hello")).resolves.toBe("answer")
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
		expect(OpenAI).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: `https://${host}/v1/projects/project/locations/${location}/endpoints/openapi`,
				apiKey: "google-access-token",
				maxRetries: 0,
			}),
		)
		expect(GoogleAuth).toHaveBeenCalledWith({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "partner-model" }), expect.anything())
	})
	it.each([{ vertexKeyFile: "google.json" }, { vertexJsonCredentials: '{"client_email":"test@example.com"}' }])(
		"supports explicit credentials %j",
		async (credentials) => {
			await new VertexOpenAiHandler({ ...options, ...credentials }).completePrompt("hello")
			expect(GoogleAuth).toHaveBeenCalledWith(
				expect.objectContaining(
					credentials.vertexKeyFile
						? { keyFile: "google.json" }
						: { credentials: { client_email: "test@example.com" } },
				),
			)
		},
	)
	it("refreshes Google credentials between requests", async () => {
		const handler = new VertexOpenAiHandler(options)
		await handler.completePrompt("first")
		token.mockResolvedValueOnce("rotated-google-token")
		await handler.completePrompt("second")
		expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "rotated-google-token" }))
	})
	it.each([
		{ gatewayBaseUrl: "https://legacy.test" },
		{ vertexGatewayHelixCommand: "old-command" },
		{ modelRoutingMap: { model: "alias" } },
	])("rejects removed connection settings before credentials or dispatch: %j", (legacy) => {
		expect(() => new VertexOpenAiHandler({ ...options, ...legacy })).toThrow()
		expect(token).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})
	it("settles cancellation during Google authentication and ignores its late token", async () => {
		let resolve!: (value: string) => void
		token.mockReturnValueOnce(
			new Promise<string>((done) => {
				resolve = done
			}),
		)
		const controller = new AbortController()
		const pending = new VertexOpenAiHandler(options).completePrompt("hello", { signal: controller.signal })
		controller.abort(new Error("cancelled"))
		await expect(pending).rejects.toThrow("cancelled")
		resolve("late-token")
		await Promise.resolve()
		expect(create).not.toHaveBeenCalled()
	})
})
