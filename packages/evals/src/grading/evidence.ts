import crypto from "crypto"

import type { GraderEvidence } from "./types"

export function evidenceFromText(
	id: string,
	kind: GraderEvidence["kind"],
	value: string,
	mediaType = "text/plain",
	metadata?: Record<string, unknown>,
): GraderEvidence {
	const bytes = Buffer.from(value)
	return {
		id,
		kind,
		mediaType,
		digest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
		byteLength: bytes.byteLength,
		metadata,
	}
}
