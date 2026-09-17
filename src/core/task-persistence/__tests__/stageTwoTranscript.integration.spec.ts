import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import { describe, expect, it } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { BaseProvider } from "../../../api/providers/base-provider"
import { summarizeConversation, getEffectiveApiHistory, type SummarizeConversationOptions } from "../../condense"
import type { AgentToolCall } from "../../agent/AgentResponse"
import { createAgentResponse } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { ApiMessage } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"

const TASK_ID = "stage-two-transcript-fixture"
const SUMMARY_SYSTEM_PROMPT = "Synthetic transcript integration test system prompt"
const RECENT_CONSTRAINT = "RECENT-CONSTRAINT: preserve src/fixture.ts line 7 exactly and report the result verbatim."
const COMMIT_TIME = 1_700_000_000_000

type FixtureStatus = "success" | "error" | "cancelled"

type FixtureTool = {
	id: string
	name: string
	status: FixtureStatus
}

type CompletionGate = {
	promise: Promise<void>
	resolve: () => void
}

type FixtureHostState = {
	host: ToolExecutionHost
	published: Anthropic.Messages.ToolResultBlockParam[]
}

/** A controlled promise keeps completion order deterministic without timing sleeps. */
function createCompletionGate(): CompletionGate {
	let resolvePromise: (() => void) | undefined
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	return {
		promise,
		resolve: () => {
			if (!resolvePromise) throw new Error("Completion gate resolver is unavailable")
			const resolve = resolvePromise
			resolvePromise = undefined
			resolve()
		},
	}
}

function createStartedBarrier(expectedCount: number): { promise: Promise<void>; markStarted: () => void } {
	let resolveBarrier: (() => void) | undefined
	let startedCount = 0
	const promise = new Promise<void>((resolve) => {
		resolveBarrier = resolve
	})
	return {
		promise,
		markStarted: () => {
			startedCount += 1
			if (startedCount === expectedCount) {
				if (!resolveBarrier) throw new Error("Started barrier resolver is unavailable")
				const resolve = resolveBarrier
				resolveBarrier = undefined
				resolve()
			}
		},
	}
}

function createFixtureHost(taskId: string): FixtureHostState {
	const userMessageContent: Array<
		Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam | Anthropic.Messages.ToolResultBlockParam
	> = []
	const published: Anthropic.Messages.ToolResultBlockParam[] = []

	const host: ToolExecutionHost = {
		taskId,
		cwd: process.cwd(),
		abort: false,
		userMessageContent,
		userMessageContentReady: false,
		say: async () => undefined,
		recordToolUsage: () => undefined,
		pushToolResultToUserContent: (result) => {
			const alreadyPublished = userMessageContent.some(
				(block) => block.type === "tool_result" && block.tool_use_id === result.tool_use_id,
			)
			if (alreadyPublished) return false
			userMessageContent.push(result)
			published.push(result)
			return true
		},
	}

	return { host, published }
}

function createFixtureDescriptor(
	fixture: FixtureTool,
	gates: ReadonlyMap<string, CompletionGate>,
	completionOrder: string[],
	markStarted?: () => void,
): ToolDescriptor {
	return {
		name: fixture.name,
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: fixture.name,
				description: `Synthetic ${fixture.name} fixture`,
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		},
		// This fixture intentionally opts into the scheduler's selective-parallel
		// contract. It tests ordering and persistence only; it is not evidence
		// that a real handler is policy-eligible for parallel execution.
		capabilities: {
			concurrency: "parallel",
			sideEffects: "none",
			controlFlow: false,
			requiresApproval: false,
		},
		getConcurrencyScope: () => path.join(process.cwd(), "fixture-scopes", fixture.id),
		execute: async ({ call, callbacks }) => {
			const callId = call.id
			if (typeof callId !== "string" || callId.length === 0) throw new Error("Fixture call is missing an ID")
			const gate = gates.get(callId)
			if (!gate) throw new Error(`Missing completion gate for ${callId}`)
			markStarted?.()
			await gate.promise
			completionOrder.push(callId)
			callbacks.pushToolResult(
				JSON.stringify({
					status: fixture.status,
					fixture: fixture.name,
					callId,
				}),
			)
		},
	}
}

function createFixtureRegistry(
	fixtures: readonly FixtureTool[],
	gates: ReadonlyMap<string, CompletionGate>,
	completionOrder: string[],
	markStarted?: () => void,
): ToolRegistry {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	for (const fixture of fixtures) {
		registry.register(createFixtureDescriptor(fixture, gates, completionOrder, markStarted))
	}
	return registry
}

