import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

/** A build can replace binaries still used by a host. Keep these existing runners mutually exclusive. */
export async function acquireBuildLease(root, lane) {
	const directory = path.join(root, "artifacts", "harness", ".build-host-lock")
	await mkdir(path.dirname(directory), { recursive: true })
	try {
		await mkdir(directory)
	} catch (error) {
		if (error.code === "EEXIST")
			throw new Error(
				"Another build/host lane owns artifacts/harness/.build-host-lock. Inspect owner.json; do not rebuild while its host is running.",
			)
		throw error
	}
	const marker = path.join(directory, "owner.json")
	const receipt = JSON.stringify({ token: randomUUID(), pid: process.pid, lane, startedAt: new Date().toISOString() })
	await writeFile(marker, receipt, { flag: "wx", mode: 0o600 })
	return async () => {
		if ((await readFile(marker, "utf8")) !== receipt)
			throw new Error("Build/host lease ownership changed; preserving evidence")
		await unlink(marker)
		await rmdir(directory)
	}
}
