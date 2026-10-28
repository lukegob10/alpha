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
}): Promise<ExtensionBuildProvenanceVerification>
