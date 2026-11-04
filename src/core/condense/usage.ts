import type { ApiStreamUsageChunk } from "../../api/transform/stream"

export type CompactionUsageObserver = (
	usage: ApiStreamUsageChunk,
	attemptId: string,
	inputIncludesCache: boolean,
) => Promise<void>

/** Canonical stream counters are deltas; the optional total cost is cumulative within one request. */
export function aggregateCompactionUsage(
	previous: ApiStreamUsageChunk | undefined,
	delta: ApiStreamUsageChunk,
): ApiStreamUsageChunk {
	const sum = (before: number | undefined, increment: number | undefined): number => {
		for (const value of [before, increment]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
				throw new Error("Invalid provider compaction usage counter")
			}
		}
		const result = (before ?? 0) + (increment ?? 0)
		if (!Number.isSafeInteger(result)) throw new Error("Provider compaction usage exceeds the counter range")
		return result
	}
	const optional = (key: "cacheWriteTokens" | "cacheReadTokens" | "reasoningTokens") =>
		previous?.[key] === undefined && delta[key] === undefined ? undefined : sum(previous?.[key], delta[key])
	return {
		type: "usage",
		usageSource: delta.usageSource ?? previous?.usageSource,
		inputTokens: sum(previous?.inputTokens, delta.inputTokens),
		outputTokens: sum(previous?.outputTokens, delta.outputTokens),
		cacheWriteTokens: optional("cacheWriteTokens"),
		cacheReadTokens: optional("cacheReadTokens"),
		reasoningTokens: optional("reasoningTokens"),
		totalCost:
			typeof delta.totalCost === "number" && Number.isFinite(delta.totalCost) && delta.totalCost >= 0
				? delta.totalCost
				: previous?.totalCost,
	}
}
