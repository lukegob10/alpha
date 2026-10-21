import { type CustomToolDefinition } from "@alpha-code/types"

export type StoredCustomTool = CustomToolDefinition & { source?: string }

export interface LoadResult {
	loaded: string[]
	failed: Array<{ file: string; error: string }>
}

/** An owned catalog for exactly the requested sources, safe to retain across later loads. */
export interface CatalogLoadResult extends LoadResult {
	catalog: readonly CustomToolDefinition[]
}
