export const fixtureDigestContract: "canonical-file-tree-v1"
export function canonicalFixtureBytes(bytes: Buffer): Buffer
export function fixtureTreeDigest(files: Array<{ path: string; bytes: Buffer }>): string