function createAgentToolCalls(fixtures: readonly FixtureTool[]): AgentToolCall[] {
	return fixtures.map((fixture) => ({
		type: "tool_call" as const,
		id: fixture.id,
		name: fixture.name,
		arguments: { fixture: fixture.id },
	}))
}

function createAssistantBoundary(fixtures: readonly FixtureTool[]): ApiMessage {
	const thinking: Anthropic.Messages.ThinkingBlockParam = {
		type: "thinking",
		thinking: "Synthetic reasoning retained across the transcript boundary.",
		signature: "synthetic-thinking-signature",
	}
	const toolUses: Anthropic.Messages.ToolUseBlockParam[] = fixtures.map((fixture) => ({
		type: "tool_use",
		id: fixture.id,
		name: fixture.name,
		input: { fixture: fixture.id },
	}))

	return {
		role: "assistant",
		id: "assistant-boundary",
		ts: 2_000,
		content: [thinking, ...toolUses],
		// These are deliberately synthetic placeholders, not credentials or
		// provider secrets. They model metadata that must survive compaction.
		reasoning_content: "synthetic-reasoning-content",
		encrypted_content: "synthetic-encrypted-content",
		reasoning_details: [{ type: "synthetic.reasoning", text: "synthetic detail" }],
	}
}

function createOlderHistory(): ApiMessage[] {
	// Each complete archived user/assistant step exceeds the 4,096-token tail budget,
	// while the full fixture fits the provider window. Only the recent transaction fits.
	return Array.from(
		{ length: 12 },
		(_, index): ApiMessage => ({
			role: index % 2 === 0 ? "user" : "assistant",
			id: `archived-${index}`,
			ts: index + 1,
			content: `${index % 2 === 0 ? "Archived user context" : "Archived assistant context"} ${"legacy transcript material that should be summarized before the latest transaction. ".repeat(
				120,
			)}`,
		}),
	)
}

function createInitialHistory(assistantBoundary: ApiMessage): { history: ApiMessage[]; recentConstraint: ApiMessage } {
	const recentConstraint: ApiMessage = {
		role: "user",
		id: "recent-constraint",
		ts: 1_000,
		content: RECENT_CONSTRAINT,
	}
	return {
		history: [...createOlderHistory(), recentConstraint, assistantBoundary],
		recentConstraint,
	}
}

function createSchedulerResultMessage(host: ToolExecutionHost): ApiMessage {
	const resultBlocks = host.userMessageContent.filter(
		(block): block is Anthropic.Messages.ToolResultBlockParam => block.type === "tool_result",
	)
	return {
		role: "user",
		id: "scheduler-results",
		ts: 2_001,
		content: resultBlocks,
	}
}

function getStructuredStatuses(message: ApiMessage): string[] {
	if (!Array.isArray(message.content)) return []
	return message.content
		.filter((block): block is Anthropic.Messages.ToolResultBlockParam => block.type === "tool_result")
		.map((block) => {
			if (typeof block.content !== "string") throw new Error("Fixture result must be serialized as text")
			const parsed: unknown = JSON.parse(block.content)
			if (!parsed || typeof parsed !== "object") throw new Error("Fixture result must be a JSON object")
			const status = (parsed as Record<string, unknown>).status
			if (typeof status !== "string") throw new Error("Fixture result must include a status")
			return status
		})
}

function releaseInReverseOrder(fixtures: readonly FixtureTool[], gates: ReadonlyMap<string, CompletionGate>): void {
	for (const fixture of [...fixtures].reverse()) {
		const gate = gates.get(fixture.id)
		if (!gate) throw new Error(`Missing completion gate for ${fixture.id}`)
		gate.resolve()
	}
}

class DeterministicSummaryProvider extends BaseProvider {
	readonly requests: Array<{
		systemPrompt: string
		messages: Anthropic.Messages.MessageParam[]
		metadata?: ApiHandlerCreateMessageMetadata
	}> = []

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		this.requests.push({ systemPrompt, messages, metadata })
		return this.createSummaryStream()
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "deterministic-summary-fixture",
			info: {
				contextWindow: 65_536,
				maxTokens: 4_096,
				supportsPromptCache: false,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Synthetic deterministic provider for transcript tests",
			},
		}
	}

	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		return content.reduce((total, block) => {
			const serialized = JSON.stringify(block) ?? ""
			return total + Math.max(1, Math.ceil(serialized.length / 4))
		}, 0)
	}

	private async *createSummaryStream(): ApiStream {
		yield { type: "text", text: "Deterministic summary of archived fixture context." }
		yield { type: "usage", inputTokens: 0, outputTokens: 8, totalCost: 0 }
	}
}

