import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { executionIdentitySchema, type ExecutionIdentity } from "@alpha-code/types"

/** Observed installed entrypoint identity, explicitly narrower than all loaded runtime bytes. */
export async function readExecutionIdentity(extensionPath: string, hostVersion: string): Promise<ExecutionIdentity> {
	const root = await fs.realpath(extensionPath)
	const manifestFile = await fs.open(path.join(root, "package.json"), "r")
	let manifest: Buffer
	try {
		const stat = await manifestFile.stat()
		if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) throw new Error("Invalid extension manifest")
		manifest = Buffer.alloc(stat.size + 1)
		const { bytesRead } = await manifestFile.read(manifest, 0, manifest.length, 0)
		if (bytesRead !== stat.size) throw new Error("Extension manifest changed during capture")
		manifest = manifest.subarray(0, bytesRead)
	} finally {
		await manifestFile.close()
	}
	const metadata = JSON.parse(manifest.toString("utf8")) as {
		main?: unknown
		publisher?: unknown
		name?: unknown
		version?: unknown
	}
	if (
		typeof metadata.main !== "string" ||
		typeof metadata.publisher !== "string" ||
		!metadata.publisher ||
		typeof metadata.name !== "string" ||
		!metadata.name
	)
		throw new Error("Extension metadata unavailable")
	const entrypoint = await fs.realpath(path.resolve(root, metadata.main))
	if (!entrypoint.startsWith(root + path.sep)) throw new Error("Extension entrypoint is outside its installation")
	const file = await fs.open(entrypoint, "r")
	try {
		const before = await file.stat()
		if (!before.isFile() || before.size <= 0 || before.size > 128 * 1024 * 1024)
			throw new Error("Invalid extension entrypoint")
		const hash = createHash("sha256")
		for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes)
		const after = await file.stat()
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
			throw new Error("Extension entrypoint changed during capture")
		return executionIdentitySchema.parse({
			schemaVersion: 1,
			hostVersion,
			extensionId: `${metadata.publisher}.${metadata.name}`,
			extensionVersion: metadata.version,
			entrypointDigest: `sha256:${hash.digest("hex")}`,
			manifestDigest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
			identityScope: "observed-entrypoint-and-manifest",
		})
	} finally {
		await file.close()
	}
}
