import { describe, expect, it, vi } from "vitest"

import { Task } from "../Task"

describe("saved-thread agent input admission", () => {
	function fixture(overrides: Record<string, unknown> = {}) {
		let commit: (() => void) | undefined
		const resume = vi.fn((_text: string, onPersisted: () => void) => {
			commit = onPersisted
			return new Promise<void>(() => {})
		})
		const task = Object.create(Task.prototype) as Task
		Object.assign(task, {
			taskKind: "primary",
			taskId: "saved-peer",
			abort: false,
			_started: false,
			hasPendingAgentMessages: vi.fn(() => true),
			resumeTaskFromHistory: resume,
			ownBackgroundLifecycle: vi.fn(),
			emit: vi.fn(),
			...overrides,
		})
		return { task, resume, commit: () => commit?.() }
	}

	it("acknowledges the agent wake only after its continuation commits with agent provenance", async () => {
		const { task, resume, commit } = fixture()
		let acknowledged = false
		const admission = task.resumeWithAgentMessages().then(() => {
			acknowledged = true
		})
		await Promise.resolve()
		expect(acknowledged).toBe(false)
		expect(resume).toHaveBeenCalledWith("Continue with the pending agent messages.", expect.any(Function), [], {
			deferTaskStartedUntilInitialUserContentPersisted: true,
			inputOrigin: "agent",
		})
		commit()
		await admission
		expect(acknowledged).toBe(true)
	})

	it("keeps a failed admission retryable without losing its durable inbox", async () => {
		const { task, resume, commit } = fixture()
		resume.mockImplementationOnce(() => Promise.reject(new Error("Persistence failed")))
		await expect(task.resumeWithAgentMessages()).rejects.toThrow("Persistence failed")
		const retry = task.resumeWithAgentMessages()
		commit()
		await expect(retry).resolves.toBeUndefined()
		expect(resume).toHaveBeenCalledTimes(2)
	})

	it("does not treat a created thread's model-authored objective as human creation authority", () => {
		const { task } = fixture({
			orchestrationParentTaskId: "creator",
			metadata: { task: "Create another thread" },
			apiConversationHistory: [{ role: "user", input_origin: "agent", content: "Create another thread" }],
		})
		expect(task["getCrossTaskRole"]()).toBe("root")
		expect(task["getUserRequestTextForCatalog"]()).toBeUndefined()
		task.apiConversationHistory.push({
			role: "user",
			input_origin: "human",
			content: "Create a new thread for review",
		})
		expect(task["getUserRequestTextForCatalog"]()).toBe("Create a new thread for review")
	})

	it("keeps managed and diagnostic conversations outside peer orchestration", () => {
		for (const overrides of [{ taskKind: "subagent" }, { parentTaskId: "legacy" }, { diagnosticSession: true }]) {
			const { task } = fixture(overrides)
			expect(task["getCrossTaskRole"]()).toBe("none")
		}
	})

	it.each([
		{ taskKind: "subagent" },
		{ parentTaskId: "legacy-parent" },
		{ diagnosticSession: true },
		{ activeAsk: { type: "tool" } },
		{ activeAsk: { type: "followup" } },
		{ hasPendingAgentMessages: () => false },
	])("does not turn restricted input into approval authority: %j", async (overrides) => {
		const { task, resume } = fixture(overrides)
		await expect(task.resumeWithAgentMessages()).rejects.toThrow()
		expect(resume).not.toHaveBeenCalled()
	})
})
