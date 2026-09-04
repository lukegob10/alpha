// pnpm --dir src exec vitest run core/webview/__tests__/ClineProvider.condense-task.spec.ts --maxWorkers=2

import { describe, expect, it, vi } from "vitest"

import { ClineProvider } from "../ClineProvider"
import type { Task } from "../../task/Task"

const taskId = "task-1"
const completionResponse = { type: "condenseTaskContextResponse" as const, text: taskId }

const createProviderHarness = (condenseContext: ReturnType<typeof vi.fn>, postMessageToWebview = vi.fn()) => {
	const task = { taskId, condenseContext } as unknown as Task
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		clineStack: [task],
		postMessageToWebview,
		log: vi.fn(),
	}) as ClineProvider

	return { provider, task, postMessageToWebview }
}

describe("ClineProvider.condenseTaskContext", () => {
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

	it("keeps task-not-found errors clear without posting completion", async () => {
		const { provider, postMessageToWebview } = createProviderHarness(vi.fn())

		await expect(provider.condenseTaskContext("missing-task")).rejects.toThrow(
			"Task with id missing-task not found in stack",
		)
		expect(postMessageToWebview).not.toHaveBeenCalled()
	})
})
