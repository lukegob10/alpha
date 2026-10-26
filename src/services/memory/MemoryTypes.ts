import type { ApiMessage } from "../../core/task-persistence/apiMessages"

/** Memory semantics reference: openai/codex@970111f6cb62cc02fe36a82ea7d71b37a2889c97 (2026-10-25). */
export interface MemorySource {
	id: string
	updatedAt: number
	workspace?: string
	generateMemories: boolean
	active: boolean
	externalContext?: boolean
}

export type MemoryPhase = "extraction" | "consolidation"

export interface MemoryRequestUsage {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalCost: number
}

export type ObserveMemoryUsage = (phase: MemoryPhase, usage: MemoryRequestUsage) => Promise<void>

export interface ExtractedMemory {
	rolloutSummary: string
	rolloutSlug: string
}

export interface MemoryConsolidationInput {
	previousSummary?: string
	rollouts: Array<{ id: string; updatedAt: number; path: string; text: string }>
	notes: Array<{ path: string; text: string }>
}

/** A bounded transformation through existing provider adapters; it has no tool or workspace authority. */
export interface MemoryModelClient {
	extract(
		source: MemorySource,
		messages: ApiMessage[],
		signal: AbortSignal,
		observeUsage?: ObserveMemoryUsage,
	): Promise<ExtractedMemory>
	consolidate(
		input: MemoryConsolidationInput,
		signal: AbortSignal,
		observeUsage?: ObserveMemoryUsage,
	): Promise<string>
}
