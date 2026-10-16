import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { WorkflowFailure } from "./contracts"

/** Publish immutable workflow evidence only after complete JSON is written and flushed. */
export async function writeNewWorkflowArtifact(filePath: string, value: unknown): Promise<void> {
	if (!path.isAbsolute(filePath)) throw new WorkflowFailure("configuration", "artifact_path_not_absolute", true)
	const parent = path.dirname(filePath)
	// Refuse symlink/reparse-directory destinations and never overwrite another run.
	let current = path.parse(parent).root
	for (const segment of path.relative(current, parent).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment)
		await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error
		})
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new WorkflowFailure("configuration", "unsafe_artifact_parent", true)
	}
	const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
	try {
		const handle = await fs.open(temporary, "wx", 0o600)
		try {
			await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}
		// A crash during serialization cannot leave an empty canonical receipt. A colliding run still fails closed.
		await fs.link(temporary, filePath)
	} finally {
		await fs.unlink(temporary).catch(() => undefined)
	}
}
