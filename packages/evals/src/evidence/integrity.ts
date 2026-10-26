import { canonicalJson, sha256 } from "./canonical"
import type { ContentAddressedArtifactStore } from "./artifactStore"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle, type IntegrityIssue, type IntegrityResult } from "./types"
import { parseWorkspaceSnapshot, workspaceSnapshotTreeDigest } from "./workspaceSnapshot"

export type IntegrityPolicy = {
	allowLateEventTypes?: string[]
	requireAllArtifacts?: boolean
	allowUnavailableArtifacts?: string[]
	requireWorkspaceSnapshot?: boolean
	allowLegacyEmptyCaptures?: boolean
}

/** The sealed content identity excludes only reader annotations and the digest itself. */
export function evidenceBundleDigest(bundle: EvidenceBundle): string {
	const { bundleDigest: _digest, identityStatus: _status, ...content } = bundle
	return sha256(canonicalJson(content))
}

export async function validateEvidenceBundle(
	bundle: EvidenceBundle,
	store: ContentAddressedArtifactStore,
	policy: IntegrityPolicy = {},
): Promise<IntegrityResult> {
	const issues: IntegrityIssue[] = []
	if (
		policy.requireWorkspaceSnapshot &&
		bundle.artifacts.filter(({ kind }) => kind === "workspace_snapshot").length !== 1
	)
		issues.push({ code: "artifact_missing", detail: "one complete workspace snapshot is required" })
	if (bundle.bundleDigest && bundle.bundleDigest !== evidenceBundleDigest(bundle))
		issues.push({ code: "bundle_digest_mismatch", detail: "sealed bundle content changed" })
	const seen = new Set<number>()
	if (bundle.events.length === 0)
		issues.push({ code: "event_sequence_gap", detail: "no normalized events were retained" })
	for (const [index, event] of [...bundle.events].sort((left, right) => left.sequence - right.sequence).entries()) {
		if (seen.has(event.sequence))
			issues.push({ code: "event_sequence_duplicate", detail: `duplicate ${event.sequence}` })
		seen.add(event.sequence)
		if (event.sequence !== index + 1)
			issues.push({ code: "event_sequence_gap", detail: `expected ${index + 1}, got ${event.sequence}` })
		if (event.runId !== bundle.runId || event.trialId !== bundle.trialId || event.attemptId !== bundle.attemptId) {
			issues.push({ code: "identity_mismatch", detail: `event ${event.sequence} identity differs from bundle` })
		}
		if (sha256(canonicalJson(event.payload)) !== event.payloadDigest) {
			issues.push({ code: "event_payload_corrupt", detail: `event ${event.sequence} payload digest mismatch` })
		}
		if (event.late && !policy.allowLateEventTypes?.includes(event.type)) {
			issues.push({ code: "late_event_forbidden", detail: `late ${event.type} event` })
		}
	}

	for (const kind of REQUIRED_ARTIFACT_KINDS) {
		const count = bundle.artifacts.filter((artifact) => artifact.kind === kind).length
		if (count === 0 && (policy.requireAllArtifacts ?? true))
			issues.push({ code: "artifact_missing", detail: `required artifact ${kind}` })
		if (count > 1) issues.push({ code: "artifact_duplicate", detail: `multiple required artifacts ${kind}` })
	}
	for (const artifact of bundle.artifacts) {
		if (artifact.attemptId !== bundle.attemptId) {
			issues.push({ code: "identity_mismatch", detail: `artifact ${artifact.id} attempt differs from bundle` })
		}
		if (artifact.uploadState !== "complete") {
			issues.push({ code: "artifact_incomplete", detail: `artifact ${artifact.id} upload is incomplete` })
			continue
		}
		if (
			["missing", "failed", "unavailable"].includes(artifact.captureStatus ?? "") &&
			!(artifact.captureStatus === "unavailable" && policy.allowUnavailableArtifacts?.includes(artifact.kind))
		)
			issues.push({ code: "artifact_capture_incomplete", detail: `artifact ${artifact.id} was not captured` })
		const bytes = await store.get(artifact)
		if (!bytes) issues.push({ code: "artifact_missing", detail: `artifact ${artifact.id} bytes unavailable` })
		else if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.digest) {
			issues.push({
				code: "artifact_corrupt",
				detail: `artifact ${artifact.id} failed digest or size verification`,
			})
		} else if (
			bytes.byteLength === 0 &&
			REQUIRED_ARTIFACT_KINDS.some((kind) => kind === artifact.kind) &&
			!(
				policy.allowLegacyEmptyCaptures &&
				bundle.identityStatus === "legacy-unavailable" &&
				artifact.captureStatus === undefined
			) &&
			!["final_diff", "git_status", "test_output"].includes(artifact.kind) &&
			!(artifact.captureStatus === "unavailable" && policy.allowUnavailableArtifacts?.includes(artifact.kind))
		)
			issues.push({ code: "artifact_capture_incomplete", detail: `required evidence ${artifact.kind} is empty` })
		if (
			bytes &&
			((artifact.captureStatus === "captured-empty" && bytes.length !== 0) ||
				(artifact.captureStatus === "captured" && bytes.length === 0))
		)
			issues.push({
				code: "artifact_capture_incomplete",
				detail: `artifact ${artifact.id} capture status disagrees with bytes`,
			})
		if (bytes && artifact.kind === "workspace_snapshot") {
			try {
				const snapshot = parseWorkspaceSnapshot(JSON.parse(new TextDecoder().decode(bytes)))
				const tree = bundle.artifacts.find(({ kind }) => kind === "tree_digest")
				const capturedTree = tree ? await store.get(tree) : undefined
				if (!capturedTree || new TextDecoder().decode(capturedTree) !== workspaceSnapshotTreeDigest(snapshot))
					throw new Error("Workspace tree identity mismatch")
			} catch {
				issues.push({ code: "artifact_corrupt", detail: "workspace snapshot identity or schema is invalid" })
			}
		}
	}
	return { valid: issues.length === 0, issues }
}
