import { describe, expect, it } from "vitest"
import type { AlphaMessage } from "@alpha-code/types"

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

function read(apiMessages = completedHistory(), options = {}) {
	return buildThreadReadResult({
		taskId: "peer-1",
		title: "Peer thread",
		objective: "Inspect the repository",
		workspacePath: "/repo",
		updatedAt: 100,
		status: { type: "idle" },
		apiMessages,
		options,
	})
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
