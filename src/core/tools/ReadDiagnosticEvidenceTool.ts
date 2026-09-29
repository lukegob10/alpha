import type { NativeToolArgs } from "../../shared/tools"
import type { CollectedDiagnosticsEvidence, DiagnosticsSourceEvidence } from "../webview/diagnosticsEvidence"
import type { Task } from "../task/Task"
import { BaseTool, type ToolCallbacks } from "./BaseTool"

const MAX_RESULT_CHARS = 16 * 1_024
const MAX_EVENTS_PER_SOURCE = 8

function safeObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function sourceSummary(source: DiagnosticsSourceEvidence, includeEvents: boolean): Record<string, unknown> {
	const projection = safeObject(source.projection)
	return {
		status: source.status,
		...(source.sourceBytes !== undefined ? { sourceBytes: source.sourceBytes } : {}),
		...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}),
		...(source.warning ? { warning: source.warning } : {}),
		...(projection?.validationStatus ? { validationStatus: projection.validationStatus } : {}),
		...(includeEvents && Array.isArray(projection?.events)
			? { recentEvents: projection.events.slice(-MAX_EVENTS_PER_SOURCE) }
			: {}),
		...(includeEvents && source.status === "captured" && !Array.isArray(projection?.events) && projection
			? { snapshot: projection }
			: {}),
	}
}

/** Only existing redacted projections are returned; no source paths or provider content. */
export function formatDiagnosticEvidenceForTool(collected: CollectedDiagnosticsEvidence): string {
	const summarize = (includeEvents: boolean) =>
		JSON.stringify({
			status: collected.evidence.status,
			taskIdSha256: collected.evidence.taskIdSha256,
			rawProviderHistory: collected.evidence.rawProviderHistory,
			sources: Object.fromEntries(
				Object.entries(collected.evidence.sources).map(([name, source]) => [
					name,
					sourceSummary(source, includeEvents),
				]),
			),
			joins: { missing: collected.evidence.joins.missing.slice(0, 32) },
		})
	const detailed = summarize(true)
	if (detailed.length <= MAX_RESULT_CHARS) return detailed
	const compact = summarize(false)
	if (compact.length <= MAX_RESULT_CHARS) return compact
	return JSON.stringify({ status: collected.evidence.status, evidenceTruncated: true })
}

export class ReadDiagnosticEvidenceTool extends BaseTool<"read_diagnostic_evidence"> {
	readonly name = "read_diagnostic_evidence" as const

	async execute(
		_params: NativeToolArgs["read_diagnostic_evidence"],
		task: Task,
		callbacks: ToolCallbacks,
	): Promise<void> {
		try {
			const evidence = await task.readDiagnosticEvidence()
			callbacks.pushToolResult(formatDiagnosticEvidenceForTool(evidence))
		} catch {
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult("Diagnostic evidence is unavailable or this task lacks diagnostic authority.")
		}
	}
}

export const readDiagnosticEvidenceTool = new ReadDiagnosticEvidenceTool()
