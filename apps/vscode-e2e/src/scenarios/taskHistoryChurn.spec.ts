import * as assert from "node:assert/strict"
import { test } from "node:test"
import type { HistoryItem } from "@alpha-code/types"

import {
	makeTaskHistoryChurnChildObjective,
	makeTaskHistoryChurnRootText,
	TaskHistoryChurnAI,
	waitForCompletedHistory,
} from "./taskHistoryChurn"
import { TASK_HISTORY_CHURN_WORKLOAD } from "../evidence/taskHistoryChurn"

async function chunks(ai: TaskHistoryChurnAI, taskId: string) {
	const result: unknown[] = []
	for await (const chunk of ai.createMessage("", [], { taskId })) result.push(chunk)
	return result
}

test("keeps the churn prompts at their declared byte workload", () => {
	assert.equal(
		Buffer.byteLength(makeTaskHistoryChurnRootText(0), "utf8"),
		TASK_HISTORY_CHURN_WORKLOAD.rootPromptBytes,
	)
	assert.equal(
		Buffer.byteLength(makeTaskHistoryChurnChildObjective(0), "utf8"),
		TASK_HISTORY_CHURN_WORKLOAD.childObjectiveBytes,
	)
})

test("scripts one actual managed-child spawn and terminal root turn", async () => {
	const ai = new TaskHistoryChurnAI()
	const root = await chunks(ai, "root-1")
	assert.equal((root[0] as { type?: string }).type, "tool_call")
	const spawn = JSON.parse((root[0] as { arguments: string }).arguments) as { objective: string }
	assert.equal(Buffer.byteLength(spawn.objective, "utf8"), TASK_HISTORY_CHURN_WORKLOAD.childObjectiveBytes)
	ai.registerManagedChild("child-1")
	const child = await chunks(ai, "child-1")
	assert.equal((child[0] as { type?: string }).type, "text")
	const wait = await chunks(ai, "root-1")
	assert.equal((wait[0] as { name: string }).name, "wait_agent")
	assert.deepEqual(JSON.parse((wait[0] as { arguments: string }).arguments), {
		target: "history_churn_child",
		until_terminal: true,
		timeout_ms: 90_000,
	})
	const completedRoot = await chunks(ai, "root-1")
	assert.equal((completedRoot[0] as { type?: string }).type, "text")
	assert.equal(ai.requests, 4)
})

function historyItem(id: string, status: HistoryItem["status"]): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: "controlled history barrier",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		taskKind: "primary",
		status,
	}
}

test("waits for canonical history persistence after TaskCompleted", async () => {
	const taskId = "root-history-barrier"
	let reads = 0
	const provider = {
		getTaskWithId: async () => ({
			historyItem: historyItem(taskId, reads++ === 0 ? "active" : "completed"),
		}),
	}
	const completed = await waitForCompletedHistory(
		provider,
		taskId,
		"controlled completed history",
		(item) => item.id === taskId && item.status === "completed",
		{ maxAttempts: 2, waitForNextAttempt: async () => undefined },
	)
	assert.equal(completed.status, "completed")
	assert.equal(reads, 2)
})

test("does not accept a completed history item for the wrong task", async () => {
	let reads = 0
	await assert.rejects(
		() =>
			waitForCompletedHistory(
				{
					getTaskWithId: async () => ({ historyItem: historyItem("other-task", "completed") }),
				},
				"root-history-barrier",
				"controlled identity barrier",
				(item) => {
					reads++
					return item.id === "root-history-barrier" && item.status === "completed"
				},
				{ maxAttempts: 2, waitForNextAttempt: async () => undefined },
			),
		(error: unknown) =>
			error instanceof Error && error.message === "Timed out waiting for controlled identity barrier",
	)
	assert.equal(reads, 2)
})

test("propagates unexpected canonical history read errors", async () => {
	const expected = new Error("history read failed")
	await assert.rejects(
		() =>
			waitForCompletedHistory(
				{ getTaskWithId: async () => Promise.reject(expected) },
				"root-history-barrier",
				"unexpected history read",
				() => true,
				{ maxAttempts: 2, waitForNextAttempt: async () => undefined },
			),
		(error: unknown) => error === expected,
	)
})
