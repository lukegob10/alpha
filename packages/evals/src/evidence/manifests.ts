import { z } from "zod"

import { canonicalJson, sha256 } from "./canonical"

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export const taskManifestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	version: z.number().int().positive(),
	fixtureDigest: digest,
	capabilities: z.array(z.string().min(1)).min(1),
	risk: z.enum(["low", "medium", "high", "critical"]),
	network: z.enum(["disabled", "restricted", "enabled"]),
	graders: z.array(z.object({ id: z.string().min(1), version: z.number().int().positive() })).min(1),
})

export const variantManifestSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	extensionCommit: z.string().min(1),
	workingTreeDigest: digest,
	model: z.string().min(1),
	promptDigest: digest,
	toolSchemaDigest: digest,
	runnerImageDigest: digest,
})

export type TaskManifest = z.infer<typeof taskManifestSchema>
export type VariantManifest = z.infer<typeof variantManifestSchema>

export function manifestIdentity(manifest: TaskManifest | VariantManifest): string {
	return `${manifest.id}@${"version" in manifest ? manifest.version : 1}:${sha256(canonicalJson(manifest))}`
}
