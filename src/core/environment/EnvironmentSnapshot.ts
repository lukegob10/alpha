/**
 * The model-facing environment is intentionally split into stable identity and
 * volatile workspace state. The rendered compatibility block remains separate
 * so providers can continue receiving the existing prompt shape.
 */
export interface EnvironmentStableSnapshot {
	workspaceRoot: string
	roots: string[]
	mode?: string
	modelId?: string
	capabilities: string[]
}

export interface EnvironmentVolatileSnapshot {
	/** Existing provider/history representation of the current environment. */
	renderedDetails: string
	/** Monotonic capture timestamp for diagnostics; not persisted as raw context. */
	capturedAt: number
}

export interface EnvironmentSnapshot {
	stable: EnvironmentStableSnapshot
	volatile: EnvironmentVolatileSnapshot
	renderedDetails: string
}
