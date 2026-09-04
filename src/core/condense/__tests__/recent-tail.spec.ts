import type Anthropic from "@anthropic-ai/sdk"
import { TelemetryService } from "@alpha-code/telemetry"
import { BaseProvider } from "../../../api/providers/base-provider"
import type { ApiStream } from "../../../api/transform/stream"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { manageContext } from "../../context-management"
import {
	cleanupAfterTruncation,
	countContextTokens,
	countHistoryTokens,
	getEffectiveApiHistory,
	getLogicalStepStarts,
	hasToolCallResultIntegrity,
	selectRecentTail,
	summarizeConversation,
} from "../index"

class SummaryProvider extends BaseProvider {
	requests: Anthropic.MessageParam[][] = []
	async *createMessage(_system: string, messages: Anthropic.MessageParam[]): ApiStream {
		this.requests.push(messages)
		yield {
			type: "text",
			text: "Earlier investigation completed. Preserve the user's constraints and continue the task.",
		}
	}
	getModel() {
		return { id: "fixture", info: { contextWindow: 20_000, maxTokens: 2_000, supportsPromptCache: false } }
	}
	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]) {
		return content.reduce((sum, block) => sum + Math.ceil(JSON.stringify(block).length / 4), 0)
	}
}

function history(): ApiMessage[] {
	return [
		{ role: "user", content: "Initial task: investigate the service.", ts: 1 },
		{ role: "assistant", content: "Older investigation. ".repeat(1000), ts: 2 },
		{ role: "user", content: "Keep the timeout at exactly 750 ms; do not change the API.", ts: 3 },
		{
			role: "assistant",
			...{ vscodeLmStatefulMarker: "opaque-vscode-state" },
			ts: 4,
			id: "response-1",
			encrypted_content: "encrypted-provider-state",
			reasoning_content: "Check exact definitions before proceeding.",
			reasoning_details: [{ type: "reasoning.encrypted", data: "signed-opaque-state", signature: "signature-1" }],
			content: [
				{ type: "thinking", thinking: "Inspect definitions", signature: "thinking-signature" },
				{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "service.ts" } },
				{ type: "tool_use", id: "read-2", name: "read_file", input: { path: "service.test.ts" } },
			],
		},
		{
			role: "user",
			ts: 5,
			content: [{ type: "tool_result", tool_use_id: "read-1", content: "export const timeout = 750" }],
		},
		{
			role: "user",
			ts: 6,
			content: [
				{ type: "tool_result", tool_use_id: "read-2", content: "expect(timeout).toBe(750)", is_error: false },
			],
		},
	]
}

const options = (messages: ApiMessage[], apiHandler = new SummaryProvider()) => ({
	messages,
	apiHandler,
	taskId: "recent-tail",
	systemPrompt: "Developer policy remains authoritative.",
	maxContextTokens: 3000,
	recentTailTokenBudget: 1000,
})

beforeEach(() => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
})

