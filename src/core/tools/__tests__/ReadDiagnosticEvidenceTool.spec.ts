import type { CollectedDiagnosticsEvidence } from "../../webview/diagnosticsEvidence"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { formatDiagnosticEvidenceForTool, readDiagnosticEvidenceTool } from "../ReadDiagnosticEvidenceTool"

const evidence = (events: unknown[] = []): CollectedDiagnosticsEvidence => ({
	history: [{ prompt: "PRIVATE PROMPT" }],
	historyParseFailed: false,
	evidence: {
		status: "captured",
		taskIdSha256: "task-hash",
		rawProviderHistory: { included: false, reason: "omitted_by_default" },
		sources: {
			lifecycle: {
				status: "captured",
				sourceBytes: 120,
				sourceSha256: "source-hash",
				projection: { validationStatus: "validated", events },
			},
		},
		joins: { records: [{ private: "PRIVATE JOIN" }], missing: [] },
	},
})

describe("read_diagnostic_evidence", () => {
	it("returns a bounded redacted projection without conversation history or joins", () => {
		const result = formatDiagnosticEvidenceForTool(
			evidence(Array.from({ length: 100 }, (_, index) => ({ type: "turn_terminal", sequence: index + 1 }))),
		)
		expect(result).not.toContain("PRIVATE PROMPT")
		expect(result).not.toContain("PRIVATE JOIN")
		expect(JSON.parse(result).sources.lifecycle.recentEvents).toHaveLength(8)
		expect(result.length).toBeLessThanOrEqual(16 * 1_024)
	})

	it("keeps the bounded fallback parseable when source summaries are oversized", () => {
		const collected = evidence()
		collected.evidence.joins.missing = Array.from({ length: 32 }, () => "x".repeat(1_024))
		const result = formatDiagnosticEvidenceForTool(collected)
		expect(JSON.parse(result)).toEqual({ status: "captured", evidenceTruncated: true })
		expect(result.length).toBeLessThanOrEqual(16 * 1_024)
	})

	it("uses the task's scoped reader and returns a terminal error when authority is absent", async () => {
		const pushToolResult = vi.fn()
		const setResultMetadata = vi.fn()
		const callbacks = { pushToolResult, setResultMetadata } as unknown as ToolCallbacks
		const task = { readDiagnosticEvidence: vi.fn().mockResolvedValue(evidence()) } as unknown as Task
		await readDiagnosticEvidenceTool.execute({}, task, callbacks)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"taskIdSha256":"task-hash"'))
		const denied = {
			readDiagnosticEvidence: vi.fn().mockRejectedValue(new Error("private source path")),
		} as unknown as Task
		await readDiagnosticEvidenceTool.execute({}, denied, callbacks)
		expect(setResultMetadata).toHaveBeenLastCalledWith({ status: "error" })
		expect(pushToolResult).toHaveBeenLastCalledWith(
			"Diagnostic evidence is unavailable or this task lacks diagnostic authority.",
		)
		expect(pushToolResult.mock.calls.at(-1)?.[0]).not.toContain("private source path")
	})
})
