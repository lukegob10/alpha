import type { EmbedderProvider } from "@alpha-code/types"

export type IndexingState = "Standby" | "Indexing" | "Indexed" | "Error" | "Stopping"
export type { EmbedderProvider }

export interface IndexProgressUpdate {
	systemStatus: IndexingState
	message?: string
	processedBlockCount?: number
	totalBlockCount?: number
}
