import type { ContentAddressedArtifactStore } from "./artifactStore"
import { redact, type RedactionOptions } from "./redaction"
import { EVIDENCE_SCHEMA_VERSION, type ArtifactDescriptor, type RequiredArtifactKind } from "./types"

export type RequiredEvidence = Record<RequiredArtifactKind, string | Uint8Array | object>

export async function collectRequiredEvidence(
	attemptId: string,
	evidence: RequiredEvidence,
	store: ContentAddressedArtifactStore,
	redaction: RedactionOptions = {},
): Promise<ArtifactDescriptor[]> {
	const descriptors: ArtifactDescriptor[] = []
	for (const [kind, value] of Object.entries(evidence) as [
		RequiredArtifactKind,
		RequiredEvidence[RequiredArtifactKind],
	][]) {
		const normalized = redact(value, redaction)
		const bytes =
			normalized instanceof Uint8Array
				? normalized
				: new TextEncoder().encode(typeof normalized === "string" ? normalized : JSON.stringify(normalized))
		descriptors.push(
			await store.put({
				attemptId,
				kind,
				bytes,
				mediaType: typeof normalized === "object" ? "application/json" : "text/plain; charset=utf-8",
				access: "reviewer",
			}),
		)
	}
	return descriptors.map((descriptor) => ({ ...descriptor, schemaVersion: EVIDENCE_SCHEMA_VERSION }))
}

export async function preserveLargeOutput(
	attemptId: string,
	output: string,
	store: ContentAddressedArtifactStore,
	maxPreviewBytes: number,
	redaction: RedactionOptions = {},
): Promise<{ preview: string; truncated: boolean; artifact?: ArtifactDescriptor }> {
	const safe = String(redact(output, redaction))
	const bytes = new TextEncoder().encode(safe)
	if (bytes.byteLength <= maxPreviewBytes) return { preview: safe, truncated: false }
	const artifact = await store.put({
		attemptId,
		kind: "full_output",
		bytes,
		mediaType: "text/plain; charset=utf-8",
		access: "private",
	})
	return { preview: new TextDecoder().decode(bytes.slice(0, maxPreviewBytes)), truncated: true, artifact }
}
