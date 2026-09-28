import type { AlphaMessage } from "@alpha-code/types"

import { getActionActivity, getCompletedTurnActivity } from "../actionActivity"

describe("action activity projection", () => {
	it("projects completed turn activity separately from its prompt and final response", () => {
		const messages: AlphaMessage[] = [
			{ ts: 200, type: "say", say: "text", text: "I’ll inspect the ignore rules." },
			{ ts: 300, type: "ask", ask: "command", text: "git status --short", isAnswered: true },
			{ ts: 400, type: "say", say: "command_output", text: " M .gitignore" },
			{ ts: 700, type: "say", say: "completion_result", text: "The ignore rules are organized." },
		]

		const activity = getCompletedTurnActivity(messages, 100)
		expect(activity.get(0)).toEqual({
			id: 200,
			startIndex: 0,
			endIndex: 2,
			kind: "worked",
			count: 3,
			durationMs: 600,
		})
		expect(activity.get(2)).toBe(activity.get(0))
		expect(activity.has(3)).toBe(false)
	})

	it("uses a completed ordinary assistant message as the turn boundary", () => {
		const messages: AlphaMessage[] = [
			{ ts: 200, type: "say", say: "text", text: "Checking the implementation." },
			{ ts: 300, type: "ask", ask: "command", text: "git status --short", isAnswered: true },
			{ ts: 700, type: "say", say: "text", text: "The changes are complete." },
		]

		const activity = getCompletedTurnActivity(messages, 100, true)
		expect(activity.get(0)).toMatchObject({
			startIndex: 0,
			endIndex: 1,
			kind: "worked",
			durationMs: 600,
		})
		expect(activity.has(2)).toBe(false)
	})

	it("folds consecutive live actions without hiding narrative or final responses", () => {
		const messages: AlphaMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "Checking the implementation" },
			{ ts: 2, type: "say", say: "api_req_started", text: "{}" },
			{ ts: 3, type: "ask", ask: "command", text: "rg -n agent src" },
			{ ts: 4, type: "say", say: "command_output", text: "src/agent.ts" },
			{ ts: 5, type: "say", say: "reasoning", text: "Now update it" },
			{ ts: 6, type: "ask", ask: "tool", text: JSON.stringify({ tool: "appliedDiff", path: "src/agent.ts" }) },
			{ ts: 7, type: "say", say: "completion_result", text: "Done" },
		]
		const activity = getActionActivity(messages)
		expect(activity.get(1)).toEqual({ id: 2, startIndex: 1, endIndex: 3, kind: "commands", count: 3 })
		expect(activity.get(3)).toBe(activity.get(1))
		expect(activity.get(5)).toEqual({ id: 6, startIndex: 5, endIndex: 5, kind: "edits", count: 1 })
		for (const index of [0, 4, 6]) expect(activity.has(index)).toBe(false)
	})

	it("leaves pending approvals, failures, and questions visible", () => {
		const messages: AlphaMessage[] = [
			{ ts: 1, type: "ask", ask: "command", text: "pnpm test" },
			{ ts: 2, type: "say", say: "error", text: "Test failed" },
			{
				ts: 3,
				type: "ask",
				ask: "tool",
				text: "{}",
				toolApprovalRequest: {
					requestId: "approval",
					taskId: "task",
					toolName: "read_file",
					availableDecisions: ["approve_once", "deny"],
				},
			},
			{ ts: 4, type: "ask", ask: "followup", text: "Continue?" },
			{ ts: 5, type: "ask", ask: "command", text: "git status" },
		]
		const activity = getActionActivity(messages, 5)
		expect([...activity.keys()]).toEqual([0])
		expect(activity.has(4)).toBe(false)
	})

	it("keeps completed command file-change records inside the command group", () => {
		const messages: AlphaMessage[] = [
			{ ts: 1, type: "ask", ask: "command", text: "format file", isAnswered: true },
			{ ts: 2, type: "say", say: "command_output", text: "done" },
			{
				ts: 3,
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/agent.ts",
					changeStatus: "applied",
					commandExecutionId: "execution-1",
				}),
			},
		]
		expect(getActionActivity(messages).get(2)).toEqual({
			id: 1,
			startIndex: 0,
			endIndex: 2,
			kind: "commands",
			count: 3,
		})
	})

	it("keeps Ticket activity and failed actions outside the folded work", () => {
		const messages: AlphaMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: "{}" },
			{ ts: 2, type: "say", say: "tool", text: JSON.stringify({ tool: "ticket", ticketActivity: {} }) },
			{ ts: 3, type: "say", say: "api_req_started", text: JSON.stringify({ streamingFailedMessage: "Offline" }) },
			{ ts: 4, type: "say", say: "tool", text: JSON.stringify({ tool: "browserAction", status: "error" }) },
			{ ts: 5, type: "ask", ask: "tool", text: JSON.stringify({ tool: "ticket", ticketActivity: {} }) },
		]
		const activity = getActionActivity(messages, undefined, 3)
		expect([...activity.keys()]).toEqual([0])
	})

	it("retains stable group identity as actions arrive and does not mutate the transcript", () => {
		const first = Object.freeze({ ts: 1, type: "ask", ask: "command", text: "pwd" } as const)
		const next = Object.freeze({ ts: 2, type: "ask", ask: "command", text: "git status" } as const)
		expect(getActionActivity([first]).get(0)?.id).toBe(1)
		expect(getActionActivity([first, next]).get(1)).toEqual({
			id: 1,
			startIndex: 0,
			endIndex: 1,
			kind: "commands",
			count: 2,
		})
		expect(first.text).toBe("pwd")
	})
})
