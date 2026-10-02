import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { require as tsRequire } from "tsx/cjs/api"

const { sourceDigest } = tsRequire("../../apps/vscode-e2e/src/campaign/evaluationIdentity.ts", import.meta.url)

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const git = (root, args) => {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 32 * 1024 * 1024,
	})
	if (result.error || result.status !== 0) throw new Error("Source provenance unavailable")
	return result.stdout
}

/** Reuse the host campaign's conservative source-content owner; unreadable or linked inputs fail closed. */
export async function collectSource(root) {
	const commit = git(root, ["rev-parse", "HEAD"]).trim()
	const dirty = git(root, ["status", "--porcelain"]).length > 0
	const files = [
		...new Set(git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean)),
	].sort()
	return {
		commit,
		dirty,
		treeSha256: await sourceDigest(root, ["."]),
		lockfileSha256: digest(await readFile(path.join(root, "pnpm-lock.yaml"))),
		fileCount: files.length,
	}
}

export function comparableSource(first, second) {
	return ["commit", "dirty", "treeSha256", "lockfileSha256"].every(
		(key) => first?.[key] !== undefined && first[key] === second?.[key],
	)
}
