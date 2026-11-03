export type ExtensionBuildSourceAssociation = {
	readonly kind: "controlled-build-boundary-observation"
	readonly compilerLoaderBytes: "captured"
	readonly resolverMetadataBytes: "unobserved"
	readonly concurrentFilesystemWrites: "assumed-absent"
	readonly immutableFilesystem: false
	readonly authentication: "none"
}

export type ExtensionBuildProvenanceVerification = {
	status: "verified" | "unavailable" | "invalid"
	identityScope: "conservative-whole-source"
	provenance: "build-owned-content-association"
	sourceAssociation: ExtensionBuildSourceAssociation
	sourceTreeState: "clean" | "modified" | "unknown"
	/** Historical build cleanliness stays unknown for v2, even after a matching checkout verifies its source. */
	recordedSourceTreeState: "clean" | "modified" | "unknown"
	sourceValidation?: "current-checkout" | "build-receipt"
	missing: string[]
	manifestDigest?: string
	sourceRevision?: string
	sourceTreeDigest?: string
	artifactTreeDigest?: string
	entrypointSha256?: string
	packageJsonSha256?: string
}

export const extensionBuildProvenancePath: string
export const extensionBuildSourceAssociation: ExtensionBuildSourceAssociation
export function verifyExtensionBuildProvenance(input: {
	extensionPath: string
	expectedEntrypointSha256?: string
	expectedPackageJsonSha256?: string
	/** Reject modified builds; legacy receipts need an independently verified clean repositoryRoot. */
	requireCleanSource?: boolean
	/** Additionally compare the release checkout and captured compiler bytes with the build. */
	repositoryRoot?: string
}): Promise<ExtensionBuildProvenanceVerification>
export function assertExtensionBuildSource(input: { repositoryRoot: string; manifest: unknown }): Promise<void>
