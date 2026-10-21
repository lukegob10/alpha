import { describe, expect, it } from "vitest"
import type { AgentLifecycleEvent, AgentTurnTerminalStatus, AlphaMessage } from "@alpha-code/types"

import type { ApiMessage } from "../apiMessages"
import { buildThreadReadResult, forkTaskHistory } from "../ThreadHistory"

function completedHistory(): ApiMessage[] {
	return [
		{
			role: "user",
			input_origin: "human",
			content: "Inspect the repository",
			ts: 10,
			queued_message_ids: ["human-1"],
		},
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "a.ts" } }],
			ts: 20,
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-1", content: "large-output-".repeat(400) }],
			ts: 30,
		},
		{
			role: "assistant",
			content: "The repository is ready.",
			phase: "final_answer",
			ts: 40,
			encrypted_content: "opaque-provider-state",
		},
	]
}

function read(apiMessages = completedHistory(), options = {}, lifecycleEvents?: readonly AgentLifecycleEvent[]) {
	return buildThreadReadResult({
		taskId: "peer-1",
		title: "Peer thread",
		objective: "Inspect the repository",
		workspacePath: "/repo",
		updatedAt: 100,
		status: { type: "idle" },
		apiMessages,
		lifecycleEvents,
		options,
	})
}

function lifecycleTurn(
	turnId: string,
	startedAt: number,
	terminal?: { status: AgentTurnTerminalStatus; at: number },
): AgentLifecycleEvent[] {
	const identity = { version: 1 as const, taskId: "peer-1", runId: `run:${turnId}`, turnId }
	return [
		{
			...identity,
			eventId: `${turnId}:start`,
			sequence: 1,
			occurredAt: startedAt,
			type: "turn_started",
			payload: {},
		},
		...(terminal
			? [
					{
						...identity,
						eventId: `${turnId}:terminal`,
						sequence: 2,
						occurredAt: terminal.at,
						type: "turn_terminal" as const,
						payload: { status: terminal.status },
					},
				]
			: []),
	]
}

