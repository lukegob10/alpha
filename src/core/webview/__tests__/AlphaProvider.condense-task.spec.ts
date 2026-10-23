// pnpm --dir src exec vitest run core/webview/__tests__/AlphaProvider.condense-task.spec.ts --maxWorkers=2

import { describe, expect, it, vi } from "vitest"

import { AlphaProvider } from "../AlphaProvider"
import type { Task } from "../../task/Task"

const taskId = "task-1"
const completionResponse = { type: "condenseTaskContextResponse" as const, text: taskId }

const createProviderHarness = (condenseContext: import("vitest").Mock, postMessageToWebview = vi.fn()) => {
	const task = { taskId, condenseContext } as unknown as Task
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		taskStack: [task],
		taskSessions: { getTask: vi.fn((id: string) => (id === taskId ? task : undefined)) },
		postMessageToWebview,
		log: vi.fn(),
	}) as AlphaProvider

	return { provider, task, postMessageToWebview }
}

describe("AlphaProvider.condenseTaskContext", () => {
	it("posts one completion response after the selected task condenses", async () => {
		const condenseContext = vi.fn().mockResolvedValue(undefined)
		const { provider, postMessageToWebview } = createProviderHarness(condenseContext)

		await expect(provider.condenseTaskContext(taskId)).resolves.toBeUndefined()

		expect(condenseContext).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledWith(completionResponse)
	})

	it.each([
		["a condensation failure", Object.assign(new Error("condense failed"), { name: "CondenseError" })],
		["an abort", Object.assign(new Error("condense aborted"), { name: "AbortError" })],
	] as const)("posts one completion response after %s and preserves the error", async (_label, error) => {
		const condenseContext = vi.fn().mockRejectedValue(error)
		const { provider, postMessageToWebview } = createProviderHarness(condenseContext)

		await expect(provider.condenseTaskContext(taskId)).rejects.toBe(error)

		expect(condenseContext).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledWith(completionResponse)
	})

	it("preserves a condensation error when completion notification fails", async () => {
		const condenseError = new Error("condense failed")
		const notificationError = new Error("webview unavailable")
		const condenseContext = vi.fn().mockRejectedValue(condenseError)
		const postMessageToWebview = vi.fn().mockRejectedValue(notificationError)
		const { provider } = createProviderHarness(condenseContext, postMessageToWebview)

		await expect(provider.condenseTaskContext(taskId)).rejects.toBe(condenseError)
		expect(postMessageToWebview).toHaveBeenCalledOnce()
	})

	it("propagates a notification failure after condensation succeeds", async () => {
		const notificationError = new Error("webview unavailable")
		const condenseContext = vi.fn().mockResolvedValue(undefined)
		const postMessageToWebview = vi.fn().mockRejectedValue(notificationError)
		const { provider } = createProviderHarness(condenseContext, postMessageToWebview)

		await expect(provider.condenseTaskContext(taskId)).rejects.toBe(notificationError)
		expect(condenseContext).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledOnce()
	})

	it("condenses a task displayed from another provider's session", async () => {
		const condenseContext = vi.fn().mockResolvedValue(undefined)
		const { provider, postMessageToWebview } = createProviderHarness(condenseContext)
		Object.assign(provider, { taskStack: [] })

		await expect(provider.condenseTaskContext(taskId)).resolves.toBeUndefined()

		expect(condenseContext).toHaveBeenCalledOnce()
		expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith(completionResponse)
	})

	it("clears the composer's busy state when the requested task is no longer live", async () => {
		const { provider, postMessageToWebview } = createProviderHarness(vi.fn())

		await expect(provider.condenseTaskContext("missing-task")).rejects.toThrow(
			"Task with id missing-task not found",
		)
		expect(postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "condenseTaskContextResponse",
			text: "missing-task",
		})
	})
})