function makeSummaryOptions(
	messages: ApiMessage[],
	provider: DeterministicSummaryProvider,
): SummarizeConversationOptions {
	return {
		messages,
		apiHandler: provider,
		systemPrompt: SUMMARY_SYSTEM_PROMPT,
		taskId: TASK_ID,
		isAutomaticTrigger: false,
		metadata: { taskId: TASK_ID },
		recentTailTokenBudget: 4_096,
		maxContextTokens: 16_384,
	}
}

function assertRetainedTail(
	effective: ApiMessage[],
	recentConstraint: ApiMessage,
	assistantBoundary: ApiMessage,
	resultMessage: ApiMessage,
): void {
	expect(effective[0]?.isSummary).toBe(true)
	expect(effective.slice(1)).toEqual([recentConstraint, assistantBoundary, resultMessage])
	expect(effective[0]?.ts).toBeGreaterThan(0)
}

describe("Stage Two transcript boundary integration", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	})

	it("publishes a reverse-completing read batch in model order and retains the committed transaction", async () => {
		const storagePath = await fs.mkdtemp(
			await fs.realpath(os.tmpdir()).then((directory) => `${directory}/stage-two-`),
		)
		try {
			const fixtures: FixtureTool[] = [
				{ id: "read-a", name: "fixture_read_a", status: "success" },
				{ id: "read-b", name: "fixture_read_b", status: "error" },
				{ id: "read-c", name: "fixture_read_c", status: "success" },
			]
			const gates = new Map(fixtures.map((fixture) => [fixture.id, createCompletionGate()]))
			const completionOrder: string[] = []
			const started = createStartedBarrier(fixtures.length)
			const registry = createFixtureRegistry(fixtures, gates, completionOrder, started.markStarted)
			const { host, published } = createFixtureHost(TASK_ID)
			const provider = new DeterministicSummaryProvider()
			const assistantBoundary = createAssistantBoundary(fixtures)
			const { history, recentConstraint } = createInitialHistory(assistantBoundary)
			const store = new ProviderTranscriptStore(TASK_ID, storagePath, { now: () => COMMIT_TIME })

			const assistantReceipt = await store.commit(history)
			await store.verifyCommitReceipt(assistantReceipt)
			const outcomePromise = new ToolScheduler({
				executionHost: host,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				maxConcurrency: 3,
				validateCall: () => undefined,
				beforeEffect: async () => {
					await store.verifyCommitReceipt(assistantReceipt)
				},
			}).run(createAgentResponse(createAgentToolCalls(fixtures)))

			await started.promise
			releaseInReverseOrder(fixtures, gates)
			const outcome = await outcomePromise
			const resultMessage = createSchedulerResultMessage(host)

			expect(outcome.status).toBe("completed")
			expect(outcome.parallelToolCount).toBe(fixtures.length)
			expect(outcome.results.map((result) => [result.callId, result.status])).toEqual([
				["read-a", "success"],
				["read-b", "error"],
				["read-c", "success"],
			])
			expect(completionOrder).toEqual(["read-c", "read-b", "read-a"])
			expect(published.map((result) => result.tool_use_id)).toEqual(["read-a", "read-b", "read-c"])
			expect(new Set(published.map((result) => result.tool_use_id)).size).toBe(fixtures.length)
			expect(published).toHaveLength(fixtures.length)
			expect(getStructuredStatuses(resultMessage)).toEqual(["success", "error", "success"])

			const effectsHistory = [...history, resultMessage]
			const effectsReceipt = await store.commit({
				messages: effectsHistory,
				expectedRevision: assistantReceipt.revision,
			})
			await store.verifyCommitReceipt(effectsReceipt)

			const summaryResult = await summarizeConversation(makeSummaryOptions(effectsHistory, provider))
			expect(summaryResult.error).toBeUndefined()
			expect(summaryResult.summary).toContain("Deterministic summary")
			expect(summaryResult.messages.some((message) => message.isSummary)).toBe(true)

			const condensedReceipt = await store.commit({
				messages: summaryResult.messages,
				expectedRevision: effectsReceipt.revision,
			})
			await store.verifyCommitReceipt(condensedReceipt)

			const restartedStore = new ProviderTranscriptStore(TASK_ID, storagePath, { now: () => COMMIT_TIME })
			const reloaded = await restartedStore.read()
			await restartedStore.verifyCommitReceipt(condensedReceipt)
			expect(await restartedStore.hasCommitReceipt(condensedReceipt)).toBe(true)
			expect(reloaded.messages.find((message) => message.id === "archived-0")?.content).toEqual(
				history.find((message) => message.id === "archived-0")?.content,
			)
			expect(reloaded.messages.find((message) => message.id === "assistant-boundary")).toMatchObject({
				reasoning_content: "synthetic-reasoning-content",
				encrypted_content: "synthetic-encrypted-content",
				reasoning_details: [{ type: "synthetic.reasoning", text: "synthetic detail" }],
			})
			const reloadedAssistant = reloaded.messages.find((message) => message.id === "assistant-boundary")
			expect(reloadedAssistant?.content).toEqual(assistantBoundary.content)

			const effective = getEffectiveApiHistory(reloaded.messages)
			assertRetainedTail(effective, recentConstraint, assistantBoundary, resultMessage)
			expect(getStructuredStatuses(effective[3])).toEqual(["success", "error", "success"])
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("persists structured cancelled receipts through retained-tail compaction and reload", async () => {
		const storagePath = await fs.mkdtemp(
			await fs.realpath(os.tmpdir()).then((directory) => `${directory}/stage-two-`),
		)
		try {
			const fixtures: FixtureTool[] = [
				{ id: "cancel-a", name: "fixture_cancel_a", status: "cancelled" },
				{ id: "cancel-b", name: "fixture_cancel_b", status: "cancelled" },
			]
			const gates = new Map(fixtures.map((fixture) => [fixture.id, createCompletionGate()]))
			const completionOrder: string[] = []
			const started = createStartedBarrier(fixtures.length)
			const registry = createFixtureRegistry(fixtures, gates, completionOrder, started.markStarted)
			const { host, published } = createFixtureHost(`${TASK_ID}-cancelled`)
			const provider = new DeterministicSummaryProvider()
			const assistantBoundary = createAssistantBoundary(fixtures)
			const { history, recentConstraint } = createInitialHistory(assistantBoundary)
			const taskId = `${TASK_ID}-cancelled`
			const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => COMMIT_TIME })
			const assistantReceipt = await store.commit(history)
			await store.verifyCommitReceipt(assistantReceipt)
			const controller = new AbortController()

			const outcomePromise = new ToolScheduler({
				executionHost: host,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				maxConcurrency: 2,
				validateCall: () => undefined,
				signal: controller.signal,
				preserveAbortedResults: true,
				beforeEffect: async () => {
					await store.verifyCommitReceipt(assistantReceipt)
				},
			}).run(createAgentResponse(createAgentToolCalls(fixtures)))

			await started.promise
			controller.abort()
			releaseInReverseOrder(fixtures, gates)
			const outcome = await outcomePromise
			const resultMessage = createSchedulerResultMessage(host)
			const executionCount = completionOrder.length

			expect(outcome.status).toBe("aborted")
			expect(outcome.parallelToolCount).toBe(fixtures.length)
			expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
			expect(completionOrder).toEqual(["cancel-b", "cancel-a"])
			expect(published.map((result) => result.tool_use_id)).toEqual(["cancel-a", "cancel-b"])
			expect(published.every((result) => result.is_error === true)).toBe(true)
			expect(getStructuredStatuses(resultMessage)).toEqual(["cancelled", "cancelled"])

			const effectsHistory = [...history, resultMessage]
			const effectsReceipt = await store.commit({
				messages: effectsHistory,
				expectedRevision: assistantReceipt.revision,
			})
			await store.verifyCommitReceipt(effectsReceipt)
			const summaryResult = await summarizeConversation({
				...makeSummaryOptions(effectsHistory, provider),
				taskId,
				metadata: { taskId },
			})
			expect(summaryResult.error).toBeUndefined()

			const condensedReceipt = await store.commit({
				messages: summaryResult.messages,
				expectedRevision: effectsReceipt.revision,
			})
			await store.verifyCommitReceipt(condensedReceipt)

			const restartedStore = new ProviderTranscriptStore(taskId, storagePath, { now: () => COMMIT_TIME })
			const reloaded = await restartedStore.read()
			const effective = getEffectiveApiHistory(reloaded.messages)
			assertRetainedTail(effective, recentConstraint, assistantBoundary, resultMessage)
			expect(getStructuredStatuses(effective[3])).toEqual(["cancelled", "cancelled"])
			expect(executionCount).toBe(fixtures.length)
			expect(completionOrder).toHaveLength(executionCount)
			expect(await restartedStore.hasCommitReceipt(condensedReceipt)).toBe(true)
			expect((await restartedStore.read()).messages).toEqual(reloaded.messages)
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})
