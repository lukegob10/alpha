import { describe, expect, it, vi } from "vitest"

import Anthropic from "@anthropic-ai/sdk"
import type { ModelInfo } from "@alpha-code/types"

import type { ApiStream } from "../../../api/transform/stream"
import { BaseProvider } from "../../../api/providers/base-provider"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	countContextTokens,
	getEffectiveApiHistory,
	summarizeConversation,
	type SummarizeConversationOptions,
} from "../index"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: { captureContextCondensed: vi.fn() },
		hasInstance: vi.fn(() => true),
		createInstance: vi.fn(),
	},
}))

const SYSTEM_PROMPT = "You are a coding assistant."
const SYNTHETIC_CONTEXT_WINDOW = 128_000
const SYNTHETIC_OUTPUT_RESERVE = 5_000
const CRITICAL_FILE = "src/critical-policy.ts"
const TOOL_CALL_ID = "read-critical-policy"
const CRITICAL_EVIDENCE = [
	"src/critical-policy.ts:18",
	"export const retryLimit = 3",
	"export const retryBackoffMs = 250",
].join("\n")

type RecentTailOptions = Pick<SummarizeConversationOptions, "recentTailTokenBudget" | "maxContextTokens">

type BenchmarkFixture = {
	history: ApiMessage[]
	oldSummary: string
	systemPrompt: string
}

// Stage1 baseline captured from commit 678baf4 with the same fixture and the
// temporary isolated Stage1 module: originalInput=51712, summaryRequest=53185,
// activeTokens=57, repeatedReadCount=1, scriptedModelToolRoundTrips=2,
// effectiveHistoryLength=1. The summary text below is a deterministic fixture
// snapshot; the metrics are measured outputs. The 57 active-token value is
// recomputed from the returned effective history with the same provider counter;
// it is not Stage1's newContextTokens field.

type ContinuationMetrics = {
	activeTokens: number
	repeatedReadCount: number
	scriptedModelToolRoundTrips: number
	answer: string
}

type ScenarioResult = {
	responseSummary: string
	effectiveHistory: ApiMessage[]
	metrics: ContinuationMetrics
	summaryInputContainsCriticalEvidence: boolean
	summaryRequestTokens: number
	continuationRequestCount: number
	retainedTailMessages?: number
	retainedTailTokens?: number
}

type ReadFileRequest = {
	type: "read_file"
	path: string
}

type ContinuationRequest = { type: "model"; history: ApiMessage[] } | { type: "tool"; request: ReadFileRequest }

class SyntheticProvider extends BaseProvider {
	readonly summaryRequests: Anthropic.Messages.MessageParam[][] = []
	readonly summarySystemPrompts: string[] = []
	readonly continuationRequests: ContinuationRequest[] = []
	readonly readFileInvocations: ReadFileRequest[] = []

	constructor(private readonly summaryText: string) {
		super()
	}

	override createMessage(_systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		this.summarySystemPrompts.push(_systemPrompt)
		this.summaryRequests.push(messages)
		const summary = this.summaryText
		return (async function* () {
			yield { type: "text" as const, text: summary }
			yield { type: "usage" as const, inputTokens: 0, outputTokens: 0, totalCost: 0 }
		})()
	}

	override getModel(): { id: string; info: ModelInfo } {
		return {
			id: "nor-24-synthetic",
			info: {
				contextWindow: SYNTHETIC_CONTEXT_WINDOW,
				maxTokens: SYNTHETIC_OUTPUT_RESERVE,
				supportsPromptCache: false,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Deterministic NOR-24 fixture provider",
			},
		}
	}

	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		let tokens = 0
		for (const block of content) {
			let text: string
			if (block.type === "text") {
				text = block.text
			} else if (block.type === "tool_use") {
				text = JSON.stringify(block)
			} else if (block.type === "tool_result") {
				text = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
			} else {
				text = JSON.stringify(block)
			}
			tokens += Math.ceil(text.length / 4)
		}
		return tokens
	}

	recordModelRequest(history: ApiMessage[]): void {
		this.continuationRequests.push({ type: "model", history })
	}

	readFile(request: ReadFileRequest): string {
		this.continuationRequests.push({ type: "tool", request })
		this.readFileInvocations.push(request)
		if (request.path !== CRITICAL_FILE) throw new Error(`Unexpected fixture read: ${request.path}`)
		return CRITICAL_EVIDENCE
	}
}

