import { strict as assert } from "node:assert"
import * as vscode from "vscode"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"

import type { AlphaMessage } from "@alpha-code/types"

import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

interface NavigationTask {
	abort: boolean
	didComplete: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	waitForTermination(): Promise<void>
	overwriteAlphaMessages(messages: AlphaMessage[]): Promise<void>
}

interface NavigationHost {
	getActiveTaskId(): string | undefined
	getLiveTask(taskId: string): NavigationTask | undefined
	taskHistoryStore: {
		get(taskId: string): { id: string; task?: string; ts?: number } | undefined
		getAll(): Array<{ id: string; task?: string; ts?: number }>
	}
	postStateToWebview(): Promise<void>
}

class NavigationProbeAI {
	readonly id = "navigation-ui-probe"
	removeFromCache?: () => void
	requests = 0

	async *createMessage() {
		const request = this.requests++
		if (request < 12) {
			yield {
				type: "tool_call" as const,
				id: `navigation-ui-command-${request}`,
				name: "exec_command",
				arguments: JSON.stringify({
					cmd: `node -e "console.log('navigation fixture step ${request + 1} completed')"`,
					yield_time_ms: 10_000,
				}),
			}
			return
		}
		assert.equal(request, 12, "The navigation fixture must not need retries")
		yield { type: "text" as const, text: "The multi-step navigation fixture is complete." }
	}

	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}

	async countTokens() {
		return 1
	}

	async completePrompt() {
		return ""
	}
}

const TRANSCRIPT_MESSAGES = 1_200
const TRANSCRIPT_SENTINEL = "task-navigation-ui-transcript-sentinel"
const CYCLES = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const

