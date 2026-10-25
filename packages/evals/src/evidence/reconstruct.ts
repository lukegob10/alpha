import fs from "node:fs/promises"
import path from "node:path"

import type { ContentAddressedArtifactStore } from "./artifactStore"
import { canonicalJson } from "./canonical"
import { validateEvidenceBundle } from "./integrity"
import type { EvidenceBundle } from "./types"
import { restoreWorkspaceSnapshot } from "./workspaceSnapshot"

export async function reconstructEvidenceBundle(
	bundle: EvidenceBundle,
	store: ContentAddressedArtifactStore,
	destination: string,
): Promise<void> {
	const integrity = await validateEvidenceBundle(bundle, store, {
		allowLegacyEmptyCaptures: bundle.identityStatus === "legacy-unavailable",
	})
	if (!integrity.valid)
		throw new Error(`Evidence integrity failed: ${integrity.issues.map(({ code }) => code).join(", ")}`)
	await fs.mkdir(path.join(destination, "artifacts"), { recursive: true })
	for (const artifact of [...bundle.artifacts].sort((left, right) => left.kind.localeCompare(right.kind))) {
		const bytes = await store.get(artifact)
		if (!bytes) throw new Error(`Artifact ${artifact.id} disappeared after validation`)
		if (!/^[a-z_]+$/.test(artifact.kind) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest))
			throw new Error("Invalid reconstructed artifact identity")
		await fs.writeFile(path.join(destination, "artifacts", `${artifact.kind}-${artifact.digest.slice(-12)}`), bytes)
		if (artifact.kind === "workspace_snapshot")
			await restoreWorkspaceSnapshot(
				JSON.parse(new TextDecoder().decode(bytes)),
				path.join(destination, "workspace"),
			)
	}
	await fs.writeFile(path.join(destination, "manifest.json"), `${canonicalJson(bundle)}\n`)
}
