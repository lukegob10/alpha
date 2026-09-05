import * as assert from "assert"
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import {
	RooCodeEventName,
	type ParentVerificationObligation,
	type RooCodeSettings,
	type TokenUsage,
} from "@alpha-code/types"

import {
	createCompletionReviewAcknowledger,
	parseContextRunMetadata,
	withBoundedFixtureCleanup,
	withFixtureCleanup,
} from "./proportional-context-support"
import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const INPUT =
	"This workspace needs no changes. An existing verification operation is already in progress; finish once its terminal receipt is durable. Do not start another command."
const ANSWER = "No further workspace changes are needed."
const COMMAND_ID = "nor-36-existing-check"
const EXECUTION_ID = "nor-36-controlled-terminal"
const RECEIPT_ID = "nor-36-no-op-receipt"
const policyDigest = createHash("sha256")
	.update(
		JSON.stringify({
			input: INPUT,
			answer: ANSWER,
			commandDelayMs: 1000,
			publicationDelayMs: 1500,
			maxRequests: 2,
			recoveryPolicy: "Await the original settlement, then emit the identical answer without tools",
			uiPolicy: "Acknowledge the on-screen completion_result review once; never approve recovery or tools",
		}),
	)
	.digest("hex")

type Scenario = "command-publication" | "no-op-receipt"
type GateDecision = { allowed: boolean; blockingObligations?: ParentVerificationObligation[] }
interface CompletionMetrics {
	candidateCount: number
	rejectionCount: number
	repairToolCount: number
	runtimeWaitMs: number
	firstCandidateAt?: number
	persistenceSettledAt?: number
	completedAt?: number
	blockedAt?: number
	firstCandidateUsage?: TokenUsage
	settledUsage?: TokenUsage
}
interface CompletionTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: { ask?: string }
	approveAsk(): void
	clineMessages: Array<{ ask?: string; say?: string; text?: string; partial?: boolean }>
	getCompletionGateDecision(): Promise<GateDecision>
	getCompletionStageMetrics?: () => CompletionMetrics
	beginCommandExecution(callId: string, executionId: string, command: string): void
	completeCommandExecution(callId: string, details: { exitCode: number }, executionId: string): void
	getCommandExecutionEvidence(): Array<{ toolCallId: string; executionId: string; status: string; exitCode?: number }>
	flushApiConversationHistoryPersistence(): Promise<void>
	waitForTermination(): Promise<void>
}
interface CompletionProvider {
	getLiveTask(taskId: string): CompletionTask | undefined
	recordParentVerificationEvidence(task: CompletionTask): Promise<void>
	reservePrimaryMutation(task: CompletionTask, token: string): Promise<void>
	releasePrimaryMutation(task: CompletionTask, token: string): Promise<void>
	agentControlStore: {
		getVerificationObligations(filter: { parentTaskId: string }): ParentVerificationObligation[]
		getAgent(taskId: string, rootTaskId: string): { status: string } | undefined
	}
}

function barrier() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

// Restoring the original descriptor avoids leaving an own method on prototype-backed objects.
function replaceMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key)
	Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement })
	return () => {
		if (descriptor) Object.defineProperty(target, key, descriptor)
		else Reflect.deleteProperty(target, key)
	}
}

interface RequestBytes {
	systemPromptBytes: number
	messageJsonBytes: number
	toolSchemaJsonBytes: number
	assistantTextBytes: number
}

class SettlementObservation {
	readonly requests: RequestBytes[] = []
	readonly releaseCommand = barrier()
	readonly releasePublication = barrier()
	readonly settlement = barrier()
	readonly timers = new Set<ReturnType<typeof setTimeout>>()
	readonly restores: Array<() => void> = []
	readonly failures: unknown[] = []
	operation?: Promise<void>
	publication?: Promise<void>
	task?: CompletionTask
	firstGateAt?: number
	settledAt?: number
	completedAt?: number
	completedEvents = 0
	completionReviewAcknowledgements = 0
	allowedGateObserved = false
	reservationCreated = false
	removeFromCache?: () => void

	constructor(
		readonly provider: CompletionProvider,
		readonly scenario: Scenario,
	) {}

	recordFailure(error: unknown) {
		this.failures.push(error)
		this.settlement.resolve()
	}

	assertHealthy() {
		if (this.failures.length) throw new AggregateError(this.failures, "Completion fixture observation failed")
	}

