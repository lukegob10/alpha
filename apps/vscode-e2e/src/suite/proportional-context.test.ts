import * as assert from "assert"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { RooCodeEventName, type RooCodeSettings } from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"
import {
	createCompletionReviewAcknowledger,
	parseContextRunMetadata,
	withFixtureCleanup,
} from "./proportional-context-support"

type Scenario = "conversation" | "known-file-lookup"
type ScriptChunk = { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; arguments: string }

interface RequestMeasurement {
	systemPromptBytes: number
	messageJsonBytes: number
	toolSchemaJsonBytes: number
	environmentTextBytes: number
	environmentBlocks: number
	environmentDigests: string[]
	toolResultBlocks: number
}

interface ScriptRuntime {
	requests: RequestMeasurement[]
	emittedToolCalls: string[]
	answer?: string
	evidenceObserved: boolean
	completionReviewAcknowledgements: number
	removeFromCache?: () => void
}

// Keep measurements outside the FakeAI configuration serialized by the host.
const runtimes = new WeakMap<object, ScriptRuntime>()
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
const contentBlocks = (messages: unknown[]): Record<string, unknown>[] =>
	messages.flatMap((message) => {
		const content = record(message)?.content
		return Array.isArray(content) ? content.flatMap((block) => (record(block) ? [record(block)!] : [])) : []
	})

class ProportionalContextScriptedAI {
	readonly id: string

	constructor(
		private readonly scenario: Scenario,
		private readonly fixtureName: string,
		sample: number,
	) {
		this.id = `proportional-context-${scenario}-${sample}`
		runtimes.set(this, {
			requests: [],
			emittedToolCalls: [],
			evidenceObserved: false,
			completionReviewAcknowledgements: 0,
		})
	}

	get removeFromCache(): (() => void) | undefined {
		return runtimes.get(this)?.removeFromCache
	}

	set removeFromCache(value: (() => void) | undefined) {
		runtimes.get(this)!.removeFromCache = value
	}

