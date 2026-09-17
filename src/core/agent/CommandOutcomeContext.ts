import type { CommandExecutionEvidence } from "../task/Task"

const MAX_OUTCOMES = 8
const MAX_IDENTIFIER_LENGTH = 256
const MAX_CONTEXT_BYTES = 8_192
const CONTEXT_HEADER =
	"Observed background command outcomes (null exit code means unavailable). Success describes that execution, not later edits or overall task completion."

/** Project existing process evidence, without retaining output or inferring workspace verification. */
export function formatBackgroundCommandContext(evidence: Iterable<CommandExecutionEvidence>): string | undefined {
	const recent: CommandExecutionEvidence[] = []
	let total = 0
	for (const item of evidence) {
		if (!item.returnedInBackground) continue
		total++
		// Never truncate an identity into a potentially different tool call or execution.
		if (item.toolCallId.length > MAX_IDENTIFIER_LENGTH || item.executionId.length > MAX_IDENTIFIER_LENGTH) continue
		recent.push(item)
		// A long-running command's completion must become visible even when newer
		// invocations have already pushed its start outside the context window.
		recent.sort((left, right) => (left.completedAt ?? left.startedAt) - (right.completedAt ?? right.startedAt))
		if (recent.length > MAX_OUTCOMES) recent.shift()
	}
	if (total === 0) return undefined

	const rows = recent.map((item) =>
		JSON.stringify({
			tool_call_id: item.toolCallId,
			execution_id: item.executionId,
			status: item.status,
			exit_code: item.exitCode ?? null,
			...(item.signalName ? { signal: item.signalName.slice(0, 64) } : {}),
		}),
	)
	// Escaped identifiers can be several times larger than their source strings.
	// Omit whole older rows instead of letting environment truncation cut an outcome.
	let rowBytes = rows.reduce((total, row) => total + Buffer.byteLength(row, "utf8") + 1, 0)
	const rowBudget = MAX_CONTEXT_BYTES - Buffer.byteLength(CONTEXT_HEADER, "utf8") - 128
	while (rowBytes > rowBudget) rowBytes -= Buffer.byteLength(rows.shift()!, "utf8") + 1
	return [
		CONTEXT_HEADER,
		...rows,
		...(total > rows.length ? [`${total - rows.length} additional outcomes omitted by the context limit.`] : []),
	].join("\n")
}
