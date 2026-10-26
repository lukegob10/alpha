import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../../core/task/Task"
import { WorkspaceMutationGate } from "../../../core/task/WorkspaceMutationGate"
import { ToolRegistry } from "../../../core/tools/ToolRegistry"
import type { ToolCallbacks } from "../../../core/tools/BaseTool"
import {
	scheduledForegroundInput,
	SCHEDULED_FOREGROUND_RESPONSE,
} from "../../../../apps/vscode-e2e/src/scenarios/scheduledAgentFixture"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

describe("scheduled agent foreground fixture boundary", () => {
	it("holds real foreground input while allowing a background mutation to acquire the production workspace gate", async () => {
		const gate = new WorkspaceMutationGate()
		const inputEntered = deferred<void>()
		const answer = deferred<{ response: "messageResponse"; text: string }>()
		const owner = {
			runWorkspaceMutation: vi.fn((task: Task, label: string, run: () => Promise<void>) =>
				gate.run(task.taskId, label, run),
			),
		}
		const foreground = {
			taskId: "foreground",
			taskKind: "primary",
			abort: false,
			providerRef: new WeakRef(owner),
			ask: vi.fn(async () => {
				inputEntered.resolve()
				return answer.promise
			}),
			say: vi.fn(async () => undefined),
		}
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn(async () => true),
			handleError: vi.fn(async () => undefined),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		const operation = scheduledForegroundInput()
		const registry = new ToolRegistry()
		const input = registry.resolve(operation.name)!.execute({
			task: foreground as unknown as Task,
			call: {
				type: "tool_use",
				id: "foreground-input",
				name: operation.name,
				params: {},
				nativeArgs: operation.arguments,
				partial: false,
			},
			callbacks,
		})
		let inputSettled = false
		void input
			.finally(() => {
				inputSettled = true
			})
			.catch(() => undefined)
		const mutate = vi.fn(async () => undefined)
		try {
			await Promise.race([
				inputEntered.promise,
				input.then(() => {
					throw new Error("Foreground returned before its input barrier")
				}),
			])
			await gate.run("scheduled-agent", "scheduled artifact", mutate)
			expect(mutate).toHaveBeenCalledOnce()
			expect(inputSettled).toBe(false)
			expect(owner.runWorkspaceMutation).not.toHaveBeenCalled()
			expect(foreground.ask).toHaveBeenCalledWith(
				"followup",
				expect.any(String),
				false,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
			)
		} finally {
			answer.resolve({ response: "messageResponse", text: SCHEDULED_FOREGROUND_RESPONSE })
			await input
		}
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(SCHEDULED_FOREGROUND_RESPONSE)
	})
})