	async seed(task: CompletionTask) {
		this.task = task
		const originalGate = task.getCompletionGateDecision
		this.restores.push(
			replaceMethod(task, "getCompletionGateDecision", async () => {
				try {
					const decision = await originalGate.call(task)
					this.allowedGateObserved ||= decision.allowed
					if (this.firstGateAt === undefined) {
						assert.equal(decision.allowed, false, "An active operation must reject the first candidate")
						assert.equal(task.didComplete, false)
						if (this.scenario === "no-op-receipt") {
							assert.ok(
								decision.blockingObligations?.some(
									(item) =>
										item.changedFiles.length === 0 &&
										item.mutationReservations?.includes(RECEIPT_ID),
								),
							)
						}
						this.firstGateAt = Date.now()
						this.armSettlement()
					}
					return decision
				} catch (error) {
					this.recordFailure(error)
					throw error
				}
			}),
		)
		if (this.scenario === "no-op-receipt") {
			await this.provider.reservePrimaryMutation(task, RECEIPT_ID)
			this.reservationCreated = true
		} else {
			const originalPublish = this.provider.recordParentVerificationEvidence
			this.restores.push(
				replaceMethod(this.provider, "recordParentVerificationEvidence", async (owner) => {
					if (owner !== task || this.settledAt !== undefined)
						return originalPublish.call(this.provider, owner)
					this.publication ??= (async () => {
						await this.releasePublication.promise
						await originalPublish.call(this.provider, owner)
						this.markSettled()
					})().catch((error: unknown) => {
						this.recordFailure(error)
						throw error
					})
					await this.publication
				}),
			)
			task.beginCommandExecution(COMMAND_ID, EXECUTION_ID, "pnpm exec vitest run")
		}
	}

	private armSettlement() {
		const schedule = (milliseconds: number, release: () => void) => {
			const timer = setTimeout(() => {
				this.timers.delete(timer)
				release()
			}, milliseconds)
			this.timers.add(timer)
		}
		schedule(1000, this.releaseCommand.resolve)
		if (this.scenario === "command-publication") schedule(1500, this.releasePublication.resolve)
		this.operation = (async () => {
			await this.releaseCommand.promise
			assert.equal(this.task!.didComplete, false, "Completion must wait for the existing operation")
			if (this.scenario === "no-op-receipt") {
				await this.provider.releasePrimaryMutation(this.task!, RECEIPT_ID)
				this.reservationCreated = false
				this.markSettled()
			} else {
				this.task!.completeCommandExecution(COMMAND_ID, { exitCode: 0 }, EXECUTION_ID)
			}
		})().catch((error: unknown) => this.recordFailure(error))
	}

	private markSettled() {
		assert.equal(this.task!.didComplete, false, "The durable receipt must precede completion")
		this.settledAt = Date.now()
		this.settlement.resolve()
	}

	async cleanup(cancelTask: () => Promise<unknown>) {
		for (const timer of this.timers) clearTimeout(timer)
		this.timers.clear()
		this.releaseCommand.resolve()
		this.releasePublication.resolve()
		await withBoundedFixtureCleanup(
			async () => undefined,
			[
				cancelTask,
				...this.restores.reverse(),
				async () => {
					await this.operation
					await this.publication
				},
				async () => {
					if (this.reservationCreated) await this.provider.releasePrimaryMutation(this.task!, RECEIPT_ID)
				},
				() => this.assertHealthy(),
			],
		)
	}
}