suite("Task navigation renderer latency", function () {
	this.timeout(240_000)

	test("persists across a cold process launch and reuses one Task through warm UI cycles", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(vscode.version, process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION ?? "1.122.1")
		assert.ok(process.env.ALPHA_UI_ACCEPTANCE_NONCE)
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(artifactsDir)
		const phase = process.env.ALPHA_TASK_NAVIGATION_UI_PHASE
		assert.ok(phase === "seed" || phase === "reopen")
		const api = globalThis.api
		const originalConfiguration = api.getConfiguration()
		const host = (api as unknown as { sidebarProvider: NavigationHost }).sidebarProvider
		assert.ok(host)

		if (phase === "seed") {
			const scripted = new NavigationProbeAI()
			try {
				const taskId = await api.startNewTask({
					text: "Run the twelve-step navigation fixture and report completion.",
					configuration: {
						...originalConfiguration,
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						approvalMode: "auto",
						allowedCommands: ["*"],
						deniedCommands: [],
						terminalShellIntegrationDisabled: true,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
					},
				})
				await waitFor(() => host.getLiveTask(taskId)?.taskAsk?.ask === "completion_result", {
					description: "the completed task's review boundary",
					timeout: 120_000,
				})
				const task = host.getLiveTask(taskId)
				assert.ok(task)
				assert.equal(task.abort, false)
				assert.equal(scripted.requests, 13)
				const syntheticMessages: AlphaMessage[] = Array.from({ length: TRANSCRIPT_MESSAGES }, (_, index) => ({
					type: "say",
					say: "text",
					ts: Date.now() + index + 1,
					text:
						index === TRANSCRIPT_MESSAGES - 1
							? TRANSCRIPT_SENTINEL
							: `Persisted navigation row ${String(index).padStart(4, "0")}. This message is part of the bounded renderer workload.`,
					partial: false,
				}))
				await task.overwriteAlphaMessages([...task.clineMessages, ...syntheticMessages])
				await host.postStateToWebview()

				const commandStartedAt = performance.now()
				await vscode.commands.executeCommand("alpha.plusButtonClicked")
				const newChatCommandReturnMs = performance.now() - commandStartedAt
				await waitFor(() => task.didComplete, {
					description: "completion accepted before the process-cold reopen",
					timeout: 10_000,
				})
				await task.waitForTermination()
				await api.clearCurrentTask()
				assert.equal(host.getLiveTask(taskId), undefined, "Seed process must dispose the task before shutdown")
				assert.equal(host.getActiveTaskId(), undefined)
				const persistedTask = host.taskHistoryStore.get(taskId)
				assert.equal(persistedTask?.id, taskId, "The completed task must be in persisted history")
				assert.ok(persistedTask?.task, "The completed task must have a history title")

				await uiFixtureBarrier("seeded", {
					version: vscode.version,
					taskId,
					requestCount: scripted.requests,
					persistedMessageCount: task.clineMessages.length,
					syntheticMessageCount: TRANSCRIPT_MESSAGES,
					sentinel: TRANSCRIPT_SENTINEL,
					newChatCommandReturnMs,
					seedProcessPid: process.pid,
					seedProcessUptimeMs: Math.round(process.uptime() * 1000),
				})
			} finally {
				await api.clearCurrentTask().catch(() => undefined)
				scripted.removeFromCache?.()
				await api.setConfiguration(originalConfiguration)
			}
			return
		}

		const taskId = process.env.ALPHA_TASK_NAVIGATION_UI_TASK_ID
		assert.ok(taskId && /^[a-zA-Z0-9-]+$/.test(taskId))
		assert.equal(host.getLiveTask(taskId), undefined, "A new Code process must start without the Task in memory")
		assert.equal(host.getActiveTaskId(), undefined)
		const taskHistory = host.taskHistoryStore.getAll()
		const projectedTaskHistory = taskHistory.filter((item) => item.ts && item.task)
		assert.ok(
			projectedTaskHistory.some((item) => item.id === taskId),
			"The fresh host must project the persisted task into history",
		)
		const loopDelay = monitorEventLoopDelay({ resolution: 10 })
		loopDelay.enable()
		const processStartedAtEpochMs = Date.now() - process.uptime() * 1000
		const cpuStarted = process.cpuUsage()
		const memoryStarted = process.memoryUsage()
		const warmHostObservations: Array<{
			cycle: string
			newChatObservedAtEpochMs: number
			taskOpenObservedAtEpochMs: number
			cpuUserDeltaUs: number
			cpuSystemDeltaUs: number
			rssBytes: number
			heapUsedBytes: number
		}> = []
		let priorCycleCpu = process.cpuUsage()
		let coldOpenObservedAtEpochMs = 0
		try {
			// A fresh profile otherwise stays on provider onboarding, which hides the chat-history preview.
			await api.setConfiguration({
				...originalConfiguration,
				apiProvider: "openai",
				openAiApiKey: "local-fixture",
				openAiModelId: "fixture",
			})
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			await host.postStateToWebview()
			await uiFixtureBarrier("cold-open", {
				version: vscode.version,
				taskId,
				taskHistoryCount: projectedTaskHistory.length,
				taskHistoryContainsTask: true,
				extensionHostPid: process.pid,
				extensionHostUptimeMs: Math.round(process.uptime() * 1000),
				processStartedAtEpochMs: Math.round(processStartedAtEpochMs),
			})
			coldOpenObservedAtEpochMs = Date.now()
			const reopenedTask = host.getLiveTask(taskId)
			assert.ok(reopenedTask, "Cold UI open must rehydrate a Task")
			assert.equal(host.getActiveTaskId(), taskId)
			assert.ok(
				reopenedTask.clineMessages.filter((message) => message.type === "say" && message.say === "text")
					.length >= TRANSCRIPT_MESSAGES,
				"Cold reopen must recover the synthetic transcript rows",
			)
			assert.ok(
				reopenedTask.clineMessages.some(
					(message) => message.type === "say" && message.text === TRANSCRIPT_SENTINEL,
				),
				"Cold reopen must recover the last persisted sentinel",
			)
			priorCycleCpu = process.cpuUsage()

			for (const cycle of CYCLES) {
				await uiFixtureBarrier(`warm-${cycle}-new-chat`, { version: vscode.version, taskId, cycle })
				const newChatObservedAtEpochMs = Date.now()
				assert.equal(host.getActiveTaskId(), undefined, `New Chat must clear the active task in cycle ${cycle}`)
				assert.equal(host.getLiveTask(taskId), reopenedTask, `New Chat must retain the Task in cycle ${cycle}`)

				await uiFixtureBarrier(`warm-${cycle}-task-open`, { version: vscode.version, taskId, cycle })
				const taskOpenObservedAtEpochMs = Date.now()
				assert.equal(host.getActiveTaskId(), taskId, `Task must be active after cycle ${cycle}`)
				assert.equal(
					host.getLiveTask(taskId),
					reopenedTask,
					`Warm open must reuse the Task object in cycle ${cycle}`,
				)
				const cycleCpu = process.cpuUsage(priorCycleCpu)
				priorCycleCpu = process.cpuUsage()
				const memory = process.memoryUsage()
				warmHostObservations.push({
					cycle,
					newChatObservedAtEpochMs,
					taskOpenObservedAtEpochMs,
					cpuUserDeltaUs: cycleCpu.user,
					cpuSystemDeltaUs: cycleCpu.system,
					rssBytes: memory.rss,
					heapUsedBytes: memory.heapUsed,
				})
			}

			const cpuDelta = process.cpuUsage(cpuStarted)
			const memoryEnded = process.memoryUsage()
			const extensionHostActivity = {
				pid: process.pid,
				processUptimeMs: Math.round(process.uptime() * 1000),
				cpuUserMs: cpuDelta.user / 1000,
				cpuSystemMs: cpuDelta.system / 1000,
				memoryStart: { rssBytes: memoryStarted.rss, heapUsedBytes: memoryStarted.heapUsed },
				memoryEnd: { rssBytes: memoryEnded.rss, heapUsedBytes: memoryEnded.heapUsed },
				eventLoopDelayMs: {
					p50: loopDelay.percentile(50) / 1e6,
					p95: loopDelay.percentile(95) / 1e6,
					max: loopDelay.max / 1e6,
				},
				warmHostObservations,
			}
			await uiFixtureBarrier("benchmark-complete", {
				version: vscode.version,
				taskId,
				coldOpenObservedAtEpochMs,
				extensionHostActivity,
			})
		} finally {
			loopDelay.disable()
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(originalConfiguration)
		}
	})
})
