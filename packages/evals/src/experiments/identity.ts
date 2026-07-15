import { canonicalJson, sha256 } from "../evidence/index"

export function immutableIdentity<T extends { id: string; schemaVersion: number; version?: number }>(
	manifest: T,
): string {
	return `${manifest.id}@${manifest.version ?? manifest.schemaVersion}:${sha256(canonicalJson(manifest))}`
}