	async *createMessage(
		systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; tools?: unknown[] },
	): AsyncGenerator<ScriptChunk> {
		assert.ok(metadata?.taskId, "The actual Task request must have an owning task ID")
		assert.ok(Array.isArray(metadata.tools), "The actual Task request must expose its tool schemas")
		const runtime = runtimes.get(this)!
		const blocks = contentBlocks(messages)
		const environment = blocks.flatMap((block) =>
			block.type === "text" &&
			typeof block.text === "string" &&
			block.text.trim().startsWith("<environment_details>") &&
			block.text.trim().endsWith("</environment_details>")
				? [block.text]
				: [],
		)
		runtime.requests.push({
			systemPromptBytes: Buffer.byteLength(systemPrompt),
			messageJsonBytes: Buffer.byteLength(JSON.stringify(messages)),
			toolSchemaJsonBytes: Buffer.byteLength(JSON.stringify(metadata.tools)),
			environmentTextBytes: environment.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
			environmentBlocks: environment.length,
			environmentDigests: environment.map(digest),
			toolResultBlocks: blocks.filter((block) => block.type === "tool_result").length,
		})

		const turn = runtime.requests.length
		if (this.scenario === "known-file-lookup" && turn === 1) {
			assert.ok(metadata.tools.some((tool) => record(record(tool)?.function)?.name === "read_file"))
			runtime.emittedToolCalls.push("read_file")
			yield {
				type: "tool_call",
				id: `${this.id}-read`,
				name: "read_file",
				arguments: JSON.stringify({ path: this.fixtureName, offset: 2, limit: 1 }),
			}
			return
		}

		assert.equal(turn, this.scenario === "conversation" ? 1 : 2, "Unexpected model continuation")
		if (this.scenario === "known-file-lookup") {
			const result = blocks.find(
				(block) => block.type === "tool_result" && block.tool_use_id === `${this.id}-read`,
			)
			assert.ok(result, "The real read_file result must reach the next provider request")
			assert.notEqual(result.is_error, true)
			const evidence = typeof result.content === "string" ? result.content : JSON.stringify(result.content)
			assert.ok(evidence)
			const answer = /answer=(\d+)/.exec(evidence)?.[1]
			assert.equal(answer, "42")
			assert.ok(!evidence.includes("unrequested-sentinel"), "A scoped lookup must not return unrelated lines")
			runtime.evidenceObserved = true
			runtime.answer = `The configured answer is ${answer}.`
		} else {
			runtime.answer = "Hello."
		}
		yield { type: "text", text: runtime.answer }
	}

	getModel() {
		return {
			id: "proportional-context-scripted",
			info: { contextWindow: 128_000, maxTokens: 8192, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(): Promise<number> {
		// Only keep the offline fixture below compaction thresholds; this is not measured token usage.
		return 1
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

interface ContextHostProvider {
	getLiveTask(taskId: string):
		| {
				didComplete?: boolean
				abort?: boolean
				taskAsk?: { ask?: string }
				approveAsk(): void
				clineMessages?: Array<{ say?: string; text?: string; partial?: boolean }>
		  }
		| undefined
}

suite("Alpha proportional context request measurements", function () {
	setDefaultSuiteTimeout(this)
	let hostSampleIndex = 0

	for (const scenario of ["conversation", "known-file-lookup"] as const) {
		test(`${scenario} uses the actual Task request path with bounded scripted work`, async () => {
			assert.equal(vscode.version, "1.122.1", "Request evidence must use the exact reference host")
			const provenance = parseContextRunMetadata(process.env.ALPHA_SCOPE_RUN_METADATA)
			const provider = (globalThis.api as unknown as { sidebarProvider?: ContextHostProvider }).sidebarProvider
			assert.ok(provider)
			const workspace = process.env.ALPHA_E2E_WORKSPACE
			assert.ok(workspace, "The E2E runner must supply its isolated workspace")
			const fixtureName = "nor-36-context-fixture.txt"
			const fixturePath = path.join(workspace, fixtureName)
			const originalConfiguration = globalThis.api.getConfiguration()
			await fs.writeFile(fixturePath, "label=NOR-36\nanswer=42\nunrequested-sentinel\n", { flag: "wx" })
			const observations = await withFixtureCleanup(async () => {
				const observations: Array<ScriptRuntime & { scenarioSampleIndex: number; hostSampleIndex: number }> = []
				for (let sample = 0; sample < 3; sample++) {
					const currentHostSampleIndex = hostSampleIndex++
					const scripted = new ProportionalContextScriptedAI(scenario, fixtureName, sample)
					const acknowledgeCompletionReview = createCompletionReviewAcknowledger()
					const completed = new Set<string>()
					const onCompleted = (taskId: string) => completed.add(taskId)
					globalThis.api.on(RooCodeEventName.TaskCompleted, onCompleted)
					await withFixtureCleanup(async () => {
						const configuration: RooCodeSettings = {
							...originalConfiguration,
							apiProvider: "fake-ai",
							fakeAi: scripted,
							mode: "ask",
							autoApprovalEnabled: true,
							alwaysAllowReadOnly: true,
							requestDelaySeconds: 0,
							writeDelayMs: 0,
							enableCheckpoints: false,
							includeCurrentTime: false,
							includeCurrentCost: false,
						}
						const taskId = await globalThis.api.startNewTask({
							configuration,
							text:
								scenario === "conversation"
									? "Reply with Hello. No workspace investigation is needed."
									: `Read line 2 of ${fixtureName} and report the configured answer.`,
						})
						const runtime = runtimes.get(scripted)!
						await waitFor(
							() => {
								if (completed.has(taskId)) return true
								if (acknowledgeCompletionReview(provider.getLiveTask(taskId)))
									runtime.completionReviewAcknowledgements++
								return false
							},
							{
								timeout: 30_000,
								description: `${scenario} ordinary-text completion`,
								onTimeout: () => ({
									requests: runtime.requests,
									emittedToolCalls: runtime.emittedToolCalls,
									didComplete: provider.getLiveTask(taskId)?.didComplete,
									abort: provider.getLiveTask(taskId)?.abort,
									ask: provider.getLiveTask(taskId)?.taskAsk?.ask,
								}),
							},
						)
						assert.equal(runtime.requests.length, scenario === "conversation" ? 1 : 2)
						assert.deepStrictEqual(
							runtime.emittedToolCalls,
							scenario === "conversation" ? [] : ["read_file"],
						)
						assert.equal(runtime.evidenceObserved, scenario === "known-file-lookup")
						assert.ok(
							provider
								.getLiveTask(taskId)
								?.clineMessages?.some(
									(message) =>
										(message.say === "text" || message.say === "completion_result") &&
										!message.partial &&
										message.text === runtime.answer,
								),
							"The final answer must be visible in the actual task transcript",
						)
						const first = runtime.requests[0]
						assert.ok(first)
						assert.equal(first.environmentBlocks, 1)
						if (scenario === "known-file-lookup") {
							const second = runtime.requests[1]
							assert.ok(second)
							assert.equal(second.toolResultBlocks, 1)
							assert.deepStrictEqual(second.environmentDigests, first.environmentDigests)
						}
						observations.push({
							...runtime,
							removeFromCache: undefined,
							scenarioSampleIndex: sample,
							hostSampleIndex: currentHostSampleIndex,
						})
					}, [
						() => globalThis.api.off(RooCodeEventName.TaskCompleted, onCompleted),
						() => globalThis.api.clearCurrentTask(),
						() => scripted.removeFromCache?.(),
					])
				}
				return observations
			}, [() => globalThis.api.setConfiguration(originalConfiguration), () => fs.unlink(fixturePath)])
			console.log(
				JSON.stringify({
					benchmark: "proportional-context-real-task",
					scenario,
					vscode: vscode.version,
					samples: observations.length,
					provenance,
					provider: "scripted fake-ai; fixed decisions",
					providerTokens: null,
					tokenAvailability: "Scripted provider has no measured provider/tokenizer usage",
					byteAttribution:
						"UTF-8 system text, JSON messages/schemas; environment text is a subset of messages",
					observations,
				}),
			)
		})
	}
})