describe("exact recent working set", () => {
	it("keeps a sole complete step intact when there is no older prefix to summarize", async () => {
		const messages = history().slice(2)
		const provider = new SummaryProvider()
		const result = await summarizeConversation(options(messages, provider))
		expect(result.status).toBe("exhausted")
		expect(result.messages).toBe(messages)
		expect(provider.requests).toEqual([])
	})

	it("counts an oversized sole step before choosing the explicit whole-step fallback", async () => {
		const messages = history().slice(2)
		const result = await summarizeConversation({ ...options(messages), recentTailTokenBudget: 1 })
		expect(result.status).toBe("reduced")
		expect(result.tailFallback).toBe("newest_step_exceeds_budget")
		expect(result.retainedTailMessages).toBe(0)
		expect(getEffectiveApiHistory(result.messages)).toHaveLength(1)
	})

	it.each([false, true])(
		"retains complete recent transactions verbatim (automatic=%s)",
		async (isAutomaticTrigger) => {
			const messages = history()
			const original = structuredClone(messages)
			const provider = new SummaryProvider()
			const result = await summarizeConversation({ ...options(messages, provider), isAutomaticTrigger })
			const active = getEffectiveApiHistory(result.messages)
			expect(result.status).toBe("reduced")
			expect(active[0]).toMatchObject({ role: "user", isSummary: true })
			expect(active.slice(1)).toEqual(original.slice(2))
			active.slice(1).forEach((message, index) => expect(message).toBe(messages[index + 2]))
			expect(result.messages.filter((message) => message.condenseParent)).toHaveLength(2)
			expect(hasToolCallResultIntegrity(active)).toBe(true)
			expect(result.retainedTailTokens).toBeLessThanOrEqual(1000)
			expect(result.newContextTokens).toBeLessThanOrEqual(3000)
			expect(JSON.stringify(provider.requests[0])).not.toContain("export const timeout")
			expect(JSON.stringify(provider.requests[0])).not.toContain("exactly 750 ms")
			expect(messages).toEqual(original)
		},
	)

	it("counts opaque top-level and content state toward the tail budget", async () => {
		const provider = new SummaryProvider()
		const messages = history()
		const normal = await countHistoryTokens(messages.slice(2), provider)
		messages[3] = { ...messages[3], encrypted_content: "opaque".repeat(1000) }
		expect(await countHistoryTokens(messages.slice(2), provider)).toBeGreaterThan(normal + 1000)
		const tail = await selectRecentTail(messages, provider, normal)
		expect(tail).toMatchObject({ startIndex: messages.length, tokens: 0, newestStepTooLarge: true })
	})

	it("uses the same complete-step boundary for nonadjacent results and reasoning records", () => {
		const messages = history()
		messages.splice(4, 0, {
			role: "assistant",
			content: [],
			type: "reasoning",
			encrypted_content: "continuation",
			ts: 4.5,
		})
		expect(getLogicalStepStarts(messages)).toEqual([0, 2])
		expect(hasToolCallResultIntegrity(messages)).toBe(true)
	})

	it("summarizes an oversized newest transaction as a whole with an explicit fallback notice", async () => {
		const messages = history()
		const result = await summarizeConversation({ ...options(messages), recentTailTokenBudget: 1 })
		expect(result.tailFallback).toBe("newest_step_exceeds_budget")
		expect(result.retainedTailMessages).toBe(0)
		expect(getEffectiveApiHistory(result.messages)).toHaveLength(1)
		expect(JSON.stringify(getEffectiveApiHistory(result.messages))).toContain("newest complete step exceeded")
		expect(
			result.messages
				.filter((message) => !message.isSummary)
				.map(({ condenseParent: _parent, ...message }) => message),
		).toEqual(messages)
	})

	it("leaves the original history intact when system, summary and tail cannot fit", async () => {
		const messages = history()
		const result = await summarizeConversation({ ...options(messages), maxContextTokens: 30 })
		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.condenseId).toBeUndefined()
	})

	it("does not accept an invalid provider token estimate as a reduced context", async () => {
		const messages = history()
		const provider = new SummaryProvider()
		vi.spyOn(provider, "countTokens").mockResolvedValue(Number.NaN)
		const result = await summarizeConversation(options(messages, provider))
		expect(result.status).toBe("no_progress")
		expect(result.messages).toBe(messages)
		expect(result.condenseId).toBeUndefined()
	})

	it("does not compact an incomplete call or manufacture a successful result", async () => {
		const messages = history().slice(0, -1)
		const provider = new SummaryProvider()
		const result = await summarizeConversation(options(messages, provider))
		expect(result.status).toBe("exhausted")
		expect(result.messages).toBe(messages)
		expect(provider.requests).toEqual([])
	})

	it("reloads and rewinds inserted summaries without moving or changing original records", async () => {
		const messages = history()
		const result = await summarizeConversation(options(messages))
		const reloaded: ApiMessage[] = JSON.parse(JSON.stringify(result.messages))
		expect(getEffectiveApiHistory(reloaded).slice(1)).toEqual(messages.slice(2))
		const rewound = cleanupAfterTruncation(reloaded.filter((message) => (message.ts ?? 0) < 3))
		expect(getEffectiveApiHistory(rewound)).toEqual(messages.slice(0, 2))
		const restored = cleanupAfterTruncation(reloaded.filter((message) => !message.isSummary))
		expect(restored).toEqual(messages)
	})

	it("repeated compaction summarizes only the superseded prefix and retains the newest exact step", async () => {
		const provider = new SummaryProvider()
		const first = await summarizeConversation(options(history(), provider))
		const noNewWork = await summarizeConversation(options(first.messages, provider))
		expect(noNewWork.status).toBe("exhausted")
		expect(noNewWork.messages).toBe(first.messages)
		const next: ApiMessage[] = [
			{ role: "assistant", content: "New result. ".repeat(300), ts: Date.now() + 5 },
			{ role: "user", content: "Continue with that exact result.", ts: Date.now() + 6 },
		]
		const second = await summarizeConversation(options([...first.messages, ...next], provider))
		expect(second.status).toBe("reduced")
		expect(getEffectiveApiHistory(second.messages).slice(1)).toEqual(next)
		expect(hasToolCallResultIntegrity(getEffectiveApiHistory(second.messages))).toBe(true)
		expect(second.messages.filter((message) => message.isSummary)).toHaveLength(2)
		expect(
			Math.max(...second.messages.filter((message) => message.isSummary).map((message) => message.ts!)),
		).toBeGreaterThan(next[1].ts!)
	})
})