// Runtime state stays outside the FakeAI configuration that the host serializes.
const observations = new WeakMap<object, SettlementObservation>()
class CompletionScriptedAI {
	readonly id: string
	constructor(observation: SettlementObservation, sample: number) {
		this.id = `proportional-completion-${observation.scenario}-${sample}`
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(system: string, messages: unknown[], metadata?: { taskId?: string; tools?: unknown[] }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		assert.ok(Array.isArray(metadata.tools))
		observation.requests.push({
			systemPromptBytes: Buffer.byteLength(system),
			messageJsonBytes: Buffer.byteLength(JSON.stringify(messages)),
			toolSchemaJsonBytes: Buffer.byteLength(JSON.stringify(metadata.tools)),
			assistantTextBytes: Buffer.byteLength(ANSWER),
		})
		assert.ok(observation.requests.length <= 2, "Unexpected third provider request")
		if (observation.requests.length === 1) {
			const task = observation.provider.getLiveTask(metadata.taskId)
			assert.ok(task)
			await observation.seed(task)
		} else {
			await observation.settlement.promise
			observation.assertHealthy()
		}
		yield { type: "text" as const, text: ANSWER }
	}
	getModel() {
		return {
			id: "proportional-completion-scripted",
			info: { contextWindow: 128_000, maxTokens: 8192, supportsImages: false, supportsPromptCache: false },
		}
	}
	async countTokens() {
		// Fixture compaction guard, not a tokenizer measurement or provider usage.
		return 1
	}
	async completePrompt() {
		return ""
	}
}

suite("Alpha proportional completion settlement measurements", function () {
	setDefaultSuiteTimeout(this)
	let hostSampleIndex = 0
	for (const scenario of ["command-publication", "no-op-receipt"] as const) {
		test(`${scenario} preserves the same conditional provider policy across revisions`, async () => {
			assert.equal(vscode.version, "1.122.1")
			const provenance = parseContextRunMetadata(process.env.ALPHA_SCOPE_RUN_METADATA)
			const expectation = process.env.ALPHA_COMPLETION_EXPECTATION
			assert.ok(expectation === "reference" || expectation === "candidate", "Declare the assertion role")
			const fixtureDigest = createHash("sha256")
				.update(await fs.readFile(__filename))
				.update(await fs.readFile(path.join(__dirname, "proportional-context-support.js")))
				.digest("hex")
			const provider = (globalThis.api as unknown as { sidebarProvider?: CompletionProvider }).sidebarProvider
			assert.ok(provider)
			const originalConfiguration = globalThis.api.getConfiguration()
			const reports = await withBoundedFixtureCleanup(async () => {
				const reports = []
				for (let sample = 0; sample < 3; sample++) {
					const observation = new SettlementObservation(provider, scenario)
					const acknowledgeCompletionReview = createCompletionReviewAcknowledger()
					const scripted = new CompletionScriptedAI(observation, sample)
					const onCompleted = (taskId: string) => {
						if (observation.task?.taskId !== taskId) return
						observation.completedEvents++
						if (observation.completedEvents > 1)
							observation.recordFailure(new Error("Duplicate completion event"))
						observation.completedAt = Date.now()
						if (observation.settledAt === undefined)
							observation.recordFailure(new Error("Premature completion"))
					}
					globalThis.api.on(RooCodeEventName.TaskCompleted, onCompleted)
					const report = await withFixtureCleanup(async () => {
						const configuration: RooCodeSettings = {
							...originalConfiguration,
							apiProvider: "fake-ai",
							fakeAi: scripted,
							mode: "ask",
							autoApprovalEnabled: true,
							requestDelaySeconds: 0,
							writeDelayMs: 0,
							enableCheckpoints: false,
							includeCurrentTime: false,
							includeCurrentCost: false,
						}
						await globalThis.api.startNewTask({ configuration, text: INPUT })
						await waitFor(
							() => {
								if (observation.completedEvents > 0 || observation.failures.length > 0) return true
								if (
									observation.task?.taskAsk?.ask === "completion_result" &&
									observation.settledAt === undefined
								) {
									observation.recordFailure(
										new Error("Completion review appeared before durable settlement"),
									)
									return true
								}
								if (acknowledgeCompletionReview(observation.task))
									observation.completionReviewAcknowledgements++
								return false
							},
							{
								timeout: 30_000,
								description: `${scenario} durable ordinary-text completion`,
								onTimeout: () => ({
									modelRequests: observation.requests.length,
									firstGateObserved: observation.firstGateAt !== undefined,
									durableSettlementObserved: observation.settledAt !== undefined,
									completionEvents: observation.completedEvents,
									completionReviewAcknowledgements: observation.completionReviewAcknowledgements,
									didComplete: observation.task?.didComplete,
									abort: observation.task?.abort,
									atCompletionReview: observation.task?.taskAsk?.ask === "completion_result",
									atRecoveryBoundary: observation.task?.taskAsk?.ask === "resume_task",
								}),
							},
						)
						observation.assertHealthy()
						const task = observation.task!
						await waitFor(
							async () => {
								await task.waitForTermination()
								return true
							},
							{
								timeout: 30_000,
								description: `${scenario} Task-owned lifecycle settlement`,
								onTimeout: () => ({
									didComplete: task.didComplete,
									abort: task.abort,
									completionEvents: observation.completedEvents,
								}),
							},
						)
						await task.flushApiConversationHistoryPersistence()
						assert.equal(task.didComplete, true)
						assert.equal(task.abort, false)
						assert.equal(observation.completedEvents, 1)
						assert.equal(observation.allowedGateObserved, true)
						assert.ok(observation.firstGateAt !== undefined && observation.settledAt !== undefined)
						assert.equal(
							provider.agentControlStore.getAgent(task.taskId, task.taskId)?.status,
							"completed",
							JSON.stringify({
								stage: "durable root after Task-owned lifecycle join",
								modelRequests: observation.requests.length,
								completionEvents: observation.completedEvents,
								completionReviewAcknowledgements: observation.completionReviewAcknowledgements,
								durableSettlementObserved: observation.settledAt !== undefined,
							}),
						)
						assert.ok(
							task.clineMessages.some(
								(message) =>
									(message.say === "text" || message.say === "completion_result") &&
									!message.partial &&
									message.text === ANSWER,
							),
						)
						assert.ok(!task.clineMessages.some((message) => message.ask === "resume_task"))
						assert.ok(
							!provider.agentControlStore
								.getVerificationObligations({ parentTaskId: task.taskId })
								.some(
									(item) =>
										item.mutationReservations?.includes(RECEIPT_ID) || item.changedFiles.length > 0,
								),
						)
						const evidence = task.getCommandExecutionEvidence()
						if (scenario === "command-publication") {
							assert.equal(evidence.length, 1)
							const command = evidence[0]
							assert.ok(command)
							assert.deepStrictEqual(
								{
									id: command.toolCallId,
									execution: command.executionId,
									status: command.status,
									exitCode: command.exitCode,
								},
								{ id: COMMAND_ID, execution: EXECUTION_ID, status: "succeeded", exitCode: 0 },
							)
						} else assert.equal(evidence.length, 0)
						const metrics = task.getCompletionStageMetrics?.()
						if (expectation === "candidate") {
							assert.equal(observation.requests.length, 1)
							assert.ok(metrics)
							assert.equal(metrics.candidateCount, 1)
							assert.equal(metrics.rejectionCount, 0)
							assert.equal(metrics.repairToolCount, 0)
							assert.ok(metrics.runtimeWaitMs > 0)
							assert.ok(metrics.firstCandidateAt! <= metrics.persistenceSettledAt!)
							assert.ok(metrics.persistenceSettledAt! <= metrics.completedAt!)
						}
						return {
							scenarioSampleIndex: sample,
							hostSampleIndex: hostSampleIndex++,
							quality: "passed",
							outcome: "completed",
							requests: observation.requests,
							modelRequests: observation.requests.length,
							recoveryRequests: observation.requests.length - 1,
							emittedToolCalls: 0,
							physicalCommandLaunches: 0,
							commandEvidenceRegistrations: evidence.length,
							completionEvents: observation.completedEvents,
							completionReviewAcknowledgements: observation.completionReviewAcknowledgements,
							firstGateToCompletedMs: observation.completedAt! - observation.firstGateAt,
							completionStage: metrics
								? {
										candidateCount: metrics.candidateCount,
										rejectionCount: metrics.rejectionCount,
										repairToolCount: metrics.repairToolCount,
										runtimeWaitMs: metrics.runtimeWaitMs,
										firstCandidateAt: metrics.firstCandidateAt,
										persistenceSettledAt: metrics.persistenceSettledAt,
										completedAt: metrics.completedAt,
									}
								: null,
						}
					}, [
						() => observation.cleanup(() => globalThis.api.clearCurrentTask()),
						() => globalThis.api.off(RooCodeEventName.TaskCompleted, onCompleted),
						() => scripted.removeFromCache?.(),
					])
					reports.push(report)
				}
				return reports
			}, [() => globalThis.api.setConfiguration(originalConfiguration)])
			console.log(
				JSON.stringify({
					benchmark: "proportional-completion-real-task",
					scenario,
					expectation,
					provenance,
					fixtureDigest,
					policyDigest,
					provider: "scripted fake-ai; fixed conditional policy",
					providerTokens: null,
					tokenAvailability: "No measured provider usage; Task usage snapshots are not token evidence",
					timing: "diagnostic host time with controlled 1000/1500 ms waits; no latency improvement claim",
					observations: reports,
				}),
			)
		})
	}
})
