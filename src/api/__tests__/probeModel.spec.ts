import { describe, expect, it, vi } from "vitest"
import type { ApiHandler } from "../index"
import type { ApiStream } from "../transform/stream"
const factory = vi.hoisted(() => vi.fn())
vi.mock("../index", () => ({ buildApiHandler: factory }))
import { probeModel } from "../probeModel"

function handler(stream: () => ApiStream) {
	const result = {
		streamCapabilities: { cancellation: true, lifecycle: true },
		getModel: () => ({ id: "selected", info: {} }),
		createMessage: vi.fn(stream),
		dispose: vi.fn(),
	}
	factory.mockReturnValue(result as unknown as ApiHandler)
	return result
}

describe("actual adapter readiness", () => {
	it("requires semantic output and completion, records one request with usage provenance, and disposes", async () => {
		const api = handler(async function* () {
			yield { type: "text", text: "OK" }
			yield { type: "usage", inputTokens: 10, outputTokens: 1, usageSource: "provider" }
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: true }
		})
		const result = await probeModel({ apiProvider: "vscode-lm" })
		expect(result).toMatchObject({
			status: "completed",
			requests: 1,
			modelId: "selected",
			usage: { inputTokens: 10, outputTokens: 1, source: "provider", cost: null },
			failureCode: null,
		})
		expect(result.firstTextMs).toBeTypeOf("number")
		expect(api.createMessage).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({ tools: [], tool_choice: "none", signal: expect.any(AbortSignal) }),
		)
		expect(api.dispose).toHaveBeenCalledOnce()
	})
	it("does not count metadata-only or incomplete output as readiness and preserves unknown usage", async () => {
		handler(async function* () {
			yield { type: "outcome", status: "completed", terminal: true, semanticOutputObserved: false }
		})
		expect(await probeModel({})).toMatchObject({
			status: "failed",
			requests: 1,
			firstTextMs: null,
			usage: null,
			failureCode: "empty_response",
		})
		handler(async function* () {
			yield { type: "text", text: "visible" }
		})
		expect(await probeModel({})).toMatchObject({ status: "failed", failureCode: "incomplete_response" })
	})
	it("cancels before dispatch and never exports provider exception text", async () => {
		const api = handler(async function* () {
			yield* []
			throw new Error("SECRET-provider-error")
		})
		const controller = new AbortController()
		controller.abort()
		expect(await probeModel({}, controller.signal)).toMatchObject({
			status: "failed",
			requests: 0,
			failureCode: "cancelled_or_deadline",
		})
		expect(api.createMessage).not.toHaveBeenCalled()
		expect(JSON.stringify(await probeModel({}))).not.toContain("SECRET")
	})
})
