import { beforeEach, describe, expect, it, vi } from "vitest"
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

describe("native Vertex OpenAI partner adapter", () => {
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
