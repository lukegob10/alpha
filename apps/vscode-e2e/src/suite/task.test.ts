import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@alpha-code/types"

import { waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

class TaskScriptedAI {
	readonly id = "task-e2e"

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
	getLiveTask(taskId: string): { taskAsk?: { ask?: string }; approveAsk(): void } | undefined
}

suite("Alpha Task", function () {
	setDefaultSuiteTimeout(this)

	test("Should handle prompt and response correctly", async () => {
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: TaskHostProvider }).sidebarProvider
		assert.ok(provider, "The extension API did not expose its host provider to the task E2E test")

		const messages: ClineMessage[] = []

		api.on(RooCodeEventName.Message, ({ message }) => {
			if (message.type === "say" && message.partial === false) {
				messages.push(message)
			}
		})

		const configuration =
			process.env.ALPHA_E2E_PROVIDER_MODE === "scripted"
				? {
						...api.getConfiguration(),
						apiProvider: "fake-ai" as const,
						fakeAi: new TaskScriptedAI(),
						mode: "ask",
						alwaysAllowModeSwitch: true,
						autoApprovalEnabled: true,
						requestDelaySeconds: 0,
						writeDelayMs: 0,
						enableCheckpoints: false,
					}
				: { mode: "ask" as const, alwaysAllowModeSwitch: true, autoApprovalEnabled: true }
		const taskId = await api.startNewTask({
			configuration,
			text: "Hello world, what is your name? Respond with 'My name is ...'",
		})

		let completionAskApproved = false
		const completion = waitUntilCompleted({ api, taskId })
		await waitFor(
			() => {
				const task = provider.getLiveTask(taskId)
				if (task?.taskAsk?.ask === "completion_result" && !completionAskApproved) {
					completionAskApproved = true
					task.approveAsk()
				}
				return completionAskApproved
			},
			{ description: "the scripted task completion boundary" },
		)
		await completion

		assert.ok(
			!!messages.find(
				({ say, text }) =>
					(say === "completion_result" || say === "text") && text?.includes("My name is Alpha"),
			),
			`Completion should include "My name is Alpha"`,
		)
	})
})
