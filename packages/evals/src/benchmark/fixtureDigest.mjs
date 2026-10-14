import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

export const fixtureDigestContract = "canonical-file-tree-v1"
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

/** Normalize only valid UTF-8 text. Binary bytes and bare CR remain byte-exact. */
export function canonicalFixtureBytes(bytes) {
	if (bytes.some((byte) => byte < 9 || byte === 11 || byte === 12 || (byte >= 14 && byte < 32))) return bytes
	const text = bytes.toString("utf8")
	if (!Buffer.from(text, "utf8").equals(bytes)) return bytes
	return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")
}

export function fixtureTreeDigest(files) {
	const rows = files.map(({ path, bytes }) => [path.replaceAll("\\", "/"), sha(canonicalFixtureBytes(bytes))])
	rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	if (new Set(rows.map(([path]) => path)).size !== rows.length) throw new Error("Duplicate fixture digest path")
	return sha(JSON.stringify(rows))
}
