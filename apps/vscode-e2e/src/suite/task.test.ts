import * as assert from "assert"

import { AlphaCodeEventName, type AlphaMessage } from "@alpha-code/types"

import { waitFor } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"
import { withBoundedFixtureCleanup } from "./proportional-context-support"

class TaskScriptedAI {
	readonly id = "task-e2e"
	removeFromCache?: () => void

	async *createMessage(): AsyncGenerator<
		{ type: "text"; text: string } | { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }
	> {
		yield { type: "text", text: "My name is Alpha." }
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	getModel() {
		return {
			id: "task-scripted-e2e",
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

type TaskHostProvider = {
	getLiveTask(taskId: string):
		| {
				didComplete: boolean
				taskAsk?: AlphaMessage
				clineMessages: AlphaMessage[]
				messageQueueService: { hasUnconsumedInput(): boolean }
				waitForTermination(): Promise<void>
		  }
		| undefined
}

suite("Alpha Task", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle prompt and response correctly", async () => {
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: TaskHostProvider }).sidebarProvider
		assert.ok(provider, "The extension API did not expose its host provider to the task E2E test")

		const originalConfiguration = api.getConfiguration()
		const scriptedAI = new TaskScriptedAI()
		const completionCounts = new Map<string, number>()
		const completionPromptTasks = new Set<string>()
		const onMessage = ({ taskId, message }: { taskId: string; message: AlphaMessage }) => {
			if (message.type === "ask" && message.ask === "completion_result") completionPromptTasks.add(taskId)
		}
		const onCompleted = (taskId: string) => {
			completionCounts.set(taskId, (completionCounts.get(taskId) ?? 0) + 1)
		}
		api.on(AlphaCodeEventName.Message, onMessage)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		const configuration =
			process.env.ALPHA_E2E_PROVIDER_MODE === "scripted"
				? {
						...originalConfiguration,
						apiProvider: "fake-ai" as const,
						fakeAi: scriptedAI,
						mode: "code",
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
						enableCheckpoints: false,
					}
				: { mode: "code" as const, autoApprovalEnabled: true }
		let taskId: string | undefined
		await withBoundedFixtureCleanup(async () => {
			taskId = await api.startNewTask({
				configuration,
				text: "Hello world, what is your name? Respond with 'My name is ...'",
			})
			await waitFor(
				() => {
					assert.equal(
						completionPromptTasks.has(taskId!),
						false,
						"Completion must not ask for acknowledgement",
					)
					return (
						(completionCounts.get(taskId!) ?? 0) > 0 && provider.getLiveTask(taskId!)?.didComplete === true
					)
				},
				{ description: "automatic task completion" },
			)
			const task = provider.getLiveTask(taskId)
			assert.ok(task, "The completed task must remain available")
			await task.waitForTermination()
			assert.equal(completionCounts.get(taskId), 1, "Task completion must be published once")
			assert.equal(completionPromptTasks.has(taskId), false)
			assert.equal(task.taskAsk?.ask, undefined)
			assert.equal(task.messageQueueService.hasUnconsumedInput(), false)
			const completionRows = task.clineMessages.filter(
				(message) => message.type === "say" && message.say === "completion_result" && !message.partial,
			)
			assert.equal(completionRows.length, 1, "The task must retain one canonical final answer")
			assert.ok(
				completionRows[0]?.text?.includes("My name is Alpha"),
				`Completion should include "My name is Alpha"`,
			)
		}, [
			async () => {
				if (taskId && !provider.getLiveTask(taskId)?.didComplete) await api.cancelCurrentTask()
				if (taskId) await provider.getLiveTask(taskId)?.waitForTermination()
			},
			() => api.clearCurrentTask(),
			() => api.off(AlphaCodeEventName.Message, onMessage),
			() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => scriptedAI.removeFromCache?.(),
			() => api.setConfiguration(originalConfiguration),
		])
	})
})