function buildFixture(): BenchmarkFixture {
	const oldSummary =
		"The task updates retry behavior and asks for a compatibility preserving answer. A configuration file was inspected, but the exact source evidence is omitted."
	const oldPrefix = Array.from(
		{ length: 6 },
		(_, index): ApiMessage => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `legacy-context-${index}\n${"Historical implementation detail retained only in the old prefix. ".repeat(520)}`,
			ts: index + 1,
		}),
	)

	const latestConstraint: ApiMessage = {
		role: "user",
		content: `Latest constraint: answer using the exact values from ${CRITICAL_FILE}; preserve the provider reasoning and opaque state when context is compacted.`,
		ts: 7,
	}
	const readRequest: ApiMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I will read the critical policy before answering." },
			{ type: "tool_use", id: TOOL_CALL_ID, name: "read_file", input: { path: CRITICAL_FILE } },
		],
		ts: 8,
		reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-provider-reasoning" }],
		reasoning_content: "opaque interleaved reasoning",
		encrypted_content: "opaque-encrypted-reasoning",
	}
	const readResult: ApiMessage = {
		role: "user",
		content: [
			{ type: "tool_result", tool_use_id: TOOL_CALL_ID, content: [{ type: "text", text: CRITICAL_EVIDENCE }] },
		],
		ts: 9,
	}

	return {
		history: [...oldPrefix, latestConstraint, readRequest, readResult],
		oldSummary,
		systemPrompt: SYSTEM_PROMPT,
	}
}

function containsCriticalEvidence(value: unknown): boolean {
	return JSON.stringify(value).replaceAll("\\n", "\n").includes(CRITICAL_EVIDENCE)
}

function requestBlocks(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.ContentBlockParam[] {
	return messages.flatMap((message) =>
		typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
	)
}

async function runScriptedContinuation(
	provider: SyntheticProvider,
	fixture: BenchmarkFixture,
	effectiveHistory: ApiMessage[],
): Promise<ContinuationMetrics> {
	const activeTokens = await countContextTokens(effectiveHistory, provider, fixture.systemPrompt)
	let continuationHistory = effectiveHistory

	// Keep the synthetic continuation bounded: one initial model request, at most
	// one read_file transaction, and one final model request.
	for (let round = 0; round < 2; round++) {
		provider.recordModelRequest(continuationHistory)
		if (containsCriticalEvidence(continuationHistory)) {
			return {
				activeTokens,
				repeatedReadCount: provider.readFileInvocations.length,
				scriptedModelToolRoundTrips: provider.continuationRequests.filter((request) => request.type === "model")
					.length,
				answer: "Answer uses the exact retained critical policy evidence.",
			}
		}

		const readRequest: ReadFileRequest = { type: "read_file", path: CRITICAL_FILE }
		const readRequestMessage: ApiMessage = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: `reread-${round}`, name: "read_file", input: { path: readRequest.path } },
			],
			ts: 100 + round,
		}
		const readResultMessage: ApiMessage = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `reread-${round}`, content: provider.readFile(readRequest) }],
			ts: 200 + round,
		}
		continuationHistory = [...continuationHistory, readRequestMessage, readResultMessage]
	}

	throw new Error("Bounded scripted continuation did not recover critical evidence")
}

async function runScenario(
	summarizer: typeof summarizeConversation,
	fixture: BenchmarkFixture,
	options: RecentTailOptions = {},
): Promise<ScenarioResult> {
	const provider = new SyntheticProvider(fixture.oldSummary)
	const response = await summarizer({
		messages: fixture.history,
		apiHandler: provider,
		systemPrompt: fixture.systemPrompt,
		taskId: "nor-24-recent-tail-fixture",
		metadata: { taskId: "nor-24-recent-tail-fixture" },
		...options,
	})
	if (response.error) throw new Error(response.error)
	const effectiveHistory = getEffectiveApiHistory(response.messages)
	const metrics = await runScriptedContinuation(provider, fixture, effectiveHistory)
	const summaryRequestTokens = await provider.countTokens([
		{ type: "text", text: provider.summarySystemPrompts[0] ?? "" },
		...requestBlocks(provider.summaryRequests[0] ?? []),
	])
	return {
		responseSummary: response.summary,
		effectiveHistory,
		metrics,
		summaryInputContainsCriticalEvidence: containsCriticalEvidence(provider.summaryRequests[0]),
		summaryRequestTokens,
		continuationRequestCount: provider.continuationRequests.length,
		retainedTailMessages: response.retainedTailMessages,
		retainedTailTokens: response.retainedTailTokens,
	}
}

