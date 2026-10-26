import { invalidPersistedApiMessages } from "../../../core/task-persistence/validatePersistedApiMessages"
import { ToolHistoryError } from "../../../utils/tool-id"
import { normalizeToolHistory } from "../tool-history"

type SavedMessage = { role: "assistant" | "user"; content: Record<string, unknown>[] }

const outcomes = ["success", "error", "denied", "cancelled"] as const

function parallelHistory(): SavedMessage[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "vscode_lm_thinking",
					value: ["Inspect the requested files."],
					id: "claude-thinking",
					metadata: { signature: "synthetic-claude-signature", opaque: { value: [1, 2] } },
					modelId: "claude-sonnet-4.5",
					modelVendor: "copilot",
				},
				...outcomes.map((status) => ({
					type: "tool_use",
					id: `toolu_${status}`,
					name: "exec_command",
					input: { cmd: `node inspect-${status}.cjs` },
				})),
			],
		},
		{
			role: "user",
			content: [
				{ type: "text", text: "Continue using the completed batch's results." },
				...outcomes.map((status) => ({
					type: "tool_result",
					tool_call_id: `toolu_${status}`,
					content: status === "success" ? "file contents" : `Error: ${status}`,
					is_error: status !== "success",
					status,
				})),
			],
		},
	]
}

describe("Claude Copilot parallel tool history after reload", () => {
	it("replays each mixed terminal outcome once without moving Claude's signed thinking", () => {
		const saved = JSON.parse(JSON.stringify(parallelHistory())) as SavedMessage[]
		expect(invalidPersistedApiMessages(saved)).toBeUndefined()
		const before = structuredClone(saved)
		const normalized = normalizeToolHistory(saved)

		expect(normalized[0]).toBe(saved[0])
		expect(normalized[0].content[0]).toBe(saved[0].content[0])
		expect(normalized[1].content).toEqual([
			...outcomes.map((status) => ({
				type: "tool_result",
				tool_use_id: `toolu_${status}`,
				content: status === "success" ? "file contents" : `Error: ${status}`,
				is_error: status !== "success",
				status,
			})),
			saved[1].content[0],
		])
		expect(normalizeToolHistory(normalized)).toEqual(normalized)
		expect(saved).toEqual(before)
	})

	it("keeps a cancelled occurrence separate from a successful retry with the same Claude call ID", () => {
		const saved = parallelHistory()
		saved.push(
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_cancelled",
						name: "exec_command",
						input: { cmd: "node inspect-cancelled.cjs" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_cancelled",
						content: "retried file contents",
						is_error: false,
						status: "success",
					},
				],
			},
		)
		const reloaded = JSON.parse(JSON.stringify(saved)) as SavedMessage[]
		expect(invalidPersistedApiMessages(reloaded)).toBeUndefined()
		const projected = normalizeToolHistory(reloaded)
		expect(projected[1].content[3]).toMatchObject({
			tool_use_id: "toolu_cancelled",
			status: "cancelled",
			is_error: true,
		})
		expect(projected[3].content).toEqual(saved[3].content)
		expect(normalizeToolHistory(projected)).toEqual(projected)
	})

	it("rejects a conflicting receipt for one parallel call without substituting another call's result", () => {
		const saved = parallelHistory()
		saved[1].content.push({
			type: "tool_result",
			tool_use_id: "toolu_denied",
			content: "success claimed after denial",
			is_error: false,
			status: "success",
		})
		const reloaded = JSON.parse(JSON.stringify(saved)) as SavedMessage[]
		const before = structuredClone(reloaded)
		expect(() => normalizeToolHistory(reloaded)).toThrow(new ToolHistoryError("conflicting_tool_results"))
		expect(reloaded).toEqual(before)
	})
})