describe("thread history projection", () => {
	it("exposes conversation and tool status while keeping outputs opt-in and provider state private", () => {
		const result = read()
		expect(result.turns).toHaveLength(1)
		expect(result.turns[0].items).toContainEqual({
			type: "toolCall",
			id: "read-1",
			name: "read_file",
			status: "completed",
		})
		expect(result.turns[0].items).toContainEqual({ type: "toolResult", id: "read-1", status: "completed" })
		expect(JSON.stringify(result)).toContain("The repository is ready.")
		expect(JSON.stringify(result)).not.toContain("opaque-provider-state")
		expect(JSON.stringify(result)).not.toContain("large-output-")
		const withOutput = read(completedHistory(), { includeOutputs: true, maxOutputCharsPerItem: 12 })
		expect(withOutput.turns[0].items).toContainEqual({
			type: "toolResult",
			id: "read-1",
			status: "completed",
			text: "large-output",
		})
	})

	it("pages newest turns with a stable cursor and rejects cursors from another thread", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "Check another file", ts: 50 },
			{ role: "assistant", content: "The next file is ready.", ts: 60 },
		]
		const newest = read(history)
		expect(newest.page.hasMore).toBe(true)
		expect(JSON.stringify(newest.turns)).toContain("The next file is ready.")
		const older = read(history, { cursor: newest.page.nextCursor })
		expect(older.page.hasMore).toBe(false)
		expect(JSON.stringify(older.turns)).toContain("The repository is ready.")
		expect(() => read(history, { cursor: "other-thread:cursor" })).toThrow("Unknown thread history cursor")
	})

	it.each([
		["cancelled", "interrupted"],
		["failed", "failed"],
	] as const)(
		"preserves an earlier %s response through a completed request and cold pagination",
		(outcome, status) => {
			const history: ApiMessage[] = [
				{ role: "user", input_origin: "human", content: "First request", ts: 1 },
				{
					role: "assistant",
					phase: "commentary",
					content: "Working on first request",
					agentResponseOutcome: { status: outcome },
					ts: 2,
				},
				{ role: "user", input_origin: "human", content: "Second request", ts: 3 },
				{ role: "assistant", phase: "final_answer", content: "Second request done", ts: 4 },
			]
			const all = read(history, { turnLimit: 10 })
			expect(all.turns.map((turn) => turn.status)).toEqual(["completed", status])
			expect(JSON.stringify(all.turns[0])).not.toContain("First request")
			const newest = read(history)
			expect(newest.page.hasMore).toBe(true)
			const older = read(structuredClone(history), { cursor: newest.page.nextCursor })
			expect(older.turns).toEqual([all.turns[1]])
			expect(older.page.hasMore).toBe(false)
		},
	)

	it("keeps human steering and retryable responses within the unfinished turn", () => {
		const history: ApiMessage[] = [
			{ role: "user", input_origin: "human", content: "First request", ts: 1 },
			{
				role: "assistant",
				phase: "commentary",
				content: "Retrying the first request",
				agentResponseOutcome: { status: "failed", retryable: true },
				ts: 2,
			},
			{ role: "user", input_origin: "human", content: "Also check the second file", ts: 3 },
			{ role: "assistant", phase: "final_answer", content: "Both files are ready", ts: 4 },
		]
		const result = read(history, { turnLimit: 10 })
		expect(result.turns).toHaveLength(1)
		expect(result.turns[0].status).toBe("completed")
		expect(JSON.stringify(result.turns[0])).toContain("Also check the second file")
	})

	it.each(["interrupted", "failed"] as const)(
		"projects an earlier journal %s status and identity through cold pagination",
		(status) => {
			const history: ApiMessage[] = [
				{ role: "user", input_origin: "human", content: "First request", ts: 11 },
				{ role: "assistant", phase: "final_answer", content: "Candidate rejected by the host", ts: 12 },
				{ role: "user", input_origin: "human", content: "Second request", ts: 21 },
				{ role: "assistant", phase: "final_answer", content: "Second request done", ts: 22 },
			]
			const events = [
				...lifecycleTurn("first", 10, { status, at: 13 }),
				...lifecycleTurn("second", 20, { status: "completed", at: 23 }),
			]
			const all = read(history, { turnLimit: 10 }, events)
			expect(all.turns.map((turn) => turn.status)).toEqual(["completed", status])
			const newest = read(history, {}, events)
			const older = read(structuredClone(history), { cursor: newest.page.nextCursor }, structuredClone(events))
			expect(older.turns).toEqual([all.turns[1]])
			expect(older.page).toMatchObject({ hasMore: false, nextCursor: null })
			const changedPrefix = [
				{ role: "user" as const, content: "Compacted context", isSummary: true, ts: 1 },
				...history,
			]
			expect(read(changedPrefix, { turnLimit: 10 }, events).turns.map((turn) => turn.id)).toEqual(
				all.turns.map((turn) => turn.id),
			)
		},
	)

	it("keeps apparent final answers, failed model attempts and human steering in their canonical active turn", () => {
		const history: ApiMessage[] = [
			{ role: "user", input_origin: "human", content: "First request", ts: 11 },
			{ role: "assistant", phase: "final_answer", content: "Candidate answer", ts: 12 },
			{ role: "user", input_origin: "human", content: "Also check the second file", ts: 13 },
			{ role: "assistant", content: "Failed attempt", agentResponseOutcome: { status: "failed" }, ts: 14 },
			{ role: "user", input_origin: "human", content: "Continue checking", ts: 15 },
		]
		const result = read(history, { turnLimit: 10 }, lifecycleTurn("active", 10))
		expect(result.turns).toHaveLength(1)
		expect(result.turns[0].status).toBe("inProgress")
		expect(result.turns[0].items.filter((item) => item.type === "userMessage")).toHaveLength(3)
	})

	it("attaches an input staged before the canonical start while retaining the completed legacy prefix", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "New request", ts: 50 },
			{ role: "assistant", phase: "commentary", content: "New investigation", ts: 60 },
		]
		const events = lifecycleTurn("new", 55, { status: "interrupted", at: 70 })
		const result = read(history, { turnLimit: 10 }, events)
		expect(result.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed"])
		expect(result.turns[1]).toEqual(read().turns[0])
		expect(JSON.stringify(result.turns[0])).toContain("New request")
	})

	it("projects the canonical active status before the first response to a staged input", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "New request", ts: 50 },
		]
		const result = read(history, { turnLimit: 10 }, lifecycleTurn("new", 55))
		expect(result.turns.map((turn) => turn.status)).toEqual(["inProgress", "completed"])
		expect(JSON.stringify(result.turns[0])).toContain("New request")
	})

	it("preserves host terminal status when the latest legacy answer has a final phase", () => {
		const result = buildThreadReadResult({
			taskId: "peer-1",
			objective: "Inspect the repository",
			workspacePath: "/repo",
			updatedAt: 100,
			status: { type: "idle" },
			lastTurnStatus: "failed",
			apiMessages: completedHistory(),
		})
		expect(result.turns[0].status).toBe("failed")
	})

	it("retains legacy fallback when equal journal timestamps cannot identify unstamped envelopes", () => {
		const history: ApiMessage[] = [
			{ role: "user", content: "First request", ts: 10 },
			{ role: "assistant", content: "Cancelled", agentResponseOutcome: { status: "cancelled" }, ts: 10 },
			{ role: "user", content: "Second request", ts: 10 },
			{ role: "assistant", content: "Done", phase: "final_answer", ts: 10 },
		]
		const result = read(history, { turnLimit: 10 }, [
			...lifecycleTurn("first", 10, { status: "interrupted", at: 10 }),
			...lifecycleTurn("second", 10, { status: "completed", at: 10 }),
		])
		expect(result.turns.map((turn) => turn.status)).toEqual(["completed", "interrupted"])
		expect(new Set(result.turns.map((turn) => turn.id)).size).toBe(2)
	})

	it("correlates timestamp-less response envelopes by durable message identity", () => {
		const events = lifecycleTurn("identified", 10, { status: "interrupted", at: 30 })
		events.splice(1, 0, {
			...events[0],
			eventId: "identified:text",
			sequence: 2,
			occurredAt: 20,
			type: "item_added",
			payload: {
				item: { type: "assistant_text", itemId: "text-1", messageId: "provider-message-1", text: "Working" },
			},
		})
		events[2].sequence = 3
		const result = read(
			[
				{ role: "user", input_origin: "human", content: "First request" },
				{ role: "assistant", content: "Working", messageId: "provider-message-1" },
			],
			{},
			events,
		)
		expect(result.turns).toHaveLength(1)
		expect(result.turns[0].status).toBe("interrupted")
	})

	it("correlates timestamp-less tool transactions without exposing private journal items", () => {
		const events = lifecycleTurn("identified-tool", 10, { status: "failed", at: 30 })
		events.splice(1, 0, {
			...events[0],
			eventId: "identified-tool:call",
			sequence: 2,
			occurredAt: 20,
			type: "tool_call_accepted",
			payload: {
				item: {
					type: "tool_call",
					itemId: "call-1",
					toolCallId: "read-1",
					name: "read_file",
					arguments: { private: "journal-only arguments" },
					status: "accepted",
				},
			},
		})
		events[2].sequence = 3
		const result = read(
			[
				{ role: "user", content: "Inspect the repository" },
				{ role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "secret output" }] },
			],
			{},
			events,
		)
		expect(result.turns).toHaveLength(1)
		expect(result.turns[0].status).toBe("failed")
		expect(result.turns[0].items).toContainEqual({ type: "toolResult", id: "read-1", status: "completed" })
		expect(JSON.stringify(result)).not.toContain("journal-only arguments")
		expect(JSON.stringify(result)).not.toContain("secret output")
	})

	it("does not attach inherited fork messages to a newer turn that reuses a tool call ID", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "New request", ts: 51 },
			{ role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read_file", input: {} }], ts: 52 },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "New result" }], ts: 53 },
		]
		const events = lifecycleTurn("new", 50, { status: "interrupted", at: 60 })
		events.splice(1, 0, {
			...events[0],
			eventId: "new:call",
			sequence: 2,
			occurredAt: 52,
			type: "tool_call_accepted",
			payload: {
				item: {
					type: "tool_call",
					itemId: "call-1",
					toolCallId: "read-1",
					name: "read_file",
					status: "accepted",
				},
			},
		})
		events[2].sequence = 3
		const result = read(history, { turnLimit: 10 }, events)
		expect(result.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed"])
		expect(result.turns[1]).toEqual(read().turns[0])
	})

	it("keeps terminal outcomes after trailing hidden reasoning and excludes unrelated journal identities", () => {
		const history: ApiMessage[] = [
			{ role: "user", input_origin: "human", content: "First request", ts: 1 },
			{ role: "assistant", content: "Working", agentResponseOutcome: { status: "cancelled" }, ts: 2 },
			{ role: "assistant", content: "", type: "reasoning", encrypted_content: "private", ts: 3 },
			{ role: "user", input_origin: "human", content: "Second request", ts: 4 },
			{ role: "assistant", content: "Done", phase: "final_answer", ts: 5 },
		]
		const unrelated = lifecycleTurn("other", 0, { status: "failed", at: 10 }).map((event) => ({
			...event,
			taskId: "other-thread",
		}))
		const result = read(history, { turnLimit: 10 }, unrelated)
		expect(result.turns.map((turn) => turn.status)).toEqual(["completed", "interrupted"])
		expect(JSON.stringify(result)).not.toContain("private")
	})

	it("keeps agent inbox deliveries in their owning turn and excludes hidden reasoning", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "agent", agent_message_id: "inbox-1", content: "Progress report", ts: 45 },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "private analysis", signature: "signature" }],
				ts: 46,
			},
		]
		const result = read(history)
		expect(result.turns).toHaveLength(1)
		expect(JSON.stringify(result)).toContain("Progress report")
		expect(JSON.stringify(result)).not.toContain("private analysis")
		expect(JSON.stringify(result)).not.toContain("signature")
	})

	it("preserves assistant phases and answers until the structured response budget is applied", () => {
		const answer = "Useful answer detail. ".repeat(220)
		const result = read([
			{ role: "user", content: "Explain this", ts: 1 },
			{ role: "assistant", content: answer, phase: "partial_answer", ts: 2 },
		])
		expect(result.turns[0].items).toContainEqual(
			expect.objectContaining({
				type: "agentMessage",
				text: answer,
				phase: "partial_answer",
			}),
		)
	})
})

