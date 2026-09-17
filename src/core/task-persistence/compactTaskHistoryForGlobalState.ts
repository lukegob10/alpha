import type { HistoryItem } from "@alpha-code/types"

/**
 * The file-backed TaskHistoryStore is authoritative. This mirror exists only so
 * an older extension can still show a useful recent-task list after downgrade;
 * it must never grow into a second copy of every managed child record.
 */
export const TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES = 192 * 1024

const MAX_COMPATIBILITY_ITEMS = 200
const MAX_TASK_TEXT_CHARS = 16_000
const MAX_COMPLETION_SUMMARY_CHARS = 4_000

const truncate = (value: string | undefined, maxChars: number): string | undefined => {
	if (!value || value.length <= maxChars) return value
	return `${value.slice(0, maxChars - 1)}…`
}

const toCompatibilityItem = (item: HistoryItem): HistoryItem => ({
	id: item.id,
	rootTaskId: item.rootTaskId,
	number: item.number,
	ts: item.ts,
	task: truncate(item.task, MAX_TASK_TEXT_CHARS) ?? "",
	tokensIn: item.tokensIn,
	tokensOut: item.tokensOut,
	cacheWrites: item.cacheWrites,
	cacheReads: item.cacheReads,
	totalCost: item.totalCost,
	size: item.size,
	workspace: item.workspace,
	mode: item.mode,
	apiConfigName: item.apiConfigName,
	status: item.status,
	completionResultSummary: truncate(item.completionResultSummary, MAX_COMPLETION_SUMMARY_CHARS),
	taskKind: item.taskKind === "subagent" ? undefined : item.taskKind,
})

/**
 * Build a recent, root-only downgrade mirror within a hard serialized byte
 * budget. Managed child details remain exclusively in the authoritative files.
 */
export function compactTaskHistoryForGlobalState(
	items: readonly HistoryItem[],
	budgetBytes = TASK_HISTORY_GLOBAL_STATE_BUDGET_BYTES,
): HistoryItem[] {
	if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 2) {
		throw new Error("Task-history compatibility budget must be an integer of at least 2 bytes")
	}

	const recentRoots = items
		.filter((item) => item.taskKind !== "subagent" && !item.parentTaskId)
		.sort((left, right) => right.ts - left.ts)
		.slice(0, MAX_COMPATIBILITY_ITEMS)

	const compact: HistoryItem[] = []
	let serializedBytes = 2 // JSON array brackets.
	for (const item of recentRoots) {
		const candidate = toCompatibilityItem(item)
		const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8") + (compact.length > 0 ? 1 : 0)
		if (serializedBytes + candidateBytes > budgetBytes) continue
		compact.push(candidate)
		serializedBytes += candidateBytes
	}

	return compact
}
