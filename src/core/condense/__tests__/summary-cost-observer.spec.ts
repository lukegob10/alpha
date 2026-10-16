import type Anthropic from "@anthropic-ai/sdk"
import type { ApiHandler } from "../../../api"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { summarizeConversation } from "../index"

vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: { captureContextCondensed: vi.fn() } } }))

describe("summary usage observation", () => {
	function fixture(chunks: ApiStreamChunk[]) {
		const messages: ApiMessage[] = [
			{ role: "user", content: "Original request. ".repeat(200), ts: 1 },
			{ role: "assistant", content: "Earlier work. ".repeat(200), ts: 2 },
			{ role: "user", content: "Continue implementation. ".repeat(200), ts: 3 },
		]
		const apiHandler: ApiHandler = {
			streamCapabilities: { lifecycle: true, cancellation: true },
			createMessage: vi.fn(async function* () {
				yield* chunks
			}),
			countTokens: vi.fn(async (content: Anthropic.Messages.ContentBlockParam[]) =>
				content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0),
			),
			getModel: () => ({ id: "summary-fixture", info: { contextWindow: 50_000, supportsPromptCache: false } }),
		}
		return {
			messages,
			apiHandler,
			systemPrompt: "Task instructions",
			taskId: "summary-cost",
			maxContextTokens: 1_500,
			recentTailTokenBudget: 0,
		}
	}
	const failed: ApiStreamChunk = {
		type: "outcome",
		status: "incomplete",
		terminal: true,
		semanticOutputObserved: false,
		reason: "Summary unavailable",
	}
	it("retains the last known cost when a later usage chunk omits cost", async () => {
		const observeCost = vi.fn()
		const result = await summarizeConversation({
			...fixture([
				{ type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.01 },
				{ type: "usage", inputTokens: 11, outputTokens: 2 },
				failed,
			]),
			observeCost,
		})
		expect(result.cost).toBe(0.01)
		expect(observeCost.mock.calls).toEqual([[0.01]])
	})
	it("observes valid cumulative snapshots without summing them and accepts a latest zero", async () => {
		const observeCost = vi.fn()
		const result = await summarizeConversation({
			...fixture([
				{ type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.01 },
				{ type: "usage", inputTokens: 11, outputTokens: 2, totalCost: 0.02 },
				{ type: "usage", inputTokens: 12, outputTokens: 2, totalCost: 0 },
				failed,
			]),
			observeCost,
		})
		expect(result.cost).toBe(0)
		expect(observeCost.mock.calls).toEqual([[0.01], [0.02], [0]])
	})
	it("rejects invalid cost snapshots without discarding earlier valid observed usage", async () => {
		const observeCost = vi.fn()
		const result = await summarizeConversation({
			...fixture([
				{ type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.01 },
				{ type: "usage", inputTokens: 11, outputTokens: 2, totalCost: NaN },
				{ type: "usage", inputTokens: 12, outputTokens: 2, totalCost: -1 },
				failed,
			]),
			observeCost,
		})
		expect(result.cost).toBe(0.01)
		expect(observeCost.mock.calls).toEqual([[0.01]])
	})
})
