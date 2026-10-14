import type { AlphaMessage } from "@alpha-code/types"

import { safeJsonParse } from "@alpha/core"

/** Older records lack per-message identity. Never guess from a mixed or incomplete child list. */
export function resolveLegacyChildLink(
	message: AlphaMessage,
	messages: readonly AlphaMessage[],
	history: { childIds?: string[]; completedByChildId?: string } | undefined,
): string | undefined {
	if (message.childTaskId || message.subtaskResultChildId) return message.childTaskId ?? message.subtaskResultChildId
	const launches = messages.filter(
		(item) => item.ask === "tool" && safeJsonParse<{ tool?: string }>(item.text)?.tool === "newTask",
	)
	const hasManagedChildren = messages.some(
		(item) =>
			item.subagentGroup ||
			(item.ask === "tool" &&
				["spawnAgent", "delegateTask"].includes(safeJsonParse<{ tool?: string }>(item.text)?.tool ?? "")),
	)
	if (hasManagedChildren || launches.length !== 1 || history?.childIds?.length !== 1) return undefined
	if (message.ask === "tool") return history.childIds[0]
	const results = messages.filter((item) => item.say === "subtask_result")
	return results.length === 1 && history.completedByChildId === history.childIds[0]
		? history.completedByChildId
		: undefined
}
