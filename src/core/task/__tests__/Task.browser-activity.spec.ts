import type { AlphaMessage } from "@alpha-code/types"

import { reconcileExecutionStatuses } from "../../task-persistence/executionStatus"
import { Task } from "../Task"

function browserStatus(status: "running" | "completed" | "cancelled"): string {
	return JSON.stringify({ tool: "browserAction", action: "list_browser_pages", status })
}

function fixture() {
	let ownsHistory = true
	const saved: AlphaMessage[][] = []
	const postTaskMessageToWebview = vi.fn().mockResolvedValue(undefined)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "browser-activity-task",
		taskKind: "primary",
		alphaMessages: [],
		agentRunId: "browser-run",
		agentTurnId: "browser-turn",
		lastMessageTs: 1,
		providerRef: { deref: () => ({ postTaskMessageToWebview }) },
		isCurrentApiConversationHistoryOwner: () => ownsHistory,
		enqueueAlphaMessagesSave: vi.fn(
			async (createSnapshot: () => AlphaMessage[], onPersisted: () => void): Promise<boolean> => {
				saved.push(createSnapshot())
				onPersisted()
				return true
			},
		),
		emit: vi.fn(),
	}) as Task
	return { task, saved, postTaskMessageToWebview, replaceTask: () => (ownsHistory = false) }
}

it("settles the admitted row after another ask and preserves both turn and ask attribution", async () => {
	const { task, saved, postTaskMessageToWebview } = fixture()
	const settle = await task.beginBrowserToolActivity(browserStatus("running"), "list-call")
	const running = task.alphaMessages[0]
	const ask: AlphaMessage = { ts: running.ts + 1, type: "ask", ask: "followup", text: "Unrelated ask" }
	task.alphaMessages.push(ask)
	Object.assign(task, { agentTurnId: "later-turn", lastMessageTs: ask.ts })

	await settle?.(browserStatus("completed"))

	const settled = {
		...running,
		text: browserStatus("completed"),
		partial: false,
		toolCallId: "list-call",
		turn: { runId: "browser-run", turnId: "browser-turn" },
	}
	expect(task.alphaMessages).toEqual([settled, ask])
	expect(saved.at(-1)).toEqual([settled, ask])
	expect(postTaskMessageToWebview).toHaveBeenLastCalledWith("messageUpdated", task.taskId, settled)
	expect(Reflect.get(task, "lastMessageTs")).toBe(ask.ts)
})

it("settles an aborted browser action while its Task still owns the transcript", async () => {
	const { task, saved } = fixture()
	const settle = await task.beginBrowserToolActivity(browserStatus("running"), "list-call")
	task.abort = true
	expect(task.canDispatchBrowserTool()).toBe(false)

	await settle?.(browserStatus("cancelled"))

	expect(saved.at(-1)).toMatchObject([{ partial: false, text: browserStatus("cancelled") }])
})

it("leaves a replacement's transcript alone and reconciles abandoned activity on reload", async () => {
	const { task, saved, replaceTask } = fixture()
	const settle = await task.beginBrowserToolActivity(browserStatus("running"), "list-call")
	replaceTask()
	expect(task.canDispatchBrowserTool()).toBe(false)
	await settle?.(browserStatus("completed"))

	expect(saved).toHaveLength(1)
	const messages = saved[0]
	const approval: AlphaMessage = { ts: messages[0].ts + 1, type: "ask", ask: "tool", text: browserStatus("running") }
	const restored = reconcileExecutionStatuses([...messages, approval], () => false)
	expect(restored).toEqual([{ ...messages[0], partial: false, text: browserStatus("cancelled") }, approval])
	expect(reconcileExecutionStatuses(messages, (_message, kind) => kind === "browser")).toEqual(messages)
})
