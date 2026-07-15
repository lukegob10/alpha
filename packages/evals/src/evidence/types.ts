export const EVIDENCE_SCHEMA_VERSION = 1 as const
export const REDACTION_VERSION = "alpha-redaction-v1" as const

export type EvalEvent = {
	schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
	runId: string
	trialId: string
	attemptId: string
	sequence: number
	timestamp: string
	type: string
	payload: unknown
	payloadDigest: string
	redactionVersion: typeof REDACTION_VERSION
	late: boolean
}

export const REQUIRED_ARTIFACT_KINDS = [
	"final_diff",
	"git_status",
	"tree_digest",
	"transcript",
	"final_response",
	"test_output",
	"extension_log",
	"environment_manifest",
	"usage",
	"stop_reason",
] as const

export type RequiredArtifactKind = (typeof REQUIRED_ARTIFACT_KINDS)[number]
export type ArtifactKind = RequiredArtifactKind | "full_output" | "grader_evidence" | "other"
export type ArtifactAccess = "private" | "reviewer" | "public"
export type ArtifactUploadState = "complete" | "incomplete"

export type ArtifactDescriptor = {
	schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
	id: string
	attemptId: string
	kind: ArtifactKind
	digest: string
	mediaType: string
	sizeBytes: number
	access: ArtifactAccess
	retention: "campaign" | "baseline" | "permanent"
	uploadState: ArtifactUploadState
	createdAt: string
}

export type EvidenceBundle = {
	schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
	runId: string
	trialId: string
	attemptId: string
	taskIdentity: string
	variantIdentity: string
	events: EvalEvent[]
	artifacts: ArtifactDescriptor[]
}

export type IntegrityIssue = {
	code:
		| "event_sequence_gap"
		| "event_sequence_duplicate"
		| "event_payload_corrupt"
		| "late_event_forbidden"
		| "artifact_missing"
		| "artifact_incomplete"
		| "artifact_corrupt"
		| "identity_mismatch"
	detail: string
}

export type IntegrityResult = { valid: boolean; issues: IntegrityIssue[] }
