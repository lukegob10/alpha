export type EvidenceCategory = "provider" | "tool" | "persistence" | "lifecycle" | "assertion" | "host" | "unknown"
export type EvidenceOutcome = "passed" | "failed" | "cancelled" | "blocked" | "timed_out"

/** Only deliberately public configuration belongs here, never a complete provider settings object. */
export interface RunEvidenceMetadata {
	scenarioId: string
	/** Null means the host failed before its actual version could be observed. Never substitute the requested version. */
	hostVersion: string | null
	requestedHostVersion?: string
	provider: string
	modelId?: string
	reasoningEffort?: string
	taskIds: string[]
	startedAt: string
	finishedAt: string
	outcome: EvidenceOutcome
}

export interface EvidenceFailure {
	phase: EvidenceCategory
	code?: string
}

export interface EvidenceSummary {
	category: EvidenceCategory | "none"
	code: string
}

export interface EvidenceLimits {
	maxFiles: number
	maxFileBytes: number
	/** Task/control source reads, independent from repository files and redacted artifact output. */
	maxTaskSourceBytes?: number
	/** Maximum raw bytes in one JSONL record; aggregate journals may be larger. */
	maxJournalLineBytes?: number
	maxTotalBytes: number
	maxTaskIds: number
	maxJournalEvents: number
}

export interface RepositoryEvidence {
	commit?: string
	files: Array<{ path: string; bytes: number; sha256: string }>
	complete: boolean
	skipped: number
}

export interface CaptureRunEvidenceOptions {
	artifactsRoot: string
	runId: string
	metadata: RunEvidenceMetadata
	bundlePath?: string
	workspacePath?: string
	storagePath?: string
	logsPath?: string
	/** Runner's marked test-profile/workspace validator. Required whenever source paths are supplied. */
	assertSourceOwned?: (sourcePath: string) => Promise<void>
	/** Capture this before the scenario; raw patches and commit messages are intentionally excluded. */
	repositoryBefore?: RepositoryEvidence
	failure?: EvidenceFailure
	limits?: Partial<EvidenceLimits>
}

export interface EvidenceManifest {
	kind: "alpha-vscode-e2e-run-evidence"
	version: 1
	runId: string
	finalized: true
	metadata: RunEvidenceMetadata
	summary: EvidenceSummary
	bundleSha256?: string
	captureComplete: boolean
	warnings: string[]
	artifacts: Array<{ path: string; bytes: number; sha256: string }>
	/** Local-only source references. The runner must retain them after a failure, not upload them. */
	retainedSources: Array<{ kind: "workspace" | "storage" | "logs"; path: string }>
	taskEvidence: Array<{ taskId: string; file: string; status: "captured" | "absent" | "incomplete" }>
}

export interface CaptureRunEvidenceResult {
	artifactDirectory: string
	manifestPath: string
	summary: EvidenceSummary
	captureComplete: boolean
}
