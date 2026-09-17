import fs from "node:fs/promises"
import path from "node:path"

import type { ContentAddressedArtifactStore } from "./artifactStore"
import { canonicalJson } from "./canonical"
import { validateEvidenceBundle } from "./integrity"
import type { EvidenceBundle } from "./types"

export async function reconstructEvidenceBundle(
	bundle: EvidenceBundle,
	store: ContentAddressedArtifactStore,
	destination: string,
): Promise<void> {
	const integrity = await validateEvidenceBundle(bundle, store)
	if (!integrity.valid)
		throw new Error(`Evidence integrity failed: ${integrity.issues.map(({ code }) => code).join(", ")}`)
	await fs.mkdir(path.join(destination, "artifacts"), { recursive: true })
	for (const artifact of [...bundle.artifacts].sort((left, right) => left.kind.localeCompare(right.kind))) {
		const bytes = await store.get(artifact)
		if (!bytes) throw new Error(`Artifact ${artifact.id} disappeared after validation`)
		await fs.writeFile(path.join(destination, "artifacts", `${artifact.kind}-${artifact.digest.slice(-12)}`), bytes)
	}
	await fs.writeFile(path.join(destination, "manifest.json"), `${canonicalJson(bundle)}\n`)
}
