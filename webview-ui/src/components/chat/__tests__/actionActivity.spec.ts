import type { AlphaMessage } from "@alpha-code/types"

import { getActionActivity, getCompletedTurnActivity } from "../actionActivity"
import { transcriptTurnIdentity } from "../utils/transcriptTurns"
import { fileChangesFromMessages, fileChangeTurnsFromMessages } from "../utils/fileChangesFromMessages"

describe("action activity projection", () => {
	it("reuses completed tool payloads while the tail streams and refreshes replaced or reloaded history", () => {
		const turn = { runId: "cached-run", turnId: "completed-turn" }
		const edit: AlphaMessage = {
			ts: 200,
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "appliedDiff",
				path: "before.ts",
				content: "+before",
				changeStatus: "applied",
			}),
			turn,
		}
		const messages: AlphaMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "user_feedback",
				text: "Edit the file",
				turn: { ...turn, inputKind: "start" },
			},
			edit,
			{ ts: 300, type: "say", say: "text", text: "Done", turn: { ...turn, terminalStatus: "completed" } },
			{ ts: 400, type: "say", say: "text", text: "Streaming", partial: true },
		]
		const project = (history: AlphaMessage[]) => {
			getActionActivity(history)
			getCompletedTurnActivity(history)
			return fileChangeTurnsFromMessages(history).flatMap((turn) => fileChangesFromMessages(turn.messages))
		}
		const parse = vi.spyOn(JSON, "parse")
		try {
			expect(project(messages)).toMatchObject([{ path: "before.ts" }])
			parse.mockClear()
			for (let index = 0; index < 120; index++) {
				project([...messages.slice(0, -1), { ...messages.at(-1)!, text: `Streaming ${index}` }])
			}
			expect(parse.mock.calls.filter(([text]) => text === edit.text)).toHaveLength(0)

			const replacement = {
				...edit,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "after.ts",
					content: "+after",
					changeStatus: "applied",
				}),
			}
			const replaced = messages.map((message) => (message.ts === edit.ts ? replacement : message))
			expect(project(replaced)).toMatchObject([{ path: "after.ts" }])
			const replacementParses = parse.mock.calls.filter(([text]) => text === replacement.text).length
			expect(replacementParses).toBeGreaterThan(0)
			expect(project(replaced)).toMatchObject([{ path: "after.ts" }])
			expect(parse.mock.calls.filter(([text]) => text === replacement.text)).toHaveLength(replacementParses)
			const reloaded: AlphaMessage[] = JSON.parse(JSON.stringify(replaced))
			expect(project(reloaded)).toMatchObject([{ path: "after.ts" }])
			expect(parse.mock.calls.filter(([text]) => text === replacement.text).length).toBeGreaterThan(
				replacementParses,
			)
		} finally {
			parse.mockRestore()
		}
	})

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
			memberIndices: [0, 1, 2],
		})
		expect(activity.get(2)).toBe(activity.get(0))
		expect(activity.has(3)).toBe(false)
	})

	it.each(["terminal update", "reload", "receipt replacement"] as const)(
		"keeps a structured input receipt visible after canonical completion and %s",
		(publication) => {
			const turn = { runId: "input-run", turnId: "input-turn" }
			const receipt: AlphaMessage = {
				ts: 300,
				type: "say",
				say: "user_feedback",
				text: "Which environment should I use?\nStaging",
				userInputResponse: {
					questions: [
						{ header: "Environment", question: "Which environment should I use?", answers: ["Staging"] },
					],
				},
				turn,
			}
			const messages: AlphaMessage[] = [
				{
					ts: 100,
					type: "say",
					say: "user_feedback",
					text: "Inspect the project",
					turn: { ...turn, inputKind: "start" },
				},
				{
					ts: 200,
					type: "ask",
					ask: "followup",
					text: "Which environment should I use?",
					isAnswered: true,
					turn,
				},
				receipt,
				{ ts: 400, type: "say", say: "reasoning", text: "Operational details", turn },
				{ ts: 500, type: "ask", ask: "command", text: "pnpm test", isAnswered: true, turn },
				{
					ts: 600,
					type: "say",
					say: "text",
					text: "Verified",
					partial: true,
					turn: { ...turn, terminalStatus: "completed" },
				},
			]
			expect(getCompletedTurnActivity(messages).size).toBe(0)
			let completed = messages.map((message) => (message.ts === 600 ? { ...message, partial: false } : message))
			if (publication === "reload") completed = JSON.parse(JSON.stringify(completed))
			if (publication === "receipt replacement") {
				const beforeReceipt = completed.map((message) =>
					message.ts === receipt.ts ? { ...message, userInputResponse: undefined } : message,
				)
				expect(getCompletedTurnActivity(beforeReceipt).has(2)).toBe(true)
				completed = beforeReceipt.map((message) => (message.ts === receipt.ts ? { ...receipt } : message))
			}

			const activity = getCompletedTurnActivity(completed)
			expect(activity.has(2)).toBe(false)
			expect([...activity.keys()]).toEqual([1, 3, 4])
			expect(activity.get(1)).toMatchObject({ kind: "worked", count: 3, memberIndices: [1, 3, 4] })
			expect(getActionActivity(completed).has(2)).toBe(false)
		},
	)

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

	it("folds the full attributed turn including steering before a queued successor starts", () => {
		const turn = { runId: "run", turnId: "first" }
		const prompt: AlphaMessage = {
			ts: 100,
			type: "say",
			say: "user_feedback",
			text: "Inspect the implementation",
			turn: { ...turn, inputKind: "start" },
		}
		const messages: AlphaMessage[] = [
			{ ts: 200, type: "say", say: "text", text: "Inspecting", turn },
			{ ts: 300, type: "ask", ask: "command", text: "git status", isAnswered: true, turn },
			{ ts: 400, type: "say", say: "user_feedback", text: "Check types", turn: { ...turn, inputKind: "steer" } },
			{ ts: 500, type: "say", say: "reasoning", text: "Checking types", turn },
			{
				ts: 600,
				type: "say",
				say: "user_feedback",
				text: "Check lint too",
				turn: { ...turn, inputKind: "steer" },
			},
			{ ts: 700, type: "say", say: "text", text: "Verified", turn: { ...turn, terminalStatus: "completed" } },
			{
				ts: 800,
				type: "say",
				say: "user_feedback",
				text: "Next queued request",
				turn: { runId: "run", turnId: "second", inputKind: "start" },
			},
			{
				ts: 900,
				type: "say",
				say: "text",
				text: "Next request is active",
				turn: { runId: "run", turnId: "second" },
			},
		]

		const activity = getCompletedTurnActivity(messages, prompt)
		expect([...activity.keys()]).toEqual([0, 1, 2, 3, 4])
		expect(activity.get(0)).toEqual({
			id: transcriptTurnIdentity(turn),
			startIndex: 0,
			endIndex: 4,
			kind: "worked",
			count: 5,
			durationMs: 600,
			memberIndices: [0, 1, 2, 3, 4],
		})
		expect(activity.get(4)).toBe(activity.get(0))
		expect(getCompletedTurnActivity(messages.slice(0, 6), prompt).get(0)?.id).toBe(activity.get(0)?.id)
	})

	it("leaves attention and unknown rows visible without losing the rest of a completed turn", () => {
		const turn = { runId: "run", turnId: "first" }
		const messages: AlphaMessage[] = [
			{ ts: 100, type: "say", say: "text", text: "Inspecting", turn },
			{ ts: 200, type: "ask", ask: "tool", text: "{}", turn },
			{ ts: 300, type: "say", say: "reasoning", text: "Details", turn },
			{
				ts: 400,
				type: "say",
				say: "async_user_input",
				asyncUserInput: { questions: [{ title: "Which?" }] },
				turn,
			},
			{ ts: 500, type: "say", say: "error", text: "A check failed", turn },
			{
				ts: 600,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "agentLifecycle", lifecycleStatus: "error" }),
				turn,
			},
			{ ts: 700, type: "ask", ask: "command", text: "pnpm test", isAnswered: true, turn },
			{ ts: 800, type: "say", say: "checkpoint_saved", text: "unattributed" },
			{ ts: 900, type: "say", say: "text", text: "Done", turn: { ...turn, terminalStatus: "completed" } },
		]

		const activity = getCompletedTurnActivity(messages)
		expect([...activity.keys()]).toEqual([0, 2, 6])
		expect(activity.get(0)).toMatchObject({ count: 3, memberIndices: [0, 2, 6], startIndex: 0, endIndex: 6 })
	})

	it.each([undefined, "failed", "interrupted"] as const)(
		"does not infer canonical success from completion_result or live task state (%s)",
		(terminalStatus) => {
			const turn = { runId: "run", turnId: "first" }
			const messages: AlphaMessage[] = [
				{ ts: 100, type: "say", say: "text", text: "Checking", turn },
				{ ts: 200, type: "say", say: "completion_result", text: "Reported", turn: { ...turn, terminalStatus } },
			]
			expect(getCompletedTurnActivity(messages, 50, true).size).toBe(0)
		},
	)

	it("keeps a legacy pending input as a hole rather than suppressing its completed group", () => {
		const messages: AlphaMessage[] = [
			{ ts: 200, type: "say", say: "text", text: "Inspecting" },
			{ ts: 300, type: "ask", ask: "followup", text: "Which file?" },
			{ ts: 400, type: "say", say: "reasoning", text: "More detail" },
			{ ts: 500, type: "say", say: "completion_result", text: "Done" },
		]
		expect(getCompletedTurnActivity(messages, 100).get(0)?.memberIndices).toEqual([0, 2])
		expect(getCompletedTurnActivity(messages, 100).has(1)).toBe(false)
	})

	it("keeps captured late output in its original canonical parent around a successor turn", () => {
		const first = { runId: "run", turnId: "first" }
		const second = { runId: "run", turnId: "second" }
		const messages: AlphaMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "user_feedback",
				text: "First request",
				turn: { ...first, inputKind: "start" },
			},
			{ ts: 200, type: "say", say: "text", text: "First work", turn: first },
			{
				ts: 300,
				type: "say",
				say: "user_feedback",
				text: "Next request",
				turn: { ...second, inputKind: "start" },
			},
			{ ts: 400, type: "say", say: "text", text: "Late first work", turn: first },
			{ ts: 500, type: "say", say: "text", text: "First final", turn: { ...first, terminalStatus: "completed" } },
			{ ts: 600, type: "say", say: "reasoning", text: "Second work", turn: second },
			{
				ts: 700,
				type: "say",
				say: "text",
				text: "Second final",
				turn: { ...second, terminalStatus: "completed" },
			},
		]
		const activity = getCompletedTurnActivity(messages)
		expect(activity.get(1)).toMatchObject({
			id: transcriptTurnIdentity(first),
			memberIndices: [1, 3],
			durationMs: 400,
		})
		expect(activity.get(3)).toBe(activity.get(1))
		expect(activity.has(2)).toBe(false)
		expect(activity.get(5)).toMatchObject({ id: transcriptTurnIdentity(second), memberIndices: [5] })
	})

	it("includes captured output delivered after the exact final without folding the successor", () => {
		const first = { runId: "run", turnId: "first" }
		const second = { runId: "run", turnId: "second" }
		const messages: AlphaMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "user_feedback",
				text: "First request",
				turn: { ...first, inputKind: "start" },
			},
			{ ts: 200, type: "say", say: "text", text: "First work", turn: first },
			{ ts: 300, type: "say", say: "text", text: "First final", turn: { ...first, terminalStatus: "completed" } },
			{
				ts: 400,
				type: "say",
				say: "user_feedback",
				text: "Next request",
				turn: { ...second, inputKind: "start" },
			},
			{ ts: 500, type: "say", say: "text", text: "Late first work", turn: first },
			{ ts: 600, type: "say", say: "text", text: "Second work", turn: second },
		]
		const activity = getCompletedTurnActivity(messages)
		expect(activity.get(1)).toMatchObject({
			id: transcriptTurnIdentity(first),
			memberIndices: [1, 4],
			durationMs: 200,
		})
		expect(activity.get(4)).toBe(activity.get(1))
		for (const index of [0, 2, 3, 5]) expect(activity.has(index)).toBe(false)
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

	it("keeps a partial untyped tool review outside collapsed live actions", () => {
		const messages: AlphaMessage[] = [
			{
				ts: 1,
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({ tool: "readFile", path: "one.ts" }),
			},
			{
				ts: 2,
				type: "ask",
				ask: "tool",
				partial: true,
				text: JSON.stringify({ tool: "readFile", path: "two.ts" }),
			},
		]
		expect([...getActionActivity(messages).keys()]).toEqual([0])
	})

	it.each(["command", "tool", "use_mcp_server"] as const)(
		"keeps a canonical pending %s hole visible even without a typed approval or tail position",
		(ask) => {
			const turn = { runId: "run", turnId: "turn" }
			const messages: AlphaMessage[] = [
				{ ts: 1, type: "say", say: "api_req_started", text: "{}", turn },
				{ ts: 2, type: "ask", ask, text: JSON.stringify({ tool: "readFile", path: "pending.ts" }), turn },
				{ ts: 3, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "done.ts" }), turn },
			]
			const activity = getActionActivity(messages)
			expect([...activity.keys()]).toEqual([0, 2])
			expect(activity.get(0)).toMatchObject({ startIndex: 0, endIndex: 0 })
			expect(activity.get(2)).toMatchObject({ startIndex: 2, endIndex: 2 })
		},
	)

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

	it.each([
		{ lifecycleStatus: "error" },
		{ lifecycleStatus: "completed", cancelled: true },
		{ status: "denied" },
		{ changeStatus: "failed" },
	])("keeps failed or cancelled tool outcomes outside live activity (%j)", (outcome) => {
		const messages: AlphaMessage[] = [
			{ ts: 1, type: "say", say: "tool", text: JSON.stringify({ tool: "agentLifecycle", ...outcome }) },
			{ ts: 2, type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/a.ts" }) },
		]
		expect([...getActionActivity(messages).keys()]).toEqual([1])
	})

	it("does not merge consecutive actions across explicit canonical turns", () => {
		const messages: AlphaMessage[] = [
			{
				ts: 1,
				type: "ask",
				ask: "command",
				text: "pwd",
				isAnswered: true,
				turn: { runId: "run", turnId: "first" },
			},
			{
				ts: 2,
				type: "ask",
				ask: "command",
				text: "git status",
				isAnswered: true,
				turn: { runId: "run", turnId: "second" },
			},
		]
		const activity = getActionActivity(messages)
		expect(activity.get(0)).toMatchObject({ id: 1, startIndex: 0, endIndex: 0 })
		expect(activity.get(1)).toMatchObject({ id: 2, startIndex: 1, endIndex: 1 })
	})

	it.each(["failed", "interrupted"] as const)(
		"keeps an explicitly %s terminal row out of action disclosure",
		(terminalStatus) => {
			const message: AlphaMessage = {
				ts: 1,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "agentLifecycle", lifecycleStatus: "completed" }),
				turn: { runId: "run", turnId: "turn", terminalStatus },
			}
			expect(getActionActivity([message]).size).toBe(0)
		},
	)

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
