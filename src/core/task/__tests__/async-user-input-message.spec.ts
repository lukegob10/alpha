import { describe, expect, it, vi } from "vitest"

import type { AsyncUserInputData, AlphaMessage } from "@alpha-code/types"

import { Task } from "../Task"

describe("Task async user input message", () => {
	it("persists one typed UI card without adding a synthetic provider-history message", async () => {
		const request: AsyncUserInputData = {
			questions: [{ title: "Which environment should I use?", options: ["Staging", "Production"] }],
		}
		const providerHistory = [{ role: "user", content: "Keep me updated." }]
		const emitted: AlphaMessage[] = []
		const task = {
			abort: false,
			taskId: "root-task",
			instanceId: "primary",
			apiConversationHistory: providerHistory,
			addToAlphaMessages: vi.fn(async (message: AlphaMessage) => emitted.push(message)),
		} as unknown as Task

		await Task.prototype.say.call(task, "async_user_input", undefined, undefined, undefined, undefined, undefined, {
			isNonInteractive: true,
			asyncUserInput: request,
		})

		expect(emitted).toHaveLength(1)
		expect(emitted[0]).toMatchObject({
			type: "say",
			say: "async_user_input",
			asyncUserInput: request,
		})
		expect(providerHistory).toEqual([{ role: "user", content: "Keep me updated." }])
	})
})
