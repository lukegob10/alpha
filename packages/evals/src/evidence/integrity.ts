import { canonicalJson, sha256 } from "./canonical"
import type { ContentAddressedArtifactStore } from "./artifactStore"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle, type IntegrityIssue, type IntegrityResult } from "./types"

export type IntegrityPolicy = { allowLateEventTypes?: string[]; requireAllArtifacts?: boolean }

export async function validateEvidenceBundle(
	bundle: EvidenceBundle,
	store: ContentAddressedArtifactStore,
	policy: IntegrityPolicy = {},
): Promise<IntegrityResult> {
	const issues: IntegrityIssue[] = []
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

	if (policy.requireAllArtifacts ?? true) {
		for (const kind of REQUIRED_ARTIFACT_KINDS) {
			if (!bundle.artifacts.some((artifact) => artifact.kind === kind)) {
				issues.push({ code: "artifact_missing", detail: `required artifact ${kind}` })
			}
		}
	}
	for (const artifact of bundle.artifacts) {
		if (artifact.attemptId !== bundle.attemptId) {
			issues.push({ code: "identity_mismatch", detail: `artifact ${artifact.id} attempt differs from bundle` })
		}
		if (artifact.uploadState !== "complete") {
			issues.push({ code: "artifact_incomplete", detail: `artifact ${artifact.id} upload is incomplete` })
			continue
		}
		const bytes = await store.get(artifact)
		if (!bytes) issues.push({ code: "artifact_missing", detail: `artifact ${artifact.id} bytes unavailable` })
		else if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.digest) {
			issues.push({
				code: "artifact_corrupt",
				detail: `artifact ${artifact.id} failed digest or size verification`,
			})
		}
	}
	return { valid: issues.length === 0, issues }
}