describe("budgeted truncation and cancellation", () => {
	it("forces a real recovery when a provider rejects input below local trigger estimates", async () => {
		const messages = history()
		const provider = new SummaryProvider()
		const result = await manageContext({
			...options(messages, provider),
			totalTokens: 10,
			contextWindow: 20000,
			maxTokens: 1000,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
			profileThresholds: {},
			currentProfileId: "test",
			forceCompaction: true,
		})
		expect(result.status).toBe("reduced")
		expect(result.messages).not.toBe(messages)
		expect(provider.requests).toHaveLength(1)
		expect(getEffectiveApiHistory(result.messages).slice(1)).toEqual(messages.slice(2))
	})

	it("truncates after a prior summary without charging its hidden original history", async () => {
		const provider = new SummaryProvider()
		const first = await summarizeConversation(options(history(), provider))
		const newest = history()
			.slice(2)
			.map((message) => ({ ...message, ts: (message.ts ?? 0) + 20 }))
		// Distinct IDs ensure these are separate completed transactions after reload.
		const newTransaction: ApiMessage[] = JSON.parse(JSON.stringify(newest).replaceAll("read-", "next-read-"))
		const messages: ApiMessage[] = [
			...first.messages,
			{ role: "assistant", content: "Intermediate discussion ".repeat(1500), ts: 20 },
			...newTransaction,
		]
		const result = await manageContext({
			...options(messages, provider),
			totalTokens: 10000,
			contextWindow: 3000,
			maxTokens: 1000,
			autoCondenseContext: false,
			autoCondenseContextPercent: 50,
			profileThresholds: {},
			currentProfileId: "test",
		})
		expect(result.status).toBe("reduced")
		expect(result.newContextTokensAfterTruncation).toBeLessThanOrEqual(1500)
		const active = getEffectiveApiHistory(result.messages)
		expect(active[0].isSummary).toBe(true)
		expect(active.slice(-4)).toEqual(newTransaction)
		expect(hasToolCallResultIntegrity(active)).toBe(true)
		expect(JSON.stringify(active)).not.toContain("Older investigation")
		expect(result.messages.filter((message) => !message.isTruncationMarker)).toHaveLength(messages.length)
	})

	it("falls back to an exact bounded suffix and counts only the active projection", async () => {
		const provider = new SummaryProvider()
		const messages: ApiMessage[] = [
			{ role: "user", content: "Original constraints", ts: 1 },
			{ role: "assistant", content: "Acknowledged", ts: 2 },
			{ role: "user", content: "Old context ".repeat(2000), ts: 3 },
			{ role: "assistant", content: "Old answer ".repeat(2000), ts: 4 },
			...history()
				.slice(2)
				.map((message) => ({ ...message, ts: (message.ts ?? 0) + 2 })),
		]
		const original = structuredClone(messages)
		const result = await manageContext({
			...options(messages, provider),
			totalTokens: 9000,
			contextWindow: 3000,
			maxTokens: 1000,
			autoCondenseContext: false,
			autoCondenseContextPercent: 50,
			profileThresholds: {},
			currentProfileId: "test",
		})
		expect(result.status).toBe("reduced")
		const active = getEffectiveApiHistory(result.messages)
		expect(active.slice(-4)).toEqual(messages.slice(-4))
		expect(hasToolCallResultIntegrity(active)).toBe(true)
		expect(result.newContextTokensAfterTruncation).toBe(
			await countContextTokens(active, provider, options(messages).systemPrompt),
		)
		expect(result.newContextTokensAfterTruncation).toBeLessThanOrEqual(result.targetContextTokens!)
		expect(messages).toEqual(original)
		expect(cleanupAfterTruncation(result.messages.filter((message) => !message.isTruncationMarker))).toEqual(
			messages,
		)
	})

	it("reports exhaustion without hiding a newest transaction that cannot fit", async () => {
		const messages = history()
		const result = await manageContext({
			...options(messages),
			totalTokens: 9000,
			contextWindow: 1200,
			maxTokens: 1000,
			autoCondenseContext: false,
			autoCondenseContextPercent: 50,
			profileThresholds: {},
			currentProfileId: "test",
		})
		expect(result.status).toBe("exhausted")
		expect(result.messages).toBe(messages)
		expect(result.truncationId).toBeUndefined()
	})

	it("cancellation during the summary stream never falls through to truncation", async () => {
		const provider = new SummaryProvider()
		let signalStarted!: () => void
		let release!: () => void
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve
		})
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		vi.spyOn(provider, "createMessage").mockImplementation(async function* () {
			signalStarted()
			await gate
			yield { type: "text", text: "late summary" }
		})
		const controller = new AbortController()
		const messages = history()
		const original = structuredClone(messages)
		const pending = manageContext({
			...options(messages, provider),
			totalTokens: 9000,
			contextWindow: 10000,
			maxTokens: 1000,
			autoCondenseContext: true,
			autoCondenseContextPercent: 50,
			profileThresholds: {},
			currentProfileId: "test",
			metadata: { taskId: "cancel", signal: controller.signal },
		})
		await started
		controller.abort()
		release()
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(messages).toEqual(original)
	})
})