describe("independent thread forks", () => {
	it("requires host completion receipts even when an unfinished turn repeats an earlier final answer", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "Continue working", ts: 50 },
			{ role: "assistant", content: "The repository is ready.", phase: "final_answer", ts: 60 },
			{ role: "user", input_origin: "agent", content: "Completion gate requires more work", ts: 70 },
		]
		const ui: AlphaMessage[] = [{ type: "say", say: "completion_result", text: "The repository is ready.", ts: 40 }]
		const snapshot = forkTaskHistory(history, ui, { active: true })
		expect(snapshot.apiMessages).toHaveLength(4)
		expect(JSON.stringify(snapshot)).not.toContain("Continue working")
	})

	it("matches completed Plan presentations without dropping their original provider text", () => {
		const history: ApiMessage[] = [
			{ role: "user", content: "Plan the work", ts: 1 },
			{ role: "assistant", content: "<proposed_plan>\nPlan detail\n</proposed_plan>", ts: 2 },
			{ role: "user", content: "Continue", ts: 3 },
		]
		const ui: AlphaMessage[] = [
			{ type: "say", say: "completion_result", text: "<proposed_plan>Plan detail</proposed_plan>", ts: 2 },
		]
		const snapshot = forkTaskHistory(history, ui, { active: true })
		expect(snapshot.apiMessages).toHaveLength(2)
		expect(snapshot.apiMessages[1].content).toBe(history[1].content)
	})

	it("excludes all unfinished steps even when steering and synthetic continuations add user messages", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "Start the next investigation", ts: 50 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "active-read", name: "read_file", input: {} }],
				ts: 60,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "active-read", content: "Read evidence" }],
				ts: 70,
			},
			{ role: "user", input_origin: "agent", content: "Continue the active investigation", ts: 80 },
			{ role: "user", input_origin: "human", content: "Also check the second file", ts: 90 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "fork-active", name: "fork_thread", input: {} }],
				ts: 100,
			},
		]
		const snapshot = forkTaskHistory(
			history,
			[{ type: "say", say: "completion_result", text: "The repository is ready.", ts: 40 }],
			{ active: true },
		)
		expect(snapshot.apiMessages).toHaveLength(4)
		expect(JSON.stringify(snapshot)).not.toContain("active-read")
		expect(JSON.stringify(snapshot)).not.toContain("active investigation")
	})
	it("copies completed history with provider metadata, excluding the entire live turn and source receipts", () => {
		const original: ApiMessage[] = [
			...completedHistory(),
			{ role: "user", input_origin: "human", content: "Fork this conversation", ts: 50 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "fork-1", name: "fork_thread", input: {} }],
				ts: 60,
			},
		]
		const ui: AlphaMessage[] = [
			{ type: "say", say: "completion_result", text: "The repository is ready.", ts: 39 },
			{ type: "say", say: "user_feedback", text: "Fork this conversation", ts: 49 },
		]
		const snapshot = forkTaskHistory(original, ui, { active: true })
		expect(snapshot.apiMessages).toHaveLength(4)
		expect(snapshot.apiMessages.at(-1)).toMatchObject({ encrypted_content: "opaque-provider-state" })
		expect(snapshot.apiMessages[0]).not.toHaveProperty("queued_message_ids")
		expect(snapshot.uiMessages).toEqual([ui[0]])
		expect(original[0].queued_message_ids).toEqual(["human-1"])
		expect(original).toHaveLength(6)
	})

	it("never persists an unresolved tool call in an inactive or interrupted source", () => {
		const history: ApiMessage[] = [
			...completedHistory(),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "unfinished", name: "write_file", input: {} }],
				ts: 50,
			},
		]
		const snapshot = forkTaskHistory(history, [], { active: false })
		expect(snapshot.apiMessages).toHaveLength(4)
		expect(JSON.stringify(snapshot)).not.toContain("unfinished")
	})

	it("does not invent inherited history for a first turn that is still running", () => {
		const snapshot = forkTaskHistory([{ role: "user", content: "First turn", ts: 1 }], [], { active: true })
		expect(snapshot).toEqual({ apiMessages: [], uiMessages: [] })
	})
})
