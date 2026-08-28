import type * as vscode from "vscode"
import { describe, expect, it, vi } from "vitest"

import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { GoalSeekService } from "../GoalSeekService"

type GoalSeekServiceInternals = {
	runAlphaTask(
		prompt: string,
		workspace: string | undefined,
		mode: string | undefined,
		writeCapable: boolean,
	): Promise<{ taskId: string; result: string }>
	handleTaskCompleted(taskId: string): Promise<void>
	getTaskCompletionText(taskId: string): Promise<string>
	taskWaiters: Map<string, unknown>
}

describe("GoalSeekService task completion", () => {
	it("installs its completion waiter before a fast task can start", async () => {
		const taskId = "fast-task"
		let internals!: GoalSeekServiceInternals
		const start = vi.fn(() => {
			expect(internals.taskWaiters.has(taskId)).toBe(true)
			void internals.handleTaskCompleted(taskId)
		})
		const createTask = vi.fn(
			async (
				_prompt: string,
				_images: string[] | undefined,
				_parentTask: undefined,
				options: { startTask?: boolean },
			) => {
				expect(options.startTask).toBe(false)
				return { taskId, start }
			},
		)
		const provider = { createTask } as unknown as ClineProvider
		const context = { globalStorageUri: { fsPath: "test-storage" } } as vscode.ExtensionContext
		const outputChannel = {} as vscode.OutputChannel
		const service = new GoalSeekService(context, provider, outputChannel)
		internals = service as unknown as GoalSeekServiceInternals
		vi.spyOn(internals, "getTaskCompletionText").mockResolvedValue("Fast completion result")

		const result = await internals.runAlphaTask("Do the work", "test-workspace", "code", true)

		expect(start).toHaveBeenCalledTimes(1)
		expect(result).toEqual({ taskId, result: "Fast completion result" })
		expect(internals.taskWaiters.size).toBe(0)
	})
})
