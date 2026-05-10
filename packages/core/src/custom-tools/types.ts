import { type CustomToolDefinition } from "@alpha-code/types"

export type StoredCustomTool = CustomToolDefinition & { source?: string }

export interface LoadResult {
	loaded: string[]
	failed: Array<{ file: string; error: string }>
}