describe("NOR-24 bounded recent-tail compaction fixture", () => {
	it("matches the summary-only baseline and bounded exact tail", async () => {
		const fixture = buildFixture()
		const originalProvider = new SyntheticProvider(fixture.oldSummary)
		const originalActiveTokens = await countContextTokens(fixture.history, originalProvider, fixture.systemPrompt)
		expect(originalActiveTokens).toBe(51712)
		expect(originalActiveTokens).toBeLessThanOrEqual(SYNTHETIC_CONTEXT_WINDOW - SYNTHETIC_OUTPUT_RESERVE)
		const baseline = await runScenario(summarizeConversation, fixture, {
			recentTailTokenBudget: 0,
			maxContextTokens: 5000,
		})

		expect(baseline.responseSummary).toBe(fixture.oldSummary)
		expect(baseline.summaryInputContainsCriticalEvidence).toBe(true)
		expect(baseline.effectiveHistory.some(containsCriticalEvidence)).toBe(false)
		expect(baseline.metrics.activeTokens).toBe(95)
		expect(baseline.metrics.repeatedReadCount).toBe(1)
		expect(baseline.metrics.scriptedModelToolRoundTrips).toBe(2)
		expect(baseline.continuationRequestCount).toBe(3)
		const result = await runScenario(summarizeConversation, fixture, {
			recentTailTokenBudget: 2000,
			maxContextTokens: 5000,
		})

		expect(result.responseSummary).toBe(fixture.oldSummary)
		expect(result.effectiveHistory).toHaveLength(4)
		expect(result.effectiveHistory[0].isSummary).toBe(true)
		expect(result.effectiveHistory.slice(1)).toEqual(fixture.history.slice(-3))
		expect(result.effectiveHistory[2]).toMatchObject({
			reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-provider-reasoning" }],
			reasoning_content: "opaque interleaved reasoning",
			encrypted_content: "opaque-encrypted-reasoning",
		})
		expect(result.summaryInputContainsCriticalEvidence).toBe(false)
		expect(containsCriticalEvidence(result.effectiveHistory)).toBe(true)
		expect(result.metrics.repeatedReadCount).toBe(0)
		expect(result.metrics.scriptedModelToolRoundTrips).toBe(1)
		expect(result.metrics.activeTokens).toBe(225)
		expect(result.metrics.activeTokens).toBeLessThanOrEqual(5000)
		expect(result.continuationRequestCount).toBe(1)
		expect(result.retainedTailMessages).toBe(3)
		expect(result.retainedTailTokens).toBeGreaterThan(0)

		console.info("NOR-24 matched synthetic fixture", {
			stage1Baseline: {
				originalInputActiveTokens: 51712,
				summaryRequestTokens: 53185,
				activeTokens: 57,
				repeatedReadCount: 1,
				scriptedModelToolRoundTrips: 2,
			},
			originalInput: {
				activeTokens: originalActiveTokens,
				windowMinusOutputReserve: SYNTHETIC_CONTEXT_WINDOW - SYNTHETIC_OUTPUT_RESERVE,
			},
			summaryOnlyControl: {
				activeTokens: baseline.metrics.activeTokens,
				summaryRequestTokens: baseline.summaryRequestTokens,
				repeatedReadCount: baseline.metrics.repeatedReadCount,
				scriptedModelToolRoundTrips: baseline.metrics.scriptedModelToolRoundTrips,
			},
			boundedTail: {
				activeTokens: result.metrics.activeTokens,
				summaryRequestTokens: result.summaryRequestTokens,
				repeatedReadCount: result.metrics.repeatedReadCount,
				scriptedModelToolRoundTrips: result.metrics.scriptedModelToolRoundTrips,
				retainedTailMessages: result.retainedTailMessages,
				retainedTailTokens: result.retainedTailTokens,
				continuationRequestCount: result.continuationRequestCount,
			},
		})
	})
})
